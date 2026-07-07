import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Copc } from 'copc';
import proj4 from 'proj4';

// ── 설정 ───────────────────────────────────────────────────
const CONCURRENCY = 5;
const DEBOUNCE_MS = 300;
const MAX_CACHE_NODES = 80; // GPU에 유지할 최대 노드 수 (LRU eviction)
// 지오이드 보정: COPC Z(NAVD88 정표고) → CesiumJS(WGS84 타원체고)
// 오레곤 오이진 지역 EGM96 지오이드 보정값 ≈ -20m (지형과 맞지 않으면 조정)
const GEOID_OFFSET = -20;

// height: 카메라 고도(m), maxDepth: 실제 데이터의 최대 깊이
function heightToDepth(height, maxDepth) {
  const HIGH = 8000; // 이 고도 이상 → depth 0
  const LOW  = 150;  // 이 고도 이하 → maxDepth
  if (height >= HIGH) return 0;
  if (height <= LOW)  return maxDepth;
  // 로그 스케일: 고도가 낮을수록 깊이가 깊어짐
  const t = Math.log(height / LOW) / Math.log(HIGH / LOW); // 1(높음)→0(낮음)
  return Math.round((1 - t) * maxDepth);
}

// ── 상태 표시 ──────────────────────────────────────────────
const statusEl = document.getElementById('status');
function log(msg) { statusEl.innerHTML = msg; }

// ── CesiumJS 초기화 ────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false,
  animation: false, timeline: false, fullscreenButton: false,
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

// ── 좌표계 정의 ────────────────────────────────────────────
proj4.defs('EPSG:2992',
  '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
  ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs'
);

// ── 노드 키에서 depth 추출 ─────────────────────────────────
function getDepth(key) { return parseInt(key.split('-')[0]); }

// ── 동시 실행 제한 ─────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) await tasks[index++]();
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

// ── 노드 바운딩 스피어 계산 ────────────────────────────────
// COPC Octree에서 각 노드의 공간 범위를 계산하고 CesiumJS BoundingSphere로 변환
function getNodeBoundingSphere(key, rootCenter, rootHalfSize) {
  const [level, xi, yi, zi] = key.split('-').map(Number);
  const nodeHalfSize = rootHalfSize / Math.pow(2, level);

  // 노드 중심 = 루트 최소점 + 격자 인덱스로 이동
  const cx = rootCenter.x - rootHalfSize + (2 * xi + 1) * nodeHalfSize;
  const cy = rootCenter.y - rootHalfSize + (2 * yi + 1) * nodeHalfSize;
  const cz = rootCenter.z - rootHalfSize + (2 * zi + 1) * nodeHalfSize;

  // COPC 좌표(Oregon Lambert ft) → WGS84
  const [lon, lat] = proj4('EPSG:2992', 'EPSG:4326', [cx, cy]);
  const altMeters = cz * 0.3048;

  const center = Cesium.Cartesian3.fromDegrees(lon, lat, altMeters);
  // 정육면체의 대각선 절반 = halfSize * √3 (보수적으로 구로 감싸기)
  const radius = nodeHalfSize * 0.3048 * Math.sqrt(3);

  return new Cesium.BoundingSphere(center, radius);
}

// ── 프러스텀 컬링 볼륨 계산 (매 호출마다 새로 계산) ────────
function getCullingVolume() {
  return viewer.camera.frustum.computeCullingVolume(
    viewer.camera.position,
    viewer.camera.direction,
    viewer.camera.up
  );
}

function isNodeInFrustum(boundingSphere, cullingVolume) {
  return cullingVolume.computeVisibility(boundingSphere) !== Cesium.Intersect.OUTSIDE;
}

// ── 빠른 경로: 캐시된 노드의 show/hide만 즉시 갱신 (네트워크 요청 없음) ──
function updateVisibility(rootCenter, rootHalfSize) {
  const cv = getCullingVolume();
  for (const [key, data] of nodeCache) {
    const sphere = getNodeBoundingSphere(key, rootCenter, rootHalfSize);
    data.collection.show = isNodeInFrustum(sphere, cv);
  }
}

