import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CopcDataSource } from './lib/CopcDataSource.js';

// ── CesiumJS 초기화 ────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker:      false,
  sceneModePicker:      false,
  animation:            false,
  timeline:             false,
  geocoder:             false,
  homeButton:           false,
  navigationHelpButton: false,
  fullscreenButton:     false,
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

// Cesium 크레딧 컨테이너를 우리 UI와 겹치지 않게 처리
viewer.cesiumWidget.creditContainer.style.display = 'none';

// ── 프리셋 데이터셋 ────────────────────────────────────────
const PRESETS = {
  autzen: {
    label:       'Autzen Stadium',
    pts:         '10.7M',
    url:         'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    proj:        'EPSG:2992',
    projDef:     '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
                 ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
    geoidOffset: -20,
  },
  sofi: {
    label:       'SoFi Stadium',
    pts:         '18.4M',
    url:         'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
    geoidOffset: 0,
  },
  trestle: {
    label:       'Trestle Bridge',
    pts:         '2.2M',
    url:         'https://s3.amazonaws.com/grid-public-ept/20210421-FLW-Trestle-low-attitude.copc.laz',
    geoidOffset: 0,
  },
  sandiego: {
    label: 'San Diego 2005',
    pts:   '—',
    url:   '/sandiego.copc.laz',
  },
  saltcreek: {
    label:       'Salt Creek SfM (RGB)',
    pts:         '—',
    url:         '/sfm_saltcreek.copc.laz',
    proj:        'EPSG:32612',
    projDef:     '+proj=utm +zone=12 +datum=WGS84 +units=m +no_defs',
    geoidOffset: 0,
    zFactor:     1.0,
  },
  nztm: {
    label:       'New Zealand (NZTM2000)',
    pts:         '—',
    url:         '/points_2.copc.laz',
    proj:        'EPSG:2193',
    projDef:     '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs',
    geoidOffset: 0,
    zFactor:     1.0,
  },
};

// ── UI 요소 참조 ───────────────────────────────────────────
const app           = document.getElementById('app');
const panel         = document.getElementById('panel');
const collapseBtn   = document.getElementById('collapseBtn');
const panelTitle    = document.getElementById('panelTitle');
const presetList    = document.getElementById('presetList');
const presetCount   = document.getElementById('presetCount');
const urlInput      = document.getElementById('urlInput');
const loadBtn       = document.getElementById('loadBtn');

const sseSlider     = document.getElementById('sseSlider');
const sseDisplay    = document.getElementById('sseDisplay');
const terrainSelect = document.getElementById('terrainSelect');
const imagerySelect = document.getElementById('imagerySelect');

const colorModeGrid  = document.getElementById('colorModeGrid');
const opacitySlider  = document.getElementById('opacitySlider');
const opacityDisplay = document.getElementById('opacityDisplay');

const filterAllRow   = document.getElementById('filterAllRow');
const filterAllCheck = document.getElementById('filterAllCheck');
const classFilterList = document.getElementById('classFilterList');

const pixelSizeSlider   = document.getElementById('pixelSizeSlider');
const pixelSizeDisplay  = document.getElementById('pixelSizeDisplay');
const heightOffsetInput = document.getElementById('heightOffsetInput');

const infoName   = document.getElementById('infoName');
const infoMeta   = document.getElementById('infoMeta');
const infoStatus = document.getElementById('infoStatus');

const chipDot  = document.getElementById('chipDot');
const chipName = document.getElementById('chipName');
const chipPts  = document.getElementById('chipPts');
const themeBtn = document.getElementById('themeBtn');
const homeBtn  = document.getElementById('homeBtn');
const zoomInBtn  = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');

const ftLon   = document.getElementById('ftLon');
const ftLat   = document.getElementById('ftLat');
const ftElev  = document.getElementById('ftElev');
const ftCam   = document.getElementById('ftCam');
const ftEpsg  = document.getElementById('ftEpsg');
const ftNodes = document.getElementById('ftNodes');
const ftFps   = document.getElementById('ftFps');

// ── 패널 탭 전환 ───────────────────────────────────────────
const PANEL_TITLES = {
  data: 'Data', global: 'Global', appearance: 'Appearance',
  filter: 'Filter', points: 'Points', info: 'Info', help: 'Help',
};
let currentTab = 'data';

function switchTab(tab) {
  document.querySelectorAll('.rail-btn[data-tab]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab)
  );
  document.querySelectorAll('.panel-section').forEach(sec =>
    sec.classList.toggle('active', sec.id === `sec-${tab}`)
  );
  panelTitle.textContent = PANEL_TITLES[tab] ?? tab;
  currentTab = tab;
  if (panel.classList.contains('collapsed')) toggleCollapse(false);
}

