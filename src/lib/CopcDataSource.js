import * as Cesium from 'cesium';
import { Copc } from 'copc';
import proj4 from 'proj4';
import {
  getDepth, getChildKeys, screenSpaceError,
  getNodeBoundingSphere, getCullingVolume, isInFrustum,
} from './lod.js';
import { loadNode } from './loader.js';
import { WorkerPool } from './WorkerPool.js';

/**
 * CopcDataSource
 *
 * COPC(.copc.laz) 파일을 CesiumJS Viewer에 스트리밍 방식으로 가시화하는 클래스.
 * LoD(Level of Detail) + 프러스텀 컬링 + LRU 노드 캐싱을 지원합니다.
 *
 * @example
 * const ds = await CopcDataSource.load(url, viewer, {
 *   proj: 'EPSG:2992',
 *   geoidOffset: -20,
 * });
 * ds.onProgress = ({ depth, visible, cached, height }) => { ... };
 * // 제거 시
 * ds.destroy();
 */
export class CopcDataSource {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {object} options
   * @param {string}  options.proj          COPC 데이터의 좌표계 EPSG 코드 (기본: 'EPSG:4326')
   * @param {string}  options.projDef       proj4 정의 문자열 (proj ≠ EPSG:4326 일 때 필수)
   * @param {number}  options.geoidOffset   지오이드 보정값 m (기본: 0)
   * @param {number}  options.concurrency   동시 노드 로드 수 / Worker 풀 크기 (기본: 5)
   * @param {number}  options.debounceMs    카메라 정지 후 LoD 갱신 대기 ms (기본: 300)
   * @param {number}  options.maxCacheNodes LRU 캐시 최대 노드 수 (기본: 80)
   * @param {number}  options.pixelSize     점 크기 px (기본: 2)
   * @param {number}  options.sseThreshold  BFS LoD 확장 임계값 px (기본: 20).
   *                                        낮을수록 더 세밀 (깊은 깊이), 높을수록 성능 우선.
   */
  constructor(viewer, options = {}) {
    this._viewer   = viewer;
    this._opts     = {
      proj:          'EPSG:4326',
      projDef:       null,
      geoidOffset:   0,
      concurrency:   5,
      debounceMs:    300,
      maxCacheNodes: 80,
      pixelSize:     2,
      sseThreshold:  20,
      ...options,
    };

    // 메인 스레드용 proj4 정의 등록 (BoundingSphere 계산에 필요)
    if (this._opts.proj !== 'EPSG:4326' && this._opts.projDef) {
      proj4.defs(this._opts.proj, this._opts.projDef);
    }

    // Worker 풀: concurrency 수만큼 Worker 생성
    this._pool = new WorkerPool(
      new URL('./worker.js', import.meta.url),
      this._opts.concurrency,
    );

    // key → { collection, pointCount, lastUsed }
    this._cache        = new Map();
    this._isUpdating   = false;
    this._pendingUpdate = false;
    this._debounceTimer = null;
    this._removeCameraListener = null;

    this._onProgress = null;
  }

  // ── 정적 팩토리 ─────────────────────────────────────────────

  /**
   * COPC 파일을 로드하고 초기 시점으로 카메라를 이동한 뒤 CopcDataSource를 반환합니다.
   * @param {string} url
   * @param {Cesium.Viewer} viewer
   * @param {object} options  생성자 옵션 참조
   */
  static async load(url, viewer, options = {}) {
    const ds = new CopcDataSource(viewer, options);
    await ds._init(url);
    return ds;
  }

  // ── 초기화 ──────────────────────────────────────────────────

  async _init(url) {
    this._url  = url;
    this._copc = await Copc.create(url);

    const [minx, miny, minz, maxx, maxy, maxz] = this._copc.info.cube;
    this._rootCenter   = { x: (minx + maxx) / 2, y: (miny + maxy) / 2, z: (minz + maxz) / 2 };
    this._rootHalfSize = (maxx - minx) / 2;

    const { nodes } = await Copc.loadHierarchyPage(url, this._copc.info.rootHierarchyPage);
    this._nodes    = nodes;
    this._maxDepth = Math.max(...Object.keys(nodes).map(getDepth));

    // 데이터 중심으로 카메라 이동
    const rootSphere = this._sphere('0-0-0-0');
    await new Promise(resolve => {
      this._viewer.camera.flyToBoundingSphere(rootSphere, {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(0),
          Cesium.Math.toRadians(-45),
          rootSphere.radius * 4,
        ),
        complete: resolve,
      });
    });

