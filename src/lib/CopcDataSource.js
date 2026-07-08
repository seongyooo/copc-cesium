import * as Cesium from 'cesium';
import { Copc } from 'copc';
import proj4 from 'proj4';
import {
  getDepth, getChildKeys, screenSpaceError,
  getNodeBoundingSphere, getCullingVolume, isInFrustum,
} from './lod.js';
import { loadNode } from './loader.js';
import { WorkerPool } from './WorkerPool.js';
import { lookupEpsg } from './epsg-defs.js';

/**
 * COMPD_CS["...", PROJCS[...], VERT_CS[...]] 에서 내부 PROJCS/GEOGCS 블록을
 * 브래킷 카운팅으로 추출합니다. 다른 형식이면 원본을 그대로 반환합니다.
 */
function _extractInnerCrs(wkt) {
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
 *   WKT2: LENGTHUNIT["unit",factor]
 *   WKT1: PROJCS 레벨의 마지막 UNIT["unit",factor] (첫 번째는 각도 단위이므로 제외)
 */
function _extractLinearUnit(wkt) {
  // WKT2 전용 LENGTHUNIT 우선 시도
  const lenMatch = wkt.match(/LENGTHUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/i);
  if (lenMatch) {
    const f = parseFloat(lenMatch[1]);
    if (f > 0) return f;
  }
  // WKT1: 문자열에서 모든 UNIT 추출 → 마지막(선형 단위)만 사용
  // 각도 단위(~0.01745)는 0.05 미만이므로 필터
  const allUnits = [...wkt.matchAll(/\bUNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+(?:[eE][+-]?\d+)?)/gi)];
  for (let i = allUnits.length - 1; i >= 0; i--) {
    const f = parseFloat(allUnits[i][1]);
    if (f >= 0.05) return f; // 0.3048 (feet) 또는 1.0 (metres)
  }
  return 1.0; // 기본값: 미터
}

/**
 * WKT에서 EPSG 코드를 추출합니다.
 *   WKT1: AUTHORITY["EPSG","2229"]
 *   WKT2: ID["EPSG",2229]  (파일 끝 쪽에 위치)
 */
