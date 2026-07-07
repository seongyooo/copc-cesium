import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CopcDataSource } from './lib/CopcDataSource.js';

// ── CesiumJS 초기화 ────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false,
  animation: false, timeline: false, fullscreenButton: false,
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

// ── 상태 표시 ──────────────────────────────────────────────
const statusEl = document.getElementById('status');

// ── 메인 ───────────────────────────────────────────────────
const COPC_URL   = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const EPSG_2992  = '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
                   ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs';

async function main() {
  statusEl.innerHTML = '📡 COPC 파일 초기화 중...';

  // projDef를 전달하면 CopcDataSource가 메인 스레드 + Worker 양쪽에 등록
  const ds = await CopcDataSource.load(COPC_URL, viewer, {
    proj:          'EPSG:2992',
    projDef:       EPSG_2992,
    geoidOffset:   -20,
    concurrency:   5,
    debounceMs:    300,
    maxCacheNodes: 80,
    pixelSize:     2,
  });

  ds.onProgress = ({ depth, visible, culled, loading, points, cached, height }) => {
    if (loading > 0) {
      statusEl.innerHTML =
        `🔄 깊이 ${depth} 로딩 중... (남은: ${loading}개)<br>` +
        `고도: <b>${Math.round(height)}m</b>`;
    } else {
      statusEl.innerHTML =
        `✅ 깊이: <b>${depth}</b> | 표시: <b>${visible}</b>개 (컬링 ${culled}개)<br>` +
        `점: <b>${(points ?? 0).toLocaleString()}</b>개 | ` +
        `캐시: ${cached}/${ds.maxCacheNodes} | ` +
        `고도: <b>${Math.round(height)}m</b>`;
    }
  };
}

main().catch(err => {
  statusEl.innerHTML = `❌ 오류: ${err.message}`;
  console.error(err);
});
