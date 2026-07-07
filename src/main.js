import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Copc } from 'copc';
import proj4 from 'proj4';

// ── 설정 ───────────────────────────────────────────────────
const CONCURRENCY = 5;
const DEBOUNCE_MS = 300;

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

// ── 프러스텀 컬링: 노드가 카메라 시야 안에 있는지 확인 ──────
function isNodeInFrustum(boundingSphere) {
  const cullingVolume = viewer.camera.frustum.computeCullingVolume(
    viewer.camera.position,
    viewer.camera.direction,
    viewer.camera.up
  );
  return cullingVolume.computeVisibility(boundingSphere) !== Cesium.Intersect.OUTSIDE;
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
      position: Cesium.Cartesian3.fromDegrees(lon, lat, getZ(i) * 0.3048),
      pixelSize: 2,
      color: new Cesium.Color(getR(i) / 65535, getG(i) / 65535, getB(i) / 65535, 1.0),
    });
  }

  return { collection, pointCount: view.pointCount };
}

// ── LoD + 프러스텀 컬링 ────────────────────────────────────
const COPC_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

const loadedNodes = new Map();
let currentDepth = -1;
let isUpdating = false;
let pendingUpdate = false;

async function updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth) {
  if (isUpdating) { pendingUpdate = true; return; }
  isUpdating = true;

  const height = viewer.camera.positionCartographic.height;
  const targetDepth = heightToDepth(height, maxDepth);
  currentDepth = targetDepth;

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

  // 2. 프러스텀 컬링: 시야 밖 노드 제거
  const visibleKeys = candidates.filter(key => {
    const sphere = getNodeBoundingSphere(key, rootCenter, rootHalfSize);
    return isNodeInFrustum(sphere);
  });

  const targetSet = new Set(visibleKeys);
  const culled = candidates.length - visibleKeys.length;

  log(`🔄 깊이 ${targetDepth} 로딩 중...<br>
    시야 내 노드: <b>${visibleKeys.length}</b>개 (컬링: ${culled}개 제거)<br>
    고도: <b>${Math.round(height)}m</b>`);

  // 3. 시야 밖으로 나간 노드 제거
  for (const [key, data] of loadedNodes) {
    if (!targetSet.has(key)) {
      viewer.scene.primitives.remove(data.collection);
      loadedNodes.delete(key);
    }
  }

  // 4. 새로 보이는 노드 로드
  const toLoad = visibleKeys.filter(k => !loadedNodes.has(k));
  let loaded = 0;

  await runWithConcurrency(
    toLoad.map(key => async () => {
      const data = await loadNode(COPC_URL, copc, nodes[key]);
      loadedNodes.set(key, data);
      loaded++;
      log(`🔄 깊이 ${targetDepth} 로딩 중... ${loaded}/${toLoad.length}<br>
        고도: <b>${Math.round(height)}m</b>`);
    }),
    CONCURRENCY
  );

  const totalPoints = [...loadedNodes.values()].reduce((s, d) => s + d.pointCount, 0);
  log(`✅ 깊이: <b>${targetDepth}</b> | 노드: <b>${loadedNodes.size}</b>개 (컬링 ${culled}개)<br>
    점: <b>${totalPoints.toLocaleString()}</b>개 | 고도: <b>${Math.round(height)}m</b>`);

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

  await viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-123.069, 44.057, 15000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-45),
      roll: 0,
    },
  });

  await updateLoD(copc, nodes, rootCenter, rootHalfSize, maxDepth);

  let debounceTimer = null;
  viewer.camera.changed.addEventListener(() => {
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