// ── 노드 로드 및 렌더링 ────────────────────────────────────
async function loadNode(url, copc, nodeInfo) {
  const view = await Copc.loadPointDataView(url, copc, nodeInfo);

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');

  const collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

  for (let i = 0; i < view.pointCount; i++) {
    const [lon, lat] = proj4('EPSG:2992', 'EPSG:4326', [getX(i), getY(i)]);
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, getZ(i) * 0.3048 + GEOID_OFFSET),
      pixelSize: 2,
      color: new Cesium.Color(getR(i) / 65535, getG(i) / 65535, getB(i) / 65535, 1.0),
    });
  }

  return { collection, pointCount: view.pointCount, lastUsed: Date.now() };
}

// ── LoD + 프러스텀 컬링 + 캐싱 ───────────────────────────
const COPC_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

// nodeCache: 로드된 모든 노드 보관 (GPU 메모리 유지, show/hide로 제어)
// key → { collection, pointCount, lastUsed }
const nodeCache = new Map();
let isUpdating = false;
let pendingUpdate = false;

async function updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth) {
  if (isUpdating) { pendingUpdate = true; return; }
  isUpdating = true;

  const height = viewer.camera.positionCartographic.height;
  const targetDepth = heightToDepth(height, maxDepth);

  // 1. 목표 깊이 노드 후보 선택
  let candidates = Object.keys(nodes).filter(
    k => getDepth(k) === targetDepth && nodes[k].pointCount > 0
  );

  // fallback: 해당 깊이에 노드 없으면 더 얕은 깊이
  if (candidates.length === 0) {
    for (let d = targetDepth - 1; d >= 0; d--) {
      candidates = Object.keys(nodes).filter(
        k => getDepth(k) === d && nodes[k].pointCount > 0
      );
      if (candidates.length > 0) break;
    }
  }

  // 2. 프러스텀 컬링: 시야 밖 노드 제거 (cullingVolume 한 번만 계산)
  const cv = getCullingVolume();
  const visibleKeys = candidates.filter(key => {
    const sphere = getNodeBoundingSphere(key, rootCenter, rootHalfSize);
    return isNodeInFrustum(sphere, cv);
  });

  const targetSet = new Set(visibleKeys);
  const culled = candidates.length - visibleKeys.length;

  // 3. 캐시 히트: 재로드 없이 바로 표시 + lastUsed 갱신
  const toLoad = [];
  for (const key of visibleKeys) {
    if (nodeCache.has(key)) {
      const data = nodeCache.get(key);
      data.collection.show = true;
      data.lastUsed = Date.now();
    } else {
      toLoad.push(key);
    }
  }

  const cacheHits = visibleKeys.length - toLoad.length;
  log(`🔄 깊이 ${targetDepth} 로딩 중... (캐시 히트 ${cacheHits}개)<br>
    신규 로드: <b>${toLoad.length}</b>개 | 고도: <b>${Math.round(height)}m</b>`);

  // 4. 캐시 미스: 화면 중앙에 가까운 노드부터 로드
  //    카메라 방향 벡터와 노드 중심 벡터의 dot product가 클수록 중앙에 가까움
  const camPos = viewer.camera.position;
  const camDir = viewer.camera.direction;
  toLoad.sort((a, b) => {
    const sA = getNodeBoundingSphere(a, rootCenter, rootHalfSize);
    const sB = getNodeBoundingSphere(b, rootCenter, rootHalfSize);
    const vA = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(sA.center, camPos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const vB = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(sB.center, camPos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    return Cesium.Cartesian3.dot(vB, camDir) - Cesium.Cartesian3.dot(vA, camDir);
  });

  let loaded = 0;
  await runWithConcurrency(
    toLoad.map(key => async () => {
      const data = await loadNode(COPC_URL, copc, nodes[key]);
      nodeCache.set(key, data);
      loaded++;
      log(`🔄 깊이 ${targetDepth} 로딩 중... ${loaded}/${toLoad.length}<br>
        고도: <b>${Math.round(height)}m</b>`);
    }),
    CONCURRENCY
  );

  // 5. 로딩 완료 후 targetSet에 없는 노드만 숨기기 (로딩 중엔 이전 노드 유지)
  for (const [key, data] of nodeCache) {
    if (!targetSet.has(key)) {
      data.collection.show = false;
    }
  }

  // 6. LRU eviction: 현재 보이지 않는 노드 중 오래된 것 제거
  if (nodeCache.size > MAX_CACHE_NODES) {
    const evictCount = nodeCache.size - MAX_CACHE_NODES;
    const evictCandidates = [...nodeCache.entries()]
      .filter(([key]) => !targetSet.has(key))          // 현재 보이는 것 제외
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);  // 오래된 순 정렬
    for (const [key, data] of evictCandidates.slice(0, evictCount)) {
      viewer.scene.primitives.remove(data.collection);
      nodeCache.delete(key);
    }
  }

  const visiblePoints = visibleKeys
    .filter(k => nodeCache.has(k))
    .reduce((s, k) => s + nodeCache.get(k).pointCount, 0);

  log(`✅ 깊이: <b>${targetDepth}</b> | 표시: <b>${visibleKeys.length}</b>개 (컬링 ${culled}개)<br>
    점: <b>${visiblePoints.toLocaleString()}</b>개 | 캐시: ${nodeCache.size}/${MAX_CACHE_NODES} | 고도: <b>${Math.round(height)}m</b>`);

  // updateLoD 완료 후 최종 프러스텀 상태 동기화
  updateVisibility(rootCenter, rootHalfSize);

  isUpdating = false;
  if (pendingUpdate) {
    pendingUpdate = false;
    updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth);
  }
}

