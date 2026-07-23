import * as Cesium from 'cesium';
import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import proj4 from 'proj4';
import {
  getDepth, getChildKeys, screenSpaceError,
  getNodeBoundingSphere, getCullingVolume, isInFrustum,
} from './lod.js';
import { loadNode } from './loader.js';
import { WorkerPool } from './WorkerPool.js';
import CopcWorker from './worker.ts?worker&inline';
import { lookupEpsg } from './epsg-defs.js';
import type { CopcOptions, ProgressInfo, CrsDetectionResult, NodeCacheEntry, Ref } from '../types.js';

/**
 * COMPD_CS["...", PROJCS[...], VERT_CS[...]] 에서 내부 PROJCS/GEOGCS 블록을
 * 브래킷 카운팅으로 추출합니다. 다른 형식이면 원본을 그대로 반환합니다.
 */
function _extractInnerCrs(wkt: string): string {
  const upper = wkt.trim().toUpperCase();
  if (!upper.startsWith('COMPD_CS')) return wkt;

  // PROJCS 또는 GEOGCS 블록 시작 위치 탐색
  for (const kw of ['PROJCS[', 'GEOGCS[', 'PROJCRS[', 'GEOGCRS[']) {
    const idx = upper.indexOf(kw);
    if (idx < 0) continue;
    let depth = 0;
    for (let i = idx; i < wkt.length; i++) {
      if (wkt[i] === '[') depth++;
      else if (wkt[i] === ']') {
        depth--;
        if (depth === 0) return wkt.slice(idx, i + 1);
      }
    }
  }
  return wkt;
}

/**
 * WKT 문자열에서 선형 단위 계수(m/unit)를 추출합니다.
 */
function _extractLinearUnit(wkt: string): number {
  const lenMatch = wkt.match(/LENGTHUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/i);
  if (lenMatch) {
    const f = parseFloat(lenMatch[1]);
    if (f > 0) return f;
  }
  const allUnits = [...wkt.matchAll(/\bUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/gi)];
  for (let i = allUnits.length - 1; i >= 0; i--) {
    const f = parseFloat(allUnits[i][1]);
    if (f >= 0.05) return f;
  }
  return 1.0;
}

/**
 * WKT에서 EPSG 코드를 추출합니다.
 */
