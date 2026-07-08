import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CopcDataSource } from './lib/CopcDataSource.js';

// ── CesiumJS 초기화 ────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker:      false,  // 커스텀 레이어 UI와 충돌
  sceneModePicker:      false,  // 2D 모드에서 포인트 클라우드 미지원
  animation:            false,  // 시계 애니메이션 불필요
  timeline:             false,  // 타임라인 불필요
  geocoder:             true,
  homeButton:           true,
  navigationHelpButton: true,
  fullscreenButton:     true,
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
    label:       'SoFi Stadium',
    url:         'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
    geoidOffset: 0,
  },
  trestle: {
    label:       'Trestle Bridge',
    url:         'https://s3.amazonaws.com/grid-public-ept/20210421-FLW-Trestle-low-attitude.copc.laz',
    geoidOffset: 0,
  },
};

// ── UI 요소 ────────────────────────────────────────────────
const statusEl          = document.getElementById('status');
const urlInput          = document.getElementById('urlInput');
const loadBtn           = document.getElementById('loadBtn');
const layerSelect       = document.getElementById('layerSelect');
const pixelSizeSlider   = document.getElementById('pixelSizeSlider');
const pixelSizeVal      = document.getElementById('pixelSizeVal');
const classSidebar      = document.getElementById('classSidebar');
const classToggleBtn    = document.getElementById('classToggleBtn');
const allClassCheck     = document.getElementById('allClassCheck');
const classCheckboxes   = document.getElementById('classCheckboxes');
const presetBtns        = document.querySelectorAll('.preset-btn');

// ── 현재 로드된 데이터소스 ─────────────────────────────────
let currentDs        = null;
let activePreset     = null;   // 현재 활성화된 프리셋 key
let activePresetOpts = null;   // 활성 프리셋의 옵션 (불러오기 버튼에서 재사용)

// ── 지도 레이어 선택 ───────────────────────────────────────
layerSelect.addEventListener('change', async () => {
  const type = layerSelect.value;
  viewer.imageryLayers.removeAll();
  if (type === 'satellite') {
    const provider = await Cesium.IonImageryProvider.fromAssetId(2);
    viewer.imageryLayers.addImageryProvider(provider);
  } else if (type === 'osm') {
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
    );
  }
  // type === 'none': removeAll()로 이미 제거됨
});

// ── 점 크기 슬라이더 ───────────────────────────────────────
pixelSizeSlider.addEventListener('input', () => {
  const v = parseFloat(pixelSizeSlider.value);
  pixelSizeVal.textContent = v;
  if (currentDs) currentDs.pixelSize = v;
});

// ── 분류 필터 ──────────────────────────────────────────────
const ASPRS_NAMES = {
  0: '미분류(0)', 1: '미분류(1)', 2: '지면', 3: '낮은 식생',
  4: '중간 식생', 5: '높은 식생', 6: '건물', 7: '잡음(저점)',
  8: '예약(8)', 9: '수면', 10: '철도', 11: '도로면',
  12: '중첩점', 13: '와이어(가드)', 14: '와이어(전선)',
  15: '송전탑', 16: '와이어(연결)', 17: '브리지', 18: '잡음(고점)',
};

let _renderedClasses = new Set(); // 현재 체크박스가 만들어진 클래스 집합

function updateClassMask() {
  if (!currentDs) return;
  // "전체 선택" 상태면 -1 사용: 아직 발견 안 된 클래스도 자동 표시
  if (allClassCheck.checked) {
    currentDs.setClassMask(-1);
    return;
  }
  const checks = classCheckboxes.querySelectorAll('.cls-check');
  let mask = 0;
  checks.forEach(cb => {
    if (cb.checked) mask |= (1 << parseInt(cb.dataset.cls, 10));
  });
  currentDs.setClassMask(mask);
}

function refreshClassPanel(seenClasses) {
  if (!seenClasses || seenClasses.size === 0) return;

  // 새로 발견된 클래스만 추가 (기존 체크박스 유지)
  let changed = false;
  for (const c of seenClasses) {
    if (!_renderedClasses.has(c)) { _renderedClasses.add(c); changed = true; }
  }
  if (!changed) return;

  // 오름차순 재정렬
  const sorted = [..._renderedClasses].sort((a, b) => a - b);
  classCheckboxes.innerHTML = '';
  for (const c of sorted) {
    const label = ASPRS_NAMES[c] ?? `클래스 ${c}`;
    const row = document.createElement('div');
    row.className = 'cls-row';
    row.innerHTML =
      `<input type="checkbox" class="cls-check" id="cls${c}" data-cls="${c}" checked>` +
      `<label for="cls${c}">${label}</label>`;
    classCheckboxes.appendChild(row);
  }
  classCheckboxes.querySelectorAll('.cls-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const checks = classCheckboxes.querySelectorAll('.cls-check');
      const allChecked = [...checks].every(c => c.checked);
      allClassCheck.checked = allChecked;
      updateClassMask();
    });
  });

  // 클래스가 2개 이상일 때만 토글 탭 표시
  classToggleBtn.style.display = sorted.length > 1 ? '' : 'none';

  // 사용자가 커스텀 필터 중이면 새로 발견된 클래스를 마스크에 반영
  if (!allClassCheck.checked) updateClassMask();
}

allClassCheck.addEventListener('change', () => {
  const checked = allClassCheck.checked;
  classCheckboxes.querySelectorAll('.cls-check').forEach(cb => { cb.checked = checked; });
  updateClassMask();
});

// ── 분류 필터 사이드바 토글 ────────────────────────────────
classToggleBtn.style.display = 'none'; // 데이터 로드 전엔 숨김
classToggleBtn.addEventListener('click', () => {
  const isOpen = classSidebar.classList.toggle('open');
  classToggleBtn.classList.toggle('open', isOpen);
  classToggleBtn.textContent = isOpen ? '닫기' : '필터';
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

  // 분류 필터 초기화
  classSidebar.classList.remove('open');
  classToggleBtn.classList.remove('open');
  classToggleBtn.textContent = '필터';
  classToggleBtn.style.display = 'none';
  classCheckboxes.innerHTML = '';
  allClassCheck.checked = true;
  _renderedClasses = new Set();

  loadBtn.disabled = true;
  statusEl.innerHTML = '📡 COPC 파일 초기화 중...';

  try {
    const ds = await CopcDataSource.load(url.trim(), viewer, {
      proj:          opts.proj        ?? 'EPSG:4326',
      projDef:       opts.projDef     ?? null,
      geoidOffset:   opts.geoidOffset ?? 0,
      concurrency:   5,
      maxCacheNodes: 150, // B-5: maxVisibleNodes(100)보다 크게 유지해야 eviction 동작
      pixelSize:     parseFloat(pixelSizeSlider.value),
    });

    // 로드 완료 전에 다른 로드가 시작됐으면 이 결과 파기
    if (ctrl.abort) {
      ds.destroy();
      return;
    }

    currentDs = ds;

    ds.onProgress = ({ depth, visible, culled, loading, points, cached, height, seenClasses }) => {
      refreshClassPanel(seenClasses);
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