// ── 메인 ───────────────────────────────────────────────────
async function main() {
  log('📡 COPC 파일 초기화 중...');
  const copc = await Copc.create(COPC_URL);

  // copc.info 구조 확인
  console.log('copc.info:', JSON.stringify(copc.info, null, 2));

  // copc.info.cube = [minx, miny, minz, maxx, maxy, maxz] 형식
  const [minx, miny, minz, maxx, maxy, maxz] = copc.info.cube;
  const rootCenter = {
    x: (minx + maxx) / 2,
    y: (miny + maxy) / 2,
    z: (minz + maxz) / 2,
  };
  const rootHalfSize = (maxx - minx) / 2;
  console.log('rootCenter:', rootCenter, 'rootHalfSize:', rootHalfSize);

  log('🗂️ 계층 페이지 로드 중...');
  const { nodes } = await Copc.loadHierarchyPage(COPC_URL, copc.info.rootHierarchyPage);
  const maxDepth = Math.max(...Object.keys(nodes).map(getDepth));
  console.log('총 노드 수:', Object.keys(nodes).length, '| 최대 깊이:', maxDepth);

  // 루트 노드 바운딩 스피어로 flyToBoundingSphere → 데이터 중심을 정확히 바라봄
  const rootSphere = getNodeBoundingSphere('0-0-0-0', rootCenter, rootHalfSize);
  await new Promise(resolve => {
    viewer.camera.flyToBoundingSphere(rootSphere, {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-45),
        rootSphere.radius * 4,
      ),
      complete: resolve,
    });
  });

  await updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth);

  // 카메라 변화 감도 높이기 (기본값 0.5 → 0.01)
  viewer.camera.percentageChanged = 0.01;

  let debounceTimer = null;
  viewer.camera.changed.addEventListener(() => {
    // 빠른 경로: updateLoD 실행 중이 아닐 때만 show/hide 갱신
    // (실행 중 호출 시 방금 로드한 노드를 덮어쓰는 race condition 방지)
    if (!isUpdating) {
      updateVisibility(rootCenter, rootHalfSize);
    }
    // 느린 경로: 디바운스 후 새 노드 로드
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(
      () => updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth),
      DEBOUNCE_MS
    );
  });
}

main().catch((err) => {
  log(`❌ 오류: ${err.message}`);
  console.error(err);
});