function _extractEpsgCode(wkt: string): string | null {
  const idMatches = [...wkt.matchAll(/\bID\s*\[\s*"EPSG"\s*,\s*(\d+)/gi)];
  if (idMatches.length > 0) return idMatches[idMatches.length - 1][1];
  const authMatch = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"/i);
  if (authMatch) return authMatch[1];
  return null;
}

/**
 * COPC 파일의 WKT VLR에서 좌표계·단위를 자동 감지합니다.
 */
async function detectCrsFromWkt(wkt: string | undefined, url: string): Promise<CrsDetectionResult | null> {
  if (!wkt) return null;
  const trimmed = wkt.trim();
  const upper   = trimmed.toUpperCase();

  const crsWkt = _extractInnerCrs(trimmed);
  const crsUpper = crsWkt.toUpperCase();

  if (/^GEOG(?:CS|CRS)\b/.test(crsUpper) || /^GEOGRAPHICCRS\b/.test(crsUpper) || /^GEODCRS\b/.test(crsUpper)) {
    return { proj: 'EPSG:4326', projDef: null, zFactor: 1.0, xyFactor: 111320 };
  }

  const zFactor = _extractLinearUnit(trimmed);
  const proj = `CRS:${url.replace(/\W+/g, '_')}`;

  try {
    proj4.defs(proj, crsWkt);
    proj4(proj, 'EPSG:4326', [0, 0]);
    return { proj, projDef: crsWkt, zFactor, xyFactor: zFactor };
  } catch (_) {
    // WKT2 또는 지원되지 않는 형식 → 2단계로
  }

  // COMPD_CS(수평+수직 CRS 복합)인 경우 trimmed 전체에서 찾으면 마지막
  // ID[...]가 수직 CRS(예: NAVD88)의 EPSG 코드일 수 있으므로, 앞서 추출한
  // 수평 CRS 블록(crsWkt)에서만 찾는다.
  const epsgCode = _extractEpsgCode(crsWkt);
  if (epsgCode) {
    const proj4Def = lookupEpsg(epsgCode);
    if (proj4Def) {
      proj4.defs(proj, proj4Def);
      console.debug(`[CopcDataSource] EPSG:${epsgCode} 로컬 테이블에서 proj4 정의 로드`);
      return { proj, projDef: proj4Def, zFactor, xyFactor: zFactor };
    }
    console.warn(`[CopcDataSource] EPSG:${epsgCode} 로컬 테이블에 없음 — 기본값(EPSG:4326) 사용`);
  }

  console.warn('[CopcDataSource] WKT CRS 자동 감지 실패 — 기본값(EPSG:4326) 사용');
  return null;
}

type InternalCopcOptions = Omit<Required<CopcOptions>, 'xyFactor'> & { xyFactor?: number };

/**
 * CopcDataSource
 *
 * COPC(.copc.laz) 파일을 CesiumJS Viewer에 스트리밍 방식으로 가시화하는 클래스.
 * LoD(Level of Detail) + 프러스텀 컬링 + LRU 노드 캐싱을 지원합니다.
 */
export class CopcDataSource {
  private _viewer:   Cesium.Viewer;
  private _opts:     InternalCopcOptions;
  private _pool:     WorkerPool;
  private _container: Cesium.PrimitiveCollection;
  private _sphereCache: Map<string, Cesium.BoundingSphere>;
  private _scratchA: Cesium.Cartesian3;
  private _scratchB: Cesium.Cartesian3;
  private _cache:    Map<string, NodeCacheEntry>;
  private _inScene:  Set<string>;
  private _lastTargetSet: Set<string>;
  private _isUpdating:  boolean;
  private _pendingUpdate: boolean;
  private _loadGen:  number;
  private _pixelSizeRef:    Ref<number>;
  private _classMaskRef:    Ref<number>;
  private _seenClasses:     Set<number>;
  private _upVecRef:        Ref<Cesium.Cartesian3>;
  private _heightOffsetRef: Ref<number>;
  private _onProgress: ((info: ProgressInfo) => void) | null;
  private _destroyed: boolean;
  private _lastSphereMap: Map<string, Cesium.BoundingSphere> | null;
  private _removePostUpdateListener: (() => void) | null;
  private _removeMoveEndListener:    (() => void) | null;

  // 초기화 후 설정되는 필드
  private _url!: string;
  private _copc!: Awaited<ReturnType<typeof Copc.create>>;
  private _rootCenter!: { x: number; y: number; z: number };
  private _rootHalfSize!: number;
  private _nodes!: Hierarchy.Node.Map;
  private _maxDepth!: number;

  constructor(viewer: Cesium.Viewer, options: Partial<CopcOptions> = {}) {
    this._viewer = viewer;
    this._opts   = {
      proj:            'EPSG:4326',
      projDef:         null,
      geoidOffset:     0,
      concurrency:     5,
      maxCacheNodes:   150,
      maxVisibleNodes: 100,
      pixelSize:       2,
      sseThreshold:    250,
      zFactor:         0.3048,
      xyFactor:        undefined,
      ...options,
    };

    // 메인 스레드용 proj4 정의 등록
    if (this._opts.proj !== 'EPSG:4326' && this._opts.projDef) {
      proj4.defs(this._opts.proj, this._opts.projDef);
    }

    // Worker 풀 (Blob URL 인라인 워커 — 정적 파일 MIME 타입 이슈 회피)
    this._pool = new WorkerPool(CopcWorker, this._opts.concurrency);

    this._container = new Cesium.PrimitiveCollection({ destroyPrimitives: false });
    viewer.scene.primitives.add(this._container);

    this._sphereCache  = new Map();
    this._scratchA     = new Cesium.Cartesian3();
    this._scratchB     = new Cesium.Cartesian3();
    this._cache        = new Map();
    this._inScene      = new Set();
    this._lastTargetSet = new Set();
    this._isUpdating   = false;
    this._pendingUpdate = false;
    this._loadGen = 0;

    this._pixelSizeRef    = { value: this._opts.pixelSize };
    this._classMaskRef    = { value: -1 };
    this._seenClasses     = new Set();
    this._upVecRef        = { value: new Cesium.Cartesian3(0, 0, 1) };
    this._heightOffsetRef = { value: 0 };

    this._onProgress              = null;
    this._destroyed               = false;
    this._lastSphereMap           = null;
    this._removePostUpdateListener = null;
    this._removeMoveEndListener    = null;
  }

  // ── 정적 팩토리 ─────────────────────────────────────────────

  static async load(url: string, viewer: Cesium.Viewer, options: Partial<CopcOptions> = {}): Promise<CopcDataSource> {
    const ds = new CopcDataSource(viewer, options);
    await ds._init(url);
    return ds;
  }

  // ── 초기화 ──────────────────────────────────────────────────

  private async _init(url: string): Promise<void> {
    try {
      this._url  = url;
      try {
        this._copc = await Copc.create(url);
      } catch (err) {
        const e = err as Error;
        if (/must be at least|Invalid header|COPC info VLR/i.test(e.message)) {
          throw new Error(
            `COPC 헤더를 읽을 수 없습니다. URL이 올바른지 또는 CORS 접근이 허용된지 확인하세요.\n` +
            `원인: ${e.message}`
          );
        }
        throw err;
      }

      if (!this._opts.projDef) {
        const detected = await detectCrsFromWkt(this._copc.wkt, url);
        if (detected) {
          this._opts.proj     = detected.proj;
          this._opts.projDef  = detected.projDef;
          this._opts.zFactor  = detected.zFactor;
          this._opts.xyFactor = detected.xyFactor;
          if (detected.projDef && detected.proj !== 'EPSG:4326') {
            proj4.defs(detected.proj, detected.projDef);
          }
          console.debug(
            `[CopcDataSource] WKT CRS 자동 감지: proj=${detected.proj}, ` +
            `zFactor=${detected.zFactor}, xyFactor=${detected.xyFactor}`
          );
        }
      }

      const [minx, miny, minz, maxx, maxy, maxz] = this._copc.info.cube;
      this._rootCenter   = { x: (minx + maxx) / 2, y: (miny + maxy) / 2, z: (minz + maxz) / 2 };
      this._rootHalfSize = (maxx - minx) / 2;

      this._seenClasses.clear();

      const { nodes } = await Copc.loadHierarchyPage(url, this._copc.info.rootHierarchyPage);
      this._nodes    = nodes;
      this._maxDepth = Math.max(...Object.keys(nodes).map(getDepth));

      const rootSphere = this._sphere('0-0-0-0');

      Cesium.Cartesian3.normalize(rootSphere.center, this._upVecRef.value);

      const canvas   = this._viewer.scene.canvas;
      const fovY     = (this._viewer.camera.frustum as any).fovy ?? (Math.PI / 3);
      const sseScale = canvas.clientHeight / (2 * Math.tan(fovY / 2));
      const initRange = rootSphere.radius * sseScale / (this._opts.sseThreshold * 2);

      await new Promise<void>(resolve => {
        this._viewer.camera.flyToBoundingSphere(rootSphere, {
          offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(0),
            Cesium.Math.toRadians(-45),
            initRange,
          ),
          complete: resolve,
        });
      });

      await this._updateLoD();
      this._startListening();
    } catch (err) {
      this._pool.destroy();
      this._viewer.scene.primitives.remove(this._container);
      throw err;
    }
  }

  // ── 내부 유틸 ───────────────────────────────────────────────

  // key별 원본(오프셋 미적용) BoundingSphere — 영구 캐시
  private _sphere(key: string): Cesium.BoundingSphere {
    let s = this._sphereCache.get(key);
    if (!s) {
      s = getNodeBoundingSphere(
        key, this._rootCenter, this._rootHalfSize,
        this._opts.proj, this._opts.geoidOffset,
        this._opts.zFactor  ?? 0.3048,
        this._opts.xyFactor ?? (this._opts.zFactor ?? 0.3048),
      );
      this._sphereCache.set(key, s);
    }
    // heightOffset은 정점 셰이더에서 렌더링 위치를 u_upVec 방향으로 이동시키므로
    // (loader.ts), 컬링/SSE 판정에 쓰이는 BoundingSphere도 동일하게 보정해야
    // 실제 렌더링 위치와 컬링 판정이 어긋나지 않는다.
    const offset = this._heightOffsetRef.value;
    if (offset === 0) return s;
    const shift  = Cesium.Cartesian3.multiplyByScalar(this._upVecRef.value, offset, new Cesium.Cartesian3());
    const center = Cesium.Cartesian3.add(s.center, shift, new Cesium.Cartesian3());
    return new Cesium.BoundingSphere(center, s.radius);
  }

  // ── 빠른 경로: LoD 선택 결과 내에서 frustum show/hide만 갱신 ──

  private _updateVisibility(): void {
    if (this._lastTargetSet.size === 0) return;
    const cv = getCullingVolume(this._viewer.camera);
    for (const key of this._lastTargetSet) {
      const data = this._cache.get(key);
      if (data) {
        const sphere = (this._lastSphereMap && this._lastSphereMap.get(key))
          ?? this._sphere(key);
        data.collection.show = isInFrustum(sphere, cv);
      }
    }
  }

  // ── BFS LoD 선택 ────────────────────────────────────────────

  private _selectNodesBFS(): { visibleKeys: string[]; sphereMap: Map<string, Cesium.BoundingSphere>; culled: number; maxDepth: number } {
    const camera    = this._viewer.camera;
    const scene     = this._viewer.scene;
    const cv        = getCullingVolume(camera);
    const threshold = this._opts.sseThreshold;
    const maxNodes  = this._opts.maxVisibleNodes;

    const sphereMap = new Map<string, Cesium.BoundingSphere>();
    const getSphere = (key: string): Cesium.BoundingSphere => {
      let s = sphereMap.get(key);
      if (!s) { s = this._sphere(key); sphereMap.set(key, s); }
      return s;
    };

    const visibleKeys: string[] = [];
    let   culled      = 0;
    let   maxDepth    = 0;

    // SSE 내림차순 우선순위 큐: 카메라 기준 가장 중요한 노드부터 확장
    // FIFO 큐와 달리 멀리 있는 노드보다 가까운 고-SSE 노드를 우선 처리
    const rootSphere = getSphere('0-0-0-0');
    const rootSse    = screenSpaceError(rootSphere, camera, scene);
    const pq: Array<{ key: string; sse: number }> = [{ key: '0-0-0-0', sse: rootSse }];

    while (pq.length > 0) {
      const { key } = pq.shift()!;

      const nodeInfo = this._nodes[key];
      if (!nodeInfo) continue;

      const sphere = getSphere(key);

      if (!isInFrustum(sphere, cv)) { culled++; continue; }

      if (nodeInfo.pointCount === 0) {
        const children = getChildKeys(key).filter(k => this._nodes[k]);
        for (const k of children) {
          pq.push({ key: k, sse: screenSpaceError(getSphere(k), camera, scene) });
        }
        pq.sort((a, b) => b.sse - a.sse);
        continue;
      }

      const sse = screenSpaceError(sphere, camera, scene);
      const children = getChildKeys(key).filter(k => this._nodes[k]);

      if (visibleKeys.length < maxNodes && sse > threshold && children.length > 0) {
        for (const k of children) {
          pq.push({ key: k, sse: screenSpaceError(getSphere(k), camera, scene) });
        }
        pq.sort((a, b) => b.sse - a.sse);
      } else {
        visibleKeys.push(key);
        const d = getDepth(key);
        if (d > maxDepth) maxDepth = d;
      }
    }

    const camPos   = camera.position;
    const camDir   = camera.direction;
    const scratchA = this._scratchA;
    const scratchB = this._scratchB;

    // D1: 정렬 비교 시마다 벡터 연산을 반복하지 않도록 dot product를 미리 계산
    const dotCache = new Map<string, number>();
    for (const key of visibleKeys) {
      Cesium.Cartesian3.subtract(getSphere(key).center, camPos, scratchA);
      Cesium.Cartesian3.normalize(scratchA, scratchA);
      dotCache.set(key, Cesium.Cartesian3.dot(scratchA, camDir));
    }
    visibleKeys.sort((a, b) => (dotCache.get(b) ?? 0) - (dotCache.get(a) ?? 0));

    return { visibleKeys, sphereMap, culled, maxDepth };
  }

  // ── 느린 경로: LoD 계산 + 새 노드 로드 ─────────────────────

  private async _updateLoD(): Promise<void> {
    if (this._destroyed) return;
    if (this._isUpdating) { this._pendingUpdate = true; return; }
    this._isUpdating = true;
    const gen = this._loadGen;

    try {
      const camera = this._viewer.camera;
      const height = camera.positionCartographic?.height ?? 0;

      const { visibleKeys, sphereMap, culled, maxDepth } = this._selectNodesBFS();
      const targetSet = new Set(visibleKeys);
      this._lastTargetSet = targetSet;
      this._lastSphereMap = sphereMap;

      const getSphere = (key: string): Cesium.BoundingSphere => {
        let s = sphereMap.get(key);
        if (!s) { s = this._sphere(key); sphereMap.set(key, s); }
        return s;
      };

      const toLoad: string[] = [];
      for (const key of visibleKeys) {
        if (this._cache.has(key)) {
          const d = this._cache.get(key)!;
          if (!this._inScene.has(key)) {
            this._container.add(d.collection);
            this._inScene.add(key);
          }
          d.collection.show = true;
          d.lastUsed = Date.now();
        } else {
          toLoad.push(key);
        }
      }

      this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
        loading: toLoad.length, cached: this._cache.size, height });

      let loadedCount = 0;
      const makeLoadTask = (key: string) => async (): Promise<void> => {
        if (gen !== this._loadGen || this._destroyed) return;

        const nodeInfo = this._nodes[key];
        if (!nodeInfo) return;

        const data = await loadNode(
          this._url, this._copc, nodeInfo, this._pool,
          this._opts.proj, this._opts.projDef,
          this._opts.geoidOffset, this._pixelSizeRef, this._classMaskRef,
          this._opts.zFactor ?? 0.3048,
          this._upVecRef, this._heightOffsetRef,
        );

        // await 이후: destroy() 호출 여부를 반드시 먼저 확인
        if (this._destroyed) {
          data.collection.destroy();
          return;
        }

        if (gen !== this._loadGen) {
          if (!this._cache.has(key)) {
            this._cache.set(key, data);
            for (const c of data.seenClasses) this._seenClasses.add(c);
          } else {
            data.collection.destroy();
          }
          return;
        }

        for (const c of data.seenClasses) this._seenClasses.add(c);
        this._container.add(data.collection);
        this._inScene.add(key);
        this._cache.set(key, data);
        loadedCount++;
        this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
          loading: toLoad.length - loadedCount, cached: this._cache.size, height });
      };

      const priorityPromise = toLoad.length > 0
        ? makeLoadTask(toLoad.shift()!)().catch(err =>
            console.warn('[CopcDataSource] 중앙 노드 로드 실패:', err)
          )
        : null;

      await this._runConcurrent(toLoad.map(makeLoadTask));

      if (priorityPromise) await priorityPromise;

      if (gen === this._loadGen && !this._destroyed) {
        for (const [key, data] of this._cache) {
          if (!targetSet.has(key) && this._inScene.has(key)) {
            this._container.remove(data.collection);
            this._inScene.delete(key);
          }
        }

        this._evict(targetSet);

        const cv2 = getCullingVolume(camera);
        for (const key of targetSet) {
          const data = this._cache.get(key);
          if (data) data.collection.show = isInFrustum(getSphere(key), cv2);
        }

        const visiblePoints = [...targetSet]
          .reduce((s, k) => s + (this._cache.get(k)?.pointCount ?? 0), 0);

        this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
          loading: 0, points: visiblePoints, cached: this._cache.size, height });
      } else {
        this._evict(this._inScene);
      }

    } finally {
      this._isUpdating = false;
      if (this._pendingUpdate) {
        this._pendingUpdate = false;
        void this._updateLoD().catch(err =>
          console.error('[CopcDataSource] LoD 업데이트 실패:', err)
        );
      }
    }
  }

  private _evict(keepSet: Set<string>): void {
    if (this._cache.size <= this._opts.maxCacheNodes) return;
    const evictCount = this._cache.size - this._opts.maxCacheNodes;
    [...this._cache.entries()]
      .filter(([k]) => !keepSet.has(k))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, evictCount)
      .forEach(([k, d]) => {
        if (this._inScene.has(k)) {
          this._container.remove(d.collection);
          this._inScene.delete(k);
        }
        // E2: 이미 destroy된 객체에 재호출 방지
        if (!d.collection.isDestroyed()) d.collection.destroy();
        this._cache.delete(k);
      });
  }

  private async _runConcurrent(tasks: Array<() => Promise<void>>): Promise<void> {
    const limit   = this._opts.concurrency;
    const running = new Set<Promise<void>>();
    for (const task of tasks) {
      const p: Promise<void> = Promise.resolve().then(task).catch(err => {
        console.warn('[CopcDataSource] 노드 로드 실패:', err);
      }).finally(() => running.delete(p));
      running.add(p);
      if (running.size >= limit) await Promise.race(running);
    }
    if (running.size > 0) await Promise.all(running);
  }

  private _startListening(): void {
    let prevHeight = this._viewer.camera.positionCartographic?.height ?? 0;
    let lastLodMs  = 0;

    this._removePostUpdateListener = this._viewer.scene.postUpdate.addEventListener(() => {
      if (this._destroyed) return;

      const h = this._viewer.camera.positionCartographic?.height ?? 0;
      if (h > prevHeight) this._loadGen++;
      prevHeight = h;

      if (!this._isUpdating) this._updateVisibility();

      const now = Date.now();
      if (now - lastLodMs >= 200) {
        lastLodMs = now;
        // G2: void로 버리지 않고 오류를 콘솔에 기록
        void this._updateLoD().catch(err =>
          console.error('[CopcDataSource] LoD 업데이트 실패:', err)
        );
      }
    });

    this._removeMoveEndListener = this._viewer.camera.moveEnd.addEventListener(() => {
      if (this._destroyed) return;
      lastLodMs = Date.now();
      void this._updateLoD().catch(err =>
        console.error('[CopcDataSource] LoD 업데이트 실패:', err)
      );
    });
  }

  private _emit(info: Omit<ProgressInfo, 'seenClasses'>): void {
    if (this._onProgress) this._onProgress({ ...info, seenClasses: this._seenClasses });
  }

  // ── 공개 API ────────────────────────────────────────────────

  set onProgress(fn: ((info: ProgressInfo) => void) | null) { this._onProgress = fn; }
  get onProgress(): ((info: ProgressInfo) => void) | null   { return this._onProgress; }

  set pixelSize(v: number)   { this._pixelSizeRef.value = v; }
  get pixelSize(): number    { return this._pixelSizeRef.value; }

  set heightOffset(v: number) { this._heightOffsetRef.value = v; }
  get heightOffset(): number  { return this._heightOffsetRef.value; }

  set sseThreshold(v: number) {
    this._opts.sseThreshold = v;
    void this._updateLoD().catch(err =>
      console.error('[CopcDataSource] LoD 업데이트 실패:', err)
    );
  }
  get sseThreshold(): number  { return this._opts.sseThreshold; }

  setClassMask(mask: number): void { this._classMaskRef.value = mask; }

  get seenClasses(): Set<number>  { return this._seenClasses; }
  get maxDepth(): number          { return this._maxDepth; }
  get nodeCount(): number         { return Object.keys(this._nodes).length; }
  get maxCacheNodes(): number     { return this._opts.maxCacheNodes; }
  get cacheSize(): number         { return this._cache.size; }

  destroy(): void {
    this._destroyed = true;
    if (this._removePostUpdateListener) this._removePostUpdateListener();
    if (this._removeMoveEndListener)    this._removeMoveEndListener();
    this._pool.destroy();
    for (const data of this._cache.values()) {
      data.collection.destroy();
    }
    this._cache.clear();
    this._inScene.clear();
    this._viewer.scene.primitives.remove(this._container);
  }
}
