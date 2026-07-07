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

// ── 프리셋 데이터셋 ────────────────────────────────────────
const PRESETS = {
  autzen: {
    label:       'Autzen Stadium',
    url:         'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    proj:        'EPSG:2992',
    projDef:     '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
                 ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
    geoidOffset: -20,
  },
  sofi: {
    label:       'Sofia (Bulgaria)',
    url:         'https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz',
    proj:        'EPSG:4326',
    projDef:     null,
    geoidOffset: 0,
  },
  lyon: {
    label:       'Lyon (France)',
    url:         'https://s3.amazonaws.com/hobu-lidar/lyon.copc.laz',
    proj:        'EPSG:4326',
    projDef:     null,
    geoidOffset: 0,
  },
};

// ── UI 요소 ────────────────────────────────────────────────
const statusEl      = document.getElementById('status');
const urlInput      = document.getElementById('urlInput');
const loadBtn       = document.getElementById('loadBtn');
const satelliteBtn  = document.getElementById('satelliteBtn');
const presetBtns    = document.querySelectorAll('.preset-btn');

// ── 현재 로드된 데이터소스 ─────────────────────────────────
let currentDs        = null;
let activePreset     = null;   // 현재 활성화된 프리셋 key
let activePresetOpts = null;   // 활성 프리셋의 옵션 (불러오기 버튼에서 재사용)

// ── 위성지도 토글 ──────────────────────────────────────────
let satelliteOn = true;

satelliteBtn.addEventListener('click', () => {
  satelliteOn = !satelliteOn;
  viewer.imageryLayers.get(0).show = satelliteOn;
  satelliteBtn.textContent  = satelliteOn ? '🛰 위성지도 ON' : '🌑 위성지도 OFF';
  satelliteBtn.className    = 'ctrl-btn ' + (satelliteOn ? 'on' : 'off');
});

// ── 데이터 로드 함수 ───────────────────────────────────────
let _loadingController = null;  // 중복 로드 방지용

async function loadCopc(url, opts = {}) {
  if (!url.trim()) return;

  // 진행 중인 로드가 있으면 즉시 중단 표시 (새 로드 우선)
  if (_loadingController) {
    _loadingController.abort = true;
  }
  const ctrl = { abort: false };
  _loadingController = ctrl;

  // 기존 데이터소스 정리
  if (currentDs) {
    currentDs.destroy();
    currentDs = null;
  }

  loadBtn.disabled = true;
  statusEl.innerHTML = '📡 COPC 파일 초기화 중...';

  try {
    const ds = await CopcDataSource.load(url.trim(), viewer, {
      proj:          opts.proj        ?? 'EPSG:4326',
      projDef:       opts.projDef     ?? null,
      geoidOffset:   opts.geoidOffset ?? 0,
      concurrency:   5,
      debounceMs:    300,
      maxCacheNodes: 40,
      pixelSize:     2,
    });

    // 로드 완료 전에 다른 로드가 시작됐으면 이 결과 파기
    if (ctrl.abort) {
      ds.destroy();
      return;
    }

    currentDs = ds;

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
  } catch (err) {
    if (!ctrl.abort) {
      statusEl.innerHTML = `❌ 오류: ${err.message}`;
      console.error(err);
    }
  } finally {
    if (!ctrl.abort) loadBtn.disabled = false;
    if (_loadingController === ctrl) _loadingController = null;
  }
}

// ── URL 직접 입력 로드 ─────────────────────────────────────
loadBtn.addEventListener('click', () => {
  // 활성 프리셋이 있으면 해당 옵션 유지, 없으면 기본값
  const opts = activePresetOpts ?? {};
  setActivePreset(null);
  loadCopc(urlInput.value, opts);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadBtn.click();
});

// URL 을 직접 수정하면 프리셋 옵션 초기화
urlInput.addEventListener('input', () => {
  setActivePreset(null);
});

// ── 프리셋 버튼 ────────────────────────────────────────────
function setActivePreset(key) {
  activePreset     = key;
  activePresetOpts = key ? PRESETS[key] : null;
  presetBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === key);
  });
}

presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.preset;
    const preset = PRESETS[key];
    if (!preset) return;

    setActivePreset(key);
    urlInput.value = preset.url;
    loadCopc(preset.url, preset);
  });
});

// ── 초기 로드: Autzen 프리셋 ──────────────────────────────
setActivePreset('autzen');
urlInput.value = PRESETS.autzen.url;
loadCopc(PRESETS.autzen.url, PRESETS.autzen);