document.querySelectorAll('.rail-btn[data-tab]').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

// ── 패널 접기/펴기 ─────────────────────────────────────────
function toggleCollapse(forceCollapsed) {
  const collapsed = forceCollapsed !== undefined ? forceCollapsed : !panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', collapsed);
  collapseBtn.classList.toggle('collapsed', collapsed);
}
collapseBtn.addEventListener('click', () => toggleCollapse());

// ── 테마 전환 ──────────────────────────────────────────────
let theme = 'dark';
const SUN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>`;
const MOON_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;

function applyTheme(t) {
  theme = t;
  app.setAttribute('data-theme', t);
  themeBtn.innerHTML = t === 'dark' ? SUN_ICON : MOON_ICON;
}
applyTheme('dark');
themeBtn.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));

// ── 줌 컨트롤 ─────────────────────────────────────────────
homeBtn.addEventListener('click', () => viewer.camera.flyHome());
zoomInBtn.addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomIn(h * 0.35);
});
zoomOutBtn.addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomOut(h * 0.6);
});

// ── 지형/이미지 ────────────────────────────────────────────
terrainSelect.addEventListener('change', async () => {
  if (terrainSelect.value === 'world') {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
  } else {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }
});

imagerySelect.addEventListener('change', async () => {
  const v = imagerySelect.value;
  viewer.imageryLayers.removeAll();
  if (v === 'satellite') {
    const p = await Cesium.IonImageryProvider.fromAssetId(2);
    viewer.imageryLayers.addImageryProvider(p);
  } else if (v === 'osm') {
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
    );
  }
});

// ── SSE 슬라이더 ───────────────────────────────────────────
sseSlider.addEventListener('input', () => {
  const v = parseInt(sseSlider.value, 10);
  sseDisplay.textContent = `${v} px`;
  if (currentDs) currentDs.sseThreshold = v;
});

// ── 점 크기 슬라이더 ───────────────────────────────────────
pixelSizeSlider.addEventListener('input', () => {
  const v = parseFloat(pixelSizeSlider.value);
  pixelSizeDisplay.textContent = v.toFixed(1);
  if (currentDs) currentDs.pixelSize = v;
});

// ── 고도 보정 ──────────────────────────────────────────────
heightOffsetInput.addEventListener('input', () => {
  const v = parseFloat(heightOffsetInput.value) || 0;
  if (currentDs) currentDs.heightOffset = v;
});

// ── Appearance: 색상 모드 (시각적 상태 관리만) ─────────────
colorModeGrid.addEventListener('click', e => {
  const btn = e.target.closest('.color-btn');
  if (!btn) return;
  colorModeGrid.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // TODO: CopcDataSource 색상 모드 API 연동
});

if (document.getElementById('opacitySlider')) {
  document.getElementById('opacitySlider').addEventListener('input', e => {
    opacityDisplay.textContent = `${Math.round(e.target.value)}%`;
    // TODO: CopcDataSource opacity API 연동
  });
}

// ── 분류 필터 ──────────────────────────────────────────────
const ASPRS = {
  0: '미분류 (0)', 1: '미분류 (1)', 2: '지면', 3: '낮은 식생',
  4: '중간 식생', 5: '높은 식생', 6: '건물', 7: '잡음 (저점)',
  8: '예약 (8)', 9: '수면', 10: '철도', 11: '도로면',
  12: '중첩점', 13: '와이어 (가드)', 14: '와이어 (전선)',
  15: '송전탑', 16: '와이어 (연결)', 17: '브리지', 18: '잡음 (고점)',
};
const CLS_COLORS = {
  0: '#808080', 1: '#909090', 2: '#8d6e4f', 3: '#78c86e',
  4: '#4caf6a', 5: '#2d8a4e', 6: '#d98b3a', 7: '#e05555',
  8: '#aaa', 9: '#3a86c9', 10: '#a0522d', 11: '#c8b400',
  12: '#ff7f50', 13: '#ffd700', 14: '#ffec8b', 15: '#c0c0c0',
  16: '#deb887', 17: '#cd853f', 18: '#ff4444',
};

let _renderedClasses = new Set();
let _classOn = {};  // cls → boolean

function updateClassMask() {
  if (!currentDs) return;
  const allOn = Object.values(_classOn).every(v => v);
  if (allOn) {
    currentDs.setClassMask(-1);
    return;
  }
  let mask = 0;
  for (const [cls, on] of Object.entries(_classOn)) {
    if (on) mask |= (1 << parseInt(cls, 10));
  }
  currentDs.setClassMask(mask);
}

function syncAllCheck() {
  const allOn = Object.values(_classOn).every(v => v !== false);
  filterAllCheck.classList.toggle('on', allOn);
}

function rebuildClassList() {
  const sorted = [..._renderedClasses].sort((a, b) => a - b);
  classFilterList.innerHTML = '';
  for (const c of sorted) {
    if (_classOn[c] === undefined) _classOn[c] = true;
    const on = _classOn[c];
    const label = ASPRS[c] ?? `클래스 ${c}`;
    const color = CLS_COLORS[c] ?? '#888';
    const row = document.createElement('button');
    row.className = `cls-row${on ? '' : ' off'}`;
    row.innerHTML =
      `<span class="cls-swatch" style="background:${color}"></span>` +
      `<span class="cls-name">${label}</span>` +
      `<span class="cls-check${on ? ' on' : ''}">` +
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 4 4 9-10"/></svg>` +
      `</span>`;
    row.addEventListener('click', () => {
      _classOn[c] = !_classOn[c];
      rebuildClassList();
      syncAllCheck();
      updateClassMask();
    });
    classFilterList.appendChild(row);
  }
}

