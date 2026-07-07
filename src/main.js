import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Copc } from 'copc';
import proj4 from 'proj4';

// ── 상태 표시 ──────────────────────────────────────────────
const statusEl = document.getElementById('status');
function log(msg) {
  statusEl.innerHTML = msg;
  console.log(msg.replace(/<[^>]+>/g, ''));
}

// ── CesiumJS 초기화 ────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
});

const points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

// ── 좌표계 정의 ────────────────────────────────────────────
// Autzen: NAD83 / Oregon GIC Lambert (ft) → EPSG:2992
proj4.defs('EPSG:2992',
  '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
  ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs'
);

// ── COPC 로드 ──────────────────────────────────────────────
const COPC_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

async function main() {
  log('📡 COPC 파일 초기화 중...');
  const copc = await Copc.create(COPC_URL);

  log('🗂️ 계층 페이지 로드 중...');
  const { nodes } = await Copc.loadHierarchyPage(COPC_URL, copc.info.rootHierarchyPage);

  log('📦 루트 노드 점 데이터 로드 중...');
  const view = await Copc.loadPointDataView(COPC_URL, copc, nodes['0-0-0-0']);

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');

  log(`🔄 좌표 변환 + 렌더링 중...<br>점 수: <b>${view.pointCount.toLocaleString()}</b>개`);

  for (let i = 0; i < view.pointCount; i++) {
    const [lon, lat] = proj4('EPSG:2992', 'EPSG:4326', [getX(i), getY(i)]);
    const alt = getZ(i) * 0.3048;

    points.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      pixelSize: 2,
      color: new Cesium.Color(getR(i) / 65535, getG(i) / 65535, getB(i) / 65535, 1.0),
    });
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-123.069, 44.057, 3000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-45),
      roll: 0,
    },
  });

  log(`✅ 완료!<br>렌더링된 점: <b>${view.pointCount.toLocaleString()}</b>개<br>노드: 루트(0-0-0-0)`);
}

main().catch((err) => {
  log(`❌ 오류: ${err.message}`);
  console.error(err);
});