    await this._updateLoD();
    this._startListening();
  }

  // ── 내부 유틸 ───────────────────────────────────────────────

  _sphere(key) {
    return getNodeBoundingSphere(
      key, this._rootCenter, this._rootHalfSize,
      this._opts.proj, this._opts.geoidOffset,
    );
  }

  // ── 빠른 경로: 캐시된 노드의 show/hide만 갱신 ──────────────

  _updateVisibility() {
    const cv = getCullingVolume(this._viewer.camera);
    for (const [key, data] of this._cache) {
      data.collection.show = isInFrustum(this._sphere(key), cv);
    }
  }

  // ── BFS LoD 선택 ────────────────────────────────────────────

  /**
   * Potree 방식 BFS + SSE 기반 렌더링 노드 선택.
   *
   * 루트(0-0-0-0)부터 너비 우선 탐색하며 각 노드의 Screen Space Error를 계산합니다.
   *   SSE > sseThreshold AND 자식 존재  → 자식 노드로 확장 (더 세밀하게)
   *   SSE ≤ sseThreshold OR 자식 없음  → 현재 노드를 리프로 선택 (렌더링 대상)
   *
   * 결과: 카메라에 가까운 곳은 깊은 깊이, 먼 곳은 얕은 깊이가 혼재함.
   *
   * @returns {{ visibleKeys: string[], culled: number, maxDepth: number }}
   */
  _selectNodesBFS() {
    const camera    = this._viewer.camera;
    const scene     = this._viewer.scene;
    const cv        = getCullingVolume(camera);
    const threshold = this._opts.sseThreshold;

    const visibleKeys = [];
    let   culled      = 0;
    const queue       = ['0-0-0-0'];

    while (queue.length > 0) {
      const key = queue.shift();

      // 계층에 없는 노드는 스킵
      if (!this._nodes[key]) continue;

      const sphere = this._sphere(key);

      // 프러스텀 컬링: OUTSIDE이면 해당 노드와 그 자손 모두 스킵
      if (!isInFrustum(sphere, cv)) { culled++; continue; }

      // pointCount = 0인 노드는 직접 렌더링하지 않지만 자식은 탐색
      if (this._nodes[key].pointCount === 0) {
        getChildKeys(key)
          .filter(k => this._nodes[k])
          .forEach(k => queue.push(k));
        continue;
      }

      // SSE 계산
      const sse = screenSpaceError(sphere, camera, scene);

      // 존재하는 자식 노드 목록 (pointCount 무관 — 탐색은 계속해야 함)
      const children = getChildKeys(key).filter(k => this._nodes[k]);

      if (sse > threshold && children.length > 0) {
        // 아직 화면에서 너무 크게 보임 → 자식으로 세분화
        children.forEach(k => queue.push(k));
      } else {
        // 충분히 세밀하거나 더 이상 자식 없음 → 이 노드를 렌더링
        visibleKeys.push(key);
      }
    }

    const maxDepth = visibleKeys.length > 0
      ? Math.max(...visibleKeys.map(getDepth))
      : 0;

    return { visibleKeys, culled, maxDepth };
  }

  // ── 느린 경로: LoD 계산 + 새 노드 로드 ─────────────────────

  async _updateLoD() {
    if (this._isUpdating) { this._pendingUpdate = true; return; }
    this._isUpdating = true;

    try {
      const camera = this._viewer.camera;
      const height = camera.positionCartographic.height;

      // 1. BFS + SSE로 이번 프레임에 렌더링할 노드 집합 결정
      const { visibleKeys, culled, maxDepth } = this._selectNodesBFS();
      const targetSet = new Set(visibleKeys);

      // 2. 캐시 히트 → 즉시 표시
      const toLoad = [];
      for (const key of visibleKeys) {
        if (this._cache.has(key)) {
          const d = this._cache.get(key);
          d.collection.show = true;
          d.lastUsed = Date.now();
        } else {
          toLoad.push(key);
        }
      }

      // 3. 화면 중앙에 가까운 노드부터 로드 (시점 중심 우선)
      const camPos = camera.position;
      const camDir = camera.direction;
      toLoad.sort((a, b) => {
        const vA = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(this._sphere(a).center, camPos, new Cesium.Cartesian3()),
          new Cesium.Cartesian3());
        const vB = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(this._sphere(b).center, camPos, new Cesium.Cartesian3()),
          new Cesium.Cartesian3());
        return Cesium.Cartesian3.dot(vB, camDir) - Cesium.Cartesian3.dot(vA, camDir);
      });

      this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
        loading: toLoad.length, cached: this._cache.size, height });

      // 4. 캐시 미스 → 노드 로드
      let loadedCount = 0;
      await this._runConcurrent(toLoad.map(key => async () => {
        const data = await loadNode(
          this._url, this._copc, this._nodes[key], this._pool,
          this._opts.proj, this._opts.projDef,
          this._opts.geoidOffset, this._opts.pixelSize,
        );
        this._viewer.scene.primitives.add(data.collection);
        this._cache.set(key, data);
        loadedCount++;
        this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
          loading: toLoad.length - loadedCount, cached: this._cache.size, height });
      }));

      // 5. 비대상 노드 숨기기
      for (const [key, data] of this._cache) {
        if (!targetSet.has(key)) data.collection.show = false;
      }

      // 6. LRU eviction
      this._evict(targetSet);

      // 7. targetSet 최종 프러스텀 동기화
      //    (로드 중 카메라 이동 시 현재 시점 기준으로 재확인)
      const cv2 = getCullingVolume(camera);
      for (const key of targetSet) {
        const data = this._cache.get(key);
        if (data) data.collection.show = isInFrustum(this._sphere(key), cv2);
      }

      const visiblePoints = [...targetSet]
        .filter(k => this._cache.has(k))
        .reduce((s, k) => s + this._cache.get(k).pointCount, 0);

      this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
        loading: 0, points: visiblePoints, cached: this._cache.size, height });

    } finally {
      this._isUpdating = false;
      if (this._pendingUpdate) {
        this._pendingUpdate = false;
        this._updateLoD();
      }
    }
  }

  _evict(keepSet) {
    if (this._cache.size <= this._opts.maxCacheNodes) return;
    const evictCount = this._cache.size - this._opts.maxCacheNodes;
    [...this._cache.entries()]
      .filter(([k]) => !keepSet.has(k))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, evictCount)
      .forEach(([k, d]) => {
        this._viewer.scene.primitives.remove(d.collection);
        this._cache.delete(k);
      });
  }

  async _runConcurrent(tasks) {
    // WorkerPool이 내부적으로 concurrency를 관리하므로 모두 동시에 시작
    await Promise.all(tasks.map(t => t()));
  }

  _startListening() {
    this._viewer.camera.percentageChanged = 0.01;
    const handler = () => {
      if (!this._isUpdating) this._updateVisibility();
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._updateLoD(), this._opts.debounceMs);
    };
    this._removeCameraListener = this._viewer.camera.changed.addEventListener(handler);
  }

  _emit(info) {
    if (this._onProgress) this._onProgress(info);
  }

  // ── 공개 API ────────────────────────────────────────────────

  /** 진행 상황 콜백. { depth, visible, culled, loading, points, cached, height } */
  set onProgress(fn) { this._onProgress = fn; }
  get onProgress()   { return this._onProgress; }

  /** 데이터의 최대 Octree 깊이 */
  get maxDepth()      { return this._maxDepth; }

  /** 전체 노드 수 */
  get nodeCount()     { return Object.keys(this._nodes).length; }

  /** LRU 캐시 최대 크기 */
  get maxCacheNodes() { return this._opts.maxCacheNodes; }

  /** 현재 캐시된 노드 수 */
  get cacheSize()     { return this._cache.size; }

  /** 모든 리소스를 해제하고 Viewer에서 제거합니다. */
  destroy() {
    clearTimeout(this._debounceTimer);
    if (this._removeCameraListener) this._removeCameraListener();
    this._pool.destroy();
    for (const data of this._cache.values()) {
      this._viewer.scene.primitives.remove(data.collection);
    }
    this._cache.clear();
  }
}