function refreshClassPanel(seenClasses) {
  if (!seenClasses || seenClasses.size === 0) return;
  let changed = false;
  for (const c of seenClasses) {
    if (!_renderedClasses.has(c)) { _renderedClasses.add(c); changed = true; }
  }
  if (changed) {
    rebuildClassList();
    syncAllCheck();
  }
}

filterAllRow.addEventListener('click', () => {
  const allOn = Object.values(_classOn).every(v => v !== false);
  const newVal = !allOn;
  for (const k of Object.keys(_classOn)) _classOn[k] = newVal;
  rebuildClassList();
  syncAllCheck();
  updateClassMask();
});

// ── 프리셋 목록 렌더링 ─────────────────────────────────────
const PRESET_KEYS = Object.keys(PRESETS);
presetCount.textContent = PRESET_KEYS.length;

function renderPresetList(activeKey) {
  presetList.innerHTML = '';
  for (const key of PRESET_KEYS) {
    const p = PRESETS[key];
    const btn = document.createElement('button');
    btn.className = `dataset-row${activeKey === key ? ' active' : ''}`;
    btn.innerHTML =
      `<span class="dataset-dot"></span>` +
      `<span class="dataset-name">${p.label}</span>` +
      `<span class="dataset-pts">${p.pts ?? '—'}</span>`;
    btn.addEventListener('click', () => {
      setActivePreset(key);
      urlInput.value = p.url;
      loadCopc(p.url, p);
    });
    presetList.appendChild(btn);
  }
}
renderPresetList(null);

// ── 현재 로드 상태 ─────────────────────────────────────────
let currentDs        = null;
let activePreset     = null;
let activePresetOpts = null;
let activeLabel      = null;

function setActivePreset(key) {
  activePreset     = key;
  activePresetOpts = key ? PRESETS[key] : null;
  activeLabel      = key ? PRESETS[key].label : null;
  renderPresetList(key);
}

// ── 칩 상태 업데이트 ───────────────────────────────────────
function setChipState(state, label, pts) {
  // state: 'idle' | 'loading' | 'active'
  chipDot.className = 'chip-dot' + (state === 'active' ? ' active' : state === 'loading' ? ' loading' : '');
  chipName.textContent = label || 'No data loaded';
  if (pts) {
    chipPts.textContent = pts;
    chipPts.style.display = '';
  } else {
    chipPts.style.display = 'none';
  }
}

// ── Info 패널 업데이트 ─────────────────────────────────────
function updateInfoPanel(name, rows) {
  infoName.textContent = name || '—';
  infoMeta.innerHTML = rows.map(([k, v]) =>
    `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val">${v}</span></div>`
  ).join('');
}

// ── 푸터 업데이트 (카메라 위치) ────────────────────────────
function updateFooter() {
  const cpos = viewer.camera.positionCartographic;
  if (!cpos) return;
  const lon  = Cesium.Math.toDegrees(cpos.longitude);
  const lat  = Cesium.Math.toDegrees(cpos.latitude);
  const elev = cpos.height;
  ftLon.textContent  = lon.toFixed(4);
  ftLat.textContent  = lat.toFixed(4);
  ftElev.textContent = `${Math.round(elev)} m`;
  ftCam.textContent  = elev >= 1000
    ? `${(elev / 1000).toFixed(1)} km`
    : `${Math.round(elev)} m`;
}

viewer.camera.changed.addEventListener(updateFooter);
viewer.camera.moveEnd.addEventListener(updateFooter);
updateFooter();