function _extractEpsgCode(wkt) {
  // WKT2 ID["EPSG",NNNN] — 가장 바깥(마지막) ID 엔트리가 CRS 자체의 코드
  const idMatches = [...wkt.matchAll(/\bID\s*\[\s*"EPSG"\s*,\s*(\d+)/gi)];
  if (idMatches.length > 0) return idMatches[idMatches.length - 1][1];
  // WKT1 AUTHORITY["EPSG","NNNN"]
  const authMatch = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"/i);
  if (authMatch) return authMatch[1];
  return null;
}

/**
 * COPC 파일의 WKT VLR에서 좌표계·단위를 자동 감지합니다.
 * proj4js가 WKT2를 파싱하지 못하는 경우 EPSG 코드로 로컬 테이블에서 정의를 조회합니다.
 *
 * @param {string|undefined} wkt  Copc.create() 가 반환한 wkt 문자열
 * @param {string}           url  데이터 URL (proj4 키로 사용)
 * @returns {Promise<{ proj, projDef, zFactor, xyFactor } | null>}
 */
async function detectCrsFromWkt(wkt, url) {
  if (!wkt) return null;
  const trimmed = wkt.trim();
  const upper   = trimmed.toUpperCase();

  // ── COMPD_CS 언래핑: 내부 PROJCS/GEOGCS 블록만 추출 ────────────────────
  // proj4js 는 COMPD_CS 래퍼를 인식하지 못하므로 수평 CRS 만 꺼냄
  const crsWkt = _extractInnerCrs(trimmed);
  const crsUpper = crsWkt.toUpperCase();

  // ── 지리좌표계 (WKT1: GEOGCS, WKT2: GEOGCRS / GEOGRAPHICCRS / GEODCRS) ──
  // XY 는 이미 lon/lat(도) → proj 변환 불필요, Z 는 미터
  if (/^GEOG(?:CS|CRS)\b/.test(crsUpper) || /^GEOGRAPHICCRS\b/.test(crsUpper) || /^GEODCRS\b/.test(crsUpper)) {
    return { proj: 'EPSG:4326', projDef: null, zFactor: 1.0, xyFactor: 111320 };
  }

  // ── 선형 단위 계수 추출 (전체 WKT 기준, COMPD_CS 포함) ──────────────────
  const zFactor = _extractLinearUnit(trimmed);

  // ── proj4 키 (URL 기반, 특수문자 치환) ──────────────────────────────────
  const proj = `CRS:${url.replace(/\W+/g, '_')}`;

  // ── 1단계: 추출된 PROJCS WKT 로 proj4 등록 시도 (WKT1 PROJCS 는 대부분 성공) ──
  try {
    proj4.defs(proj, crsWkt);
    // 실제 변환이 작동하는지 확인 (WKT2 는 등록은 되지만 "Could not get projection name" 발생)
    proj4(proj, 'EPSG:4326', [0, 0]);
    return { proj, projDef: crsWkt, zFactor, xyFactor: zFactor };
  } catch (_) {
    // WKT2 또는 지원되지 않는 형식 → 2단계로
  }

  // ── 2단계: EPSG 코드 추출 → 로컬 테이블 조회 ────────────────────────────
  const epsgCode = _extractEpsgCode(trimmed);
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
   * @param {number}  options.maxCacheNodes LRU 캐시 최대 노드 수 (기본: 80)
   * @param {number}  options.pixelSize     점 크기 px (기본: 2)
   * @param {number}  options.maxVisibleNodes BFS가 한 번에 선택하는 최대 렌더링 노드 수 (기본: 100).
   *                                         초과 시 BFS를 조기 종료해 무한 탐색을 방지합니다.
   * @param {number}  options.sseThreshold  BFS LoD 확장 임계값 px (기본: 250).
   *                                        초기 전체 조망 거리(radius×4)에서 루트(depth 0)가
   *                                        바로 선택되도록 250px 이상을 권장.
   *                                        낮을수록 더 세밀 (깊은 깊이), 높을수록 성능 우선.
   */
  constructor(viewer, options = {}) {
    this._viewer   = viewer;
    this._opts     = {
      proj:           'EPSG:4326',
      projDef:        null,
      geoidOffset:    0,
      concurrency:    5,
      maxCacheNodes:   150,  // B-5: maxVisibleNodes(100)보다 크게 유지해야 eviction 동작
      maxVisibleNodes: 100,
      pixelSize:       2,
      sseThreshold:    250,
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

    // destroyPrimitives: false — remove() 시 Cesium이 자동으로 destroy()를
    // 호출하지 않도록 한다. 캐시에서 꺼내 재추가할 수 있어야 하기 때문.
    // 씬에는 이 컨테이너 하나만 추가한다.
    this._container = new Cesium.PrimitiveCollection({ destroyPrimitives: false });
    viewer.scene.primitives.add(this._container);

    // key → { collection, pointCount, lastUsed }
    this._cache        = new Map();
    // 현재 _container에 추가된 노드 키 집합.
    this._inScene       = new Set();
    // 마지막 LoD 선택 결과 — _updateVisibility 빠른 경로에서 재사용
    this._lastTargetSet = new Set();
    this._isUpdating   = false;
    this._pendingUpdate = false;
    this._removeCameraListener = null;
    // 카메라가 움직일 때마다 증가. loadNode 완료 후 이 값이 바뀌었으면
    // 결과를 버려 구형 시점의 노드가 씬에 추가되는 것을 막는다.
    this._loadGen = 0;

    // 모든 PointCloudPrimitive가 공유하는 ref 객체.
    // 값만 변경하면 다음 프레임 즉시 반영 (재로드 불필요).
    this._pixelSizeRef = { value: this._opts.pixelSize };
    this._classMaskRef = { value: -1 }; // -1 = 전체 표시 (모든 비트 1)
    this._seenClasses  = new Set();     // 로드된 노드에서 발견된 분류값 집합
    this._upVecRef        = { value: new Cesium.Cartesian3(0, 0, 1) };
    this._heightOffsetRef = { value: 0 };

    this._onProgress    = null;
    this._destroyed     = false; // A-3: 이중 호출·재진입 방지
    this._lastSphereMap = null;  // C-1: _updateVisibility proj4 재호출 방지
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
    // A-2: 초기화 실패 시 이미 생성된 리소스를 정리한다.
    try {
      this._url  = url;
      try {
        this._copc = await Copc.create(url);
      } catch (err) {
        // 헤더 파싱 실패는 대부분 URL 접근 불가(403/404) 또는 비-COPC 파일이다.
        if (/must be at least|Invalid header|COPC info VLR/i.test(err.message)) {
          throw new Error(
            `COPC 헤더를 읽을 수 없습니다. URL이 올바른지 또는 CORS 접근이 허용된지 확인하세요.\n` +
            `원인: ${err.message}`
          );
        }
        throw err;
      }

      // WKT VLR 에서 좌표계·단위 자동 감지 (사용자가 projDef 를 직접 지정한 경우 스킵)
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

      // 데이터 중심으로 카메라 이동
      const rootSphere = this._sphere('0-0-0-0');

      // upVec: rootSphere 중심 방향의 단위 벡터 (지역 상향)
      Cesium.Cartesian3.normalize(rootSphere.center, this._upVecRef.value);

      // SSE threshold의 2배 거리 → 첫 프레임부터 depth 깊게 시작
      const canvas   = this._viewer.scene.canvas;
      const fovY     = this._viewer.camera.frustum.fovy ?? (Math.PI / 3);
      const sseScale = canvas.clientHeight / (2 * Math.tan(fovY / 2));
      const initRange = rootSphere.radius * sseScale / (this._opts.sseThreshold * 2);

      await new Promise(resolve => {
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
      // WorkerPool 종료 + 씬에서 컨테이너 제거 후 재throw
      this._pool.destroy();
      this._viewer.scene.primitives.remove(this._container);
      throw err;
    }
  }

  // ── 내부 유틸 ───────────────────────────────────────────────

  async _autoDetectGeoidOffset() {
    try {
      const [minx, miny, minz, maxx, maxy, maxz] = this._copc.info.cube;
      const cx = (minx + maxx) / 2;
      const cy = (miny + maxy) / 2;

      const toWgs84 = (x, y) => {
        if (this._opts.proj === 'EPSG:4326' || !this._opts.projDef) return [x, y];
        return proj4(this._opts.proj, 'EPSG:4326', [x, y]);
      };

      // 5개 지점(center + 4 midpoints) 지형 샘플 → 최솟값 사용.
      // 데이터셋 최저 Z(minz)는 지형이 낮은 곳에 있는 경향이 있으므로
      // 지형 최솟값이 minz 기준점과 가장 잘 대응한다.
      const pts = [
        [cx,   cy  ],
        [cx,   miny],
        [cx,   maxy],
        [minx, cy  ],
        [maxx, cy  ],
      ].map(([x, y]) => {
        const [lon, lat] = toWgs84(x, y);
        return Cesium.Cartographic.fromDegrees(lon, lat);
      });

      const samples = await Cesium.sampleTerrainMostDetailed(
        this._viewer.terrainProvider, pts,
      );
      const minTerrainH = Math.min(...samples.map(s => s.height ?? 0));

      const zFactor  = this._opts.zFactor ?? 1.0;
      const groundZ  = minz * zFactor; // cube 최저점(미터, 소스 CRS)
      const offset   = minTerrainH - groundZ;

      if (Math.abs(offset) < 2000) {
        this._opts.geoidOffset = offset;
        console.debug(`[CopcDataSource] 고도 자동 보정: ${offset.toFixed(1)}m (지형최저: ${minTerrainH.toFixed(1)}m, 데이터최저: ${groundZ.toFixed(1)}m)`);
      } else {
        console.warn(`[CopcDataSource] 고도 자동 보정 범위 초과(${offset.toFixed(1)}m), 스킵`);
      }
    } catch (e) {
      console.warn('[CopcDataSource] 고도 자동 보정 실패:', e.message);
    }
  }

  _sphere(key) {
    return getNodeBoundingSphere(
      key, this._rootCenter, this._rootHalfSize,
      this._opts.proj, this._opts.geoidOffset,
      this._opts.zFactor  ?? 0.3048,
      this._opts.xyFactor ?? (this._opts.zFactor ?? 0.3048),
    );
  }

  // ── 빠른 경로: LoD 선택 결과 내에서 frustum show/hide만 갱신 ──

  _updateVisibility() {
    // 전체 캐시가 아닌 _lastTargetSet 안에서만 frustum 판정.
    // 전체 캐시를 순회하면 LoD로 숨겨둔 깊은 노드가 카메라 이동 시
    // 다시 show=true 가 되어 LoD가 무시되는 버그가 발생함.
    if (this._lastTargetSet.size === 0) return;
    const cv = getCullingVolume(this._viewer.camera);
    for (const key of this._lastTargetSet) {
      const data = this._cache.get(key);
      if (data) {
        // C-1: _lastSphereMap 재사용으로 proj4 재호출 방지
        const sphere = (this._lastSphereMap && this._lastSphereMap.get(key))
          ?? this._sphere(key);
        data.collection.show = isInFrustum(sphere, cv);
      }
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
    const maxNodes  = this._opts.maxVisibleNodes;

    // BFS 중 계산한 BoundingSphere를 메모이즈.
    // sort 비교자가 같은 키를 반복 조회할 때 proj4를 재실행하지 않는다.
    const sphereMap = new Map();
    const getSphere = (key) => {
      let s = sphereMap.get(key);
      if (!s) { s = this._sphere(key); sphereMap.set(key, s); }
      return s;
    };

    const visibleKeys = [];
    let   culled      = 0;
    let   maxDepth    = 0; // C-2: BFS 루프 내에서 직접 추적 (Math.max 스프레드 제거)
    const queue       = ['0-0-0-0'];

    while (queue.length > 0) {
      const key = queue.shift();

      // 계층에 없는 노드는 스킵
      if (!this._nodes[key]) continue;

      const sphere = getSphere(key);

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

      // B-1: maxNodes 한도 내이고 SSE 초과 시만 자식 확장.
      // 한도 초과 시 현재 노드를 리프로 사용 → 이미 큐에 쌓인 자식 구역에
      // 구멍(hole)이 생기지 않음.
      if (visibleKeys.length < maxNodes && sse > threshold && children.length > 0) {
        // 아직 화면에서 너무 크게 보임 → 자식으로 세분화
        children.forEach(k => queue.push(k));
      } else {
        // 충분히 세밀하거나 자식 없음, 또는 노드 한도 도달 → 이 노드를 렌더링
        visibleKeys.push(key);
        const d = getDepth(key); // C-2
        if (d > maxDepth) maxDepth = d;
      }
    }

    // ── 중심 우선 정렬 ──
    // sphereMap에서 O(1)로 꺼내므로 sort 중 proj4 재실행 없음.
    // B-3: 두 개의 별도 scratch 사용 (a·b 계산 중 덮어쓰기 방지)
    const camPos    = camera.position;
    const camDir    = camera.direction;
    const scratchA  = new Cesium.Cartesian3();
    const scratchB  = new Cesium.Cartesian3();

    visibleKeys.sort((a, b) => {
      Cesium.Cartesian3.subtract(getSphere(a).center, camPos, scratchA);
      Cesium.Cartesian3.normalize(scratchA, scratchA);
      const dotA = Cesium.Cartesian3.dot(scratchA, camDir);
      Cesium.Cartesian3.subtract(getSphere(b).center, camPos, scratchB);
      Cesium.Cartesian3.normalize(scratchB, scratchB);
      const dotB = Cesium.Cartesian3.dot(scratchB, camDir);
      return dotB - dotA;
    });

    return { visibleKeys, sphereMap, culled, maxDepth };
  }

  // ── 느린 경로: LoD 계산 + 새 노드 로드 ─────────────────────

  async _updateLoD() {
    if (this._destroyed) return; // A-3: destroy() 후 재진입 방지
    if (this._isUpdating) { this._pendingUpdate = true; return; }
    this._isUpdating = true;
    // 이 업데이트 시작 시점의 세대 번호를 캡처.
    // 로드 중 카메라가 움직이면 _loadGen이 증가하여 gen과 달라진다.
    const gen = this._loadGen;

    try {
      const camera = this._viewer.camera;
      const height = camera.positionCartographic.height;

      // 1. BFS + SSE로 이번 프레임에 렌더링할 노드 집합 결정
      const { visibleKeys, sphereMap, culled, maxDepth } = this._selectNodesBFS();
      const targetSet = new Set(visibleKeys);
      // _updateVisibility 빠른 경로에서 사용할 수 있도록 즉시 저장
      this._lastTargetSet = targetSet;
      this._lastSphereMap = sphereMap; // C-1: _updateVisibility proj4 재호출 방지

      // sphereMap에 없는 키는 여기서 계산 (toLoad.sort 등에서 재사용)
      const getSphere = (key) => {
        let s = sphereMap.get(key);
        if (!s) { s = this._sphere(key); sphereMap.set(key, s); }
        return s;
      };

      // 2. 캐시 히트 → 씬에 없으면 다시 추가, 표시
      const toLoad = [];
      for (const key of visibleKeys) {
        if (this._cache.has(key)) {
          const d = this._cache.get(key);
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

      // 3. 화면 중앙에 가까운 노드부터 로드 (시점 중심 우선)
      // sphereMap 재사용으로 추가 proj4 호출 없음
      const camPos = camera.position;
      const camDir = camera.direction;
      const sv     = new Cesium.Cartesian3();
      toLoad.sort((a, b) => {
        Cesium.Cartesian3.subtract(getSphere(a).center, camPos, sv);
        Cesium.Cartesian3.normalize(sv, sv);
        const dotA = Cesium.Cartesian3.dot(sv, camDir);
        Cesium.Cartesian3.subtract(getSphere(b).center, camPos, sv);
        Cesium.Cartesian3.normalize(sv, sv);
        const dotB = Cesium.Cartesian3.dot(sv, camDir);
        return dotB - dotA;
      });

      this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
        loading: toLoad.length, cached: this._cache.size, height });

      // 4. 캐시 미스 → 노드 로드
      let loadedCount = 0;
      await this._runConcurrent(toLoad.map(key => async () => {
        // 로드 시작 전 세대 확인: 카메라가 이미 움직였으면 이 노드는 건너뜀
        if (gen !== this._loadGen) return;

        const data = await loadNode(
          this._url, this._copc, this._nodes[key], this._pool,
          this._opts.proj, this._opts.projDef,
          this._opts.geoidOffset, this._pixelSizeRef, this._classMaskRef,
          this._opts.zFactor ?? 0.3048,
          this._upVecRef, this._heightOffsetRef,
        );

        // 로드 완료 후 세대 확인 — gen 불일치 시 씬에 추가하지 않되 캐시에 보관.
        // 이후 카메라가 같은 위치로 돌아오면 즉시 캐시 히트로 표시됨.
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
      }));

      // 5‒7. gen 불일치(로드 중 카메라 이동) 시 씬 정리를 건너뜀.
      //       새 노드가 씬에 추가되지 않은 상태에서 기존 노드를 제거하면
      //       다음 _updateLoD가 완료될 때까지 빈 화면이 나타나기 때문.
      //       cleanup 및 최종 emit은 다음 _updateLoD(_pendingUpdate)가 담당.
      if (gen === this._loadGen) {
        // 5. 비대상 노드를 씬에서 제거 (show=false 대신 primitives.remove).
        //    collection 객체는 캐시에 유지되므로 재진입 시 primitives.add만 하면 된다.
        //    씬에서 제거하면 Cesium 업데이트 루프 대상에서 빠져 프레임 부하가 줄어든다.
        for (const [key, data] of this._cache) {
          if (!targetSet.has(key) && this._inScene.has(key)) {
            this._container.remove(data.collection);
            this._inScene.delete(key);
          }
        }

        // 6. LRU eviction
        this._evict(targetSet);

        // 7. targetSet 최종 프러스텀 동기화
        //    (로드 중 카메라 이동 시 현재 시점 기준으로 재확인)
        const cv2 = getCullingVolume(camera);
        for (const key of targetSet) {
          const data = this._cache.get(key);
          if (data) data.collection.show = isInFrustum(getSphere(key), cv2);
        }

        const visiblePoints = [...targetSet]
          .filter(k => this._cache.has(k))
          .reduce((s, k) => s + this._cache.get(k).pointCount, 0);

        this._emit({ depth: maxDepth, visible: visibleKeys.length, culled,
          loading: 0, points: visiblePoints, cached: this._cache.size, height });
      } else {
        // gen 불일치: 씬에 있는 노드는 건드리지 않고 캐시 초과분만 정리.
        // keepSet = 현재 씬에 있는 노드 → 보이는 노드는 evict 대상에서 제외.
        this._evict(this._inScene);
      }

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
        // 이미 step 5에서 씬에서 제거됐지만 혹시 남아있으면 정리
        if (this._inScene.has(k)) {
          this._container.remove(d.collection);
          this._inScene.delete(k);
        }
        d.collection.destroy();
        this._cache.delete(k);
      });
  }

  async _runConcurrent(tasks) {
    // concurrency 수만큼만 동시에 실행 — loadNode는 pool.run 전에도
    // Float64Array × 3 + Float32Array × 3 를 할당하므로 동시 시작 수를
    // 반드시 제한해야 OOM을 막을 수 있음.
    // A-1: task 별 try/catch — 하나 실패해도 나머지 계속 실행.
    const limit   = this._opts.concurrency;
    const running = new Set();
    for (const task of tasks) {
      const p = Promise.resolve().then(task).catch(err => {
        console.warn('[CopcDataSource] 노드 로드 실패:', err);
      }).finally(() => running.delete(p));
      running.add(p);
      if (running.size >= limit) await Promise.race(running);
    }
    if (running.size > 0) await Promise.all(running);
  }

  _startListening() {
    let prevHeight = this._viewer.camera.positionCartographic.height;
    let lastLodMs  = 0;

    // 매 프레임: 현재 시점 기준 프러스텀 갱신 + 200ms 간격 LoD 재계산.
    // camera.changed 는 위치·방향 변화가 임계치(~1%, ~8°) 초과 시에만 발동해
    // 소폭 회전(Ctrl+드래그)을 놓치는 문제가 있었으므로 scene.postUpdate로 교체.
    this._removePostUpdateListener = this._viewer.scene.postUpdate.addEventListener(() => {
      if (this._destroyed) return;

      const h = this._viewer.camera.positionCartographic.height;
      if (h > prevHeight) this._loadGen++; // 줌아웃 → 진행 중 로드 무효화
      prevHeight = h;

      if (!this._isUpdating) this._updateVisibility();

      // LoD 재계산: 최대 5fps(200ms) 제한 — 매 프레임 실행은 불필요
      const now = Date.now();
      if (now - lastLodMs >= 200) {
        lastLodMs = now;
        this._updateLoD();
      }
    });

    // 카메라 완전 정지 시 즉시 최종 갱신 (200ms 인터벌과 무관하게 보장)
    this._removeMoveEndListener = this._viewer.camera.moveEnd.addEventListener(() => {
      if (this._destroyed) return;
      lastLodMs = Date.now();
      this._updateLoD();
    });
  }

  _emit(info) {
    if (this._onProgress) this._onProgress({ ...info, seenClasses: this._seenClasses });
  }

  // ── 공개 API ────────────────────────────────────────────────

  /** 진행 상황 콜백. { depth, visible, culled, loading, points, cached, height, seenClasses } */
  set onProgress(fn) { this._onProgress = fn; }
  get onProgress()   { return this._onProgress; }

  /** 점 크기 px — 즉시 반영 (재로드 불필요) */
  set pixelSize(v)   { this._pixelSizeRef.value = v; }
  get pixelSize()    { return this._pixelSizeRef.value; }

  /** 고도 보정 오프셋 m — 셰이더 즉시 반영 */
  set heightOffset(v) { this._heightOffsetRef.value = v; }
  get heightOffset()  { return this._heightOffsetRef.value; }

  /** SSE 임계값 px — 높을수록 덜 세밀(빠름), 낮을수록 더 세밀(느림). _updateLoD 즉시 재실행. */
  set sseThreshold(v) {
    this._opts.sseThreshold = v;
    this._updateLoD();
  }
  get sseThreshold()  { return this._opts.sseThreshold; }

  /**
   * 분류 필터 마스크 설정 — 즉시 반영.
   * 비트 N이 1이면 클래스 N 표시, 0이면 숨김.
   * -1(기본값)이면 전체 표시.
   * @param {number} mask 32비트 정수
   */
  setClassMask(mask) { this._classMaskRef.value = mask; }

  /** 지금까지 로드된 노드에서 발견된 분류값 집합 */
  get seenClasses()   { return this._seenClasses; }

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
    this._destroyed = true; // A-3: 이후 _updateLoD 재진입 차단
    if (this._removePostUpdateListener) this._removePostUpdateListener();
    if (this._removeMoveEndListener)    this._removeMoveEndListener();
    this._pool.destroy();
    for (const data of this._cache.values()) {
      data.collection.destroy();
    }
    this._cache.clear();
    this._inScene.clear();
    // scene.primitives.destroyPrimitives 가 기본 true 이므로
    // remove() 가 _container.destroy() 를 자동 호출한다.
    // 수동 destroy() 를 추가로 호출하면 이중 파괴 오류가 발생하므로 제거.
    this._viewer.scene.primitives.remove(this._container);
  }
}