// ── FPS 카운터 ─────────────────────────────────────────────
let _frames = 0, _lastFpsTime = performance.now();
viewer.scene.postRender.addEventListener(() => {
  _frames++;
  const now = performance.now();
  if (now - _lastFpsTime >= 1000) {
    ftFps.textContent = _frames;
    _frames = 0;
    _lastFpsTime = now;
  }
});

// ── COPC 로드 함수 ─────────────────────────────────────────
let _loadingController = null;

async function loadCopc(url, opts = {}) {
  if (!url.trim()) return;
  if (/^\/|^\./.test(url.trim())) {
    url = new URL(url.trim(), window.location.href).href;
  }

  if (_loadingController) _loadingController.abort = true;
  const ctrl = { abort: false };
  _loadingController = ctrl;

  if (currentDs) { currentDs.destroy(); currentDs = null; }

  // 분류 필터 초기화
  _renderedClasses = new Set();
  _classOn = {};
  classFilterList.innerHTML = '';
  filterAllCheck.classList.add('on');
  heightOffsetInput.value = '0';

  const label = activeLabel || url.split('/').pop().replace(/\.copc\.laz$/, '');
  setChipState('loading', label);
  infoStatus.textContent = '📡 초기화 중...';
  loadBtn.disabled = true;

  try {
    const ds = await CopcDataSource.load(url.trim(), viewer, {
      proj:          opts.proj        ?? 'EPSG:4326',
      projDef:       opts.projDef     ?? null,
      geoidOffset:   opts.geoidOffset ?? 0,
      zFactor:       opts.zFactor     ?? 0.3048,
      concurrency:   5,
      maxCacheNodes: 150,
      pixelSize:     parseFloat(pixelSizeSlider.value),
    });

    if (ctrl.abort) { ds.destroy(); return; }
    currentDs = ds;

    ds.sseThreshold = parseInt(sseSlider.value, 10);
    setChipState('active', label);

    // Info 패널 초기 메타데이터 (COPC로부터 알 수 있는 정보)
    const epsg = opts.proj ?? 'EPSG:4326';
    ftEpsg.textContent = epsg.replace('EPSG:', '');
    updateInfoPanel(label, [
      ['Format', 'COPC 1.0'],
      ['CRS', epsg],
      ['Geoid offset', `${opts.geoidOffset ?? 0} m`],
      ['zFactor', String(opts.zFactor ?? 0.3048)],
    ]);
    infoStatus.textContent = '';

    ds.onProgress = ({ depth, visible, culled, loading, points, cached, height, seenClasses }) => {
      refreshClassPanel(seenClasses);

      const pts = points ? `${(points / 1e6).toFixed(1)}M pts` : null;
      setChipState('active', label, pts);

      ftNodes.textContent = `${visible}/${cached}`;
      ftElev.textContent  = `${Math.round(height ?? 0)} m`;

      if (loading > 0) {
        infoStatus.textContent = `🔄 깊이 ${depth} 로딩 중... (남은 ${loading}개)`;
      } else {
        infoStatus.textContent =
          `✅ 깊이 ${depth} | 노드 ${visible}개 (컬링 ${culled}개) | 캐시 ${cached}/${ds.maxCacheNodes}`;
      }

      // Info 패널 메타 업데이트 (포인트 수 추가)
      if (points) {
        updateInfoPanel(label, [
          ['Format', 'COPC 1.0'],
          ['CRS', epsg],
          ['Points', (points).toLocaleString()],
          ['Depth', String(depth)],
          ['Nodes visible', `${visible} (culled ${culled})`],
          ['Cache', `${cached} / ${ds.maxCacheNodes}`],
          ['Height', `${Math.round(height ?? 0)} m`],
        ]);
      }
    };

  } catch (err) {
    if (!ctrl.abort) {
      setChipState('idle', 'Load failed');
      infoStatus.textContent = `❌ ${err.message}`;
      console.error(err);
    }
  } finally {
    if (!ctrl.abort) loadBtn.disabled = false;
    if (_loadingController === ctrl) _loadingController = null;
  }
}

// ── URL 입력으로 로드 ──────────────────────────────────────
loadBtn.addEventListener('click', () => {
  const opts = activePresetOpts ?? {};
  setActivePreset(null);
  activeLabel = urlInput.value.trim().split('/').pop().replace(/\.copc\.laz$/, '');
  loadCopc(urlInput.value, opts);
});

urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadBtn.click(); });
urlInput.addEventListener('input', () => setActivePreset(null));

// ── 초기 로드: Autzen ─────────────────────────────────────
setActivePreset('autzen');
urlInput.value = PRESETS.autzen.url;
loadCopc(PRESETS.autzen.url, PRESETS.autzen);
