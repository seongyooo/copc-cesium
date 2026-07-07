# 실습 노트

공부하면서 직접 실험하고 확인한 내용을 기록하는 파일입니다.

---

## 1. CesiumJS 기초

### 1-1. 환경 세팅

**로컬 서버 실행 (file:// 프로토콜 보안 제한 우회):**
```bash
npx serve .
```
→ `http://localhost:3000` 접속

**Cesium ion 토큰:**
- https://ion.cesium.com 에서 발급
- 토큰 없이도 지구본 자체는 동작하지만 위성 이미지가 안 나옴
- 토큰 있으면 실제 위성 이미지 표시됨
- ⚠️ Public 레포에 토큰 커밋 금지 → `cesium-test.html`은 `.gitignore`에 추가

---

### 1-2. 기본 Viewer 생성

```html
<script src="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Cesium.js"></script>
<link href="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
```

```javascript
Cesium.Ion.defaultAccessToken = 'YOUR_TOKEN_HERE';

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
```

**확인:** 브라우저에서 3D 지구본 + 위성 이미지 표시됨 ✅

---

### 1-3. 점 찍기 (PointPrimitiveCollection)

```javascript
// 1. 컨테이너 생성
const points = viewer.scene.primitives.add(
  new Cesium.PointPrimitiveCollection()
);

// 2. 점 추가
points.add({
  position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
  pixelSize: 10,        // 점 크기 (픽셀)
  color: Cesium.Color.RED,
});
```

**확인:** 서울 상공에서 빨강/초록/파랑/노랑 점 4개 표시됨 ✅

**핵심 구조:**
```
viewer.scene.primitives   ← 3D 오브젝트 컨테이너
  └─ PointPrimitiveCollection  ← 점들의 컨테이너
       └─ PointPrimitive (점 하나하나)
```

나중에 COPC에서 읽은 수백만 개의 점을 이 `points.add()` 에 넣는 구조가 됨.

---

### 1-4. 카메라 이동

```javascript
viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
});
```

---

### 1-5. 좌표 변환

**왜 필요한가:**
- COPC 파일 좌표: `X=637256.7, Y=4188450.3` (미터 단위 로컬 좌표)
- CesiumJS 좌표: `경도=126.97, 위도=37.57` (위경도)
- → 변환이 필요

**변환 순서:**
```
COPC 좌표 (EPSG:32652 등)
       ↓  proj4js
WGS84 위경도 (EPSG:4326)
       ↓  Cesium.Cartesian3.fromDegrees()
CesiumJS Cartesian3
```

**EPSG 코드:** 전 세계 좌표계를 번호로 정리한 표준

| EPSG | 좌표계 | 사용 지역 |
|------|--------|----------|
| 4326 | WGS84 위경도 | GPS, 전 세계 |
| 5186 | 한국 중부원점 | 한국 |
| 32652 | UTM Zone 52N | 한국 포함 동아시아 |

**proj4js 사용법:**
```javascript
// UTM Zone 52N → WGS84 변환
proj4.defs('EPSG:32652', '+proj=utm +zone=52 +datum=WGS84 +units=m');
const [longitude, latitude] = proj4('EPSG:32652', 'EPSG:4326', [x, y]);
```

**전체 변환 흐름:**
```javascript
// copc.js가 Scale/Offset 계산을 자동으로 해줌
// view.getter('X')(i) → 이미 실제 미터 좌표

const x = view.getter('X')(i);
const y = view.getter('Y')(i);
const z = view.getter('Z')(i);

// 미터 좌표 → 위경도
const [longitude, latitude] = proj4('EPSG:32652', 'EPSG:4326', [x, y]);

// 위경도 → CesiumJS
const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, z);
points.add({ position, pixelSize: 3, color: Cesium.Color.RED });
```

---

## 2. copc.js 실습

### 2-1. 환경 세팅

```bash
npm init -y
npm install copc
```

실습 파일은 `.mjs` 확장자 사용 (ES Module 방식)

```bash
node copc-test.mjs
```

---

### 2-2. 기본 API 흐름

```javascript
import { Copc } from 'copc';

const URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

// Step 1: 헤더 + info VLR 읽기 (처음 589바이트만 Range Request)
const copc = await Copc.create(URL);

// Step 2: 계층 페이지 로드 — 노드 키 맵 획득
const { nodes } = await Copc.loadHierarchyPage(URL, copc.info.rootHierarchyPage);

// Step 3: 특정 노드의 점 데이터 로드
const view = await Copc.loadPointDataView(URL, copc, nodes['0-0-0-0']);

// Step 4: 점 데이터 읽기
const getX = view.getter('X');
const getY = view.getter('Y');
const getZ = view.getter('Z');
for (let i = 0; i < view.pointCount; i++) {
  const x = getX(i), y = getY(i), z = getZ(i);
}
```

---

### 2-3. 실습 결과 (Autzen Stadium 샘플)

**샘플 파일:** `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`

**헤더:**
```
포인트 수: 10,653,336 (약 1천만 개)
스케일: [0.01, 0.01, 0.01]  → 좌표 정밀도 1cm
오프셋: [637290.75, 851209.9, 510.7]
좌표계: NAD83 / Oregon GIC Lambert (ft) → 미국 오레곤 주, 피트 단위
```

**계층:**
```
총 노드 수: 278개
루트 노드(0-0-0-0): pointCount=61,201 / offset=79,462,688 / length=763,258
→ 전체 1천만 개 중 루트는 61,201개 (약 0.6%) — LoD 효과
→ 파일 79MB 지점에서 763KB만 Range Request
```

**점 데이터 (처음 5개):**
```
점 0: X=638865.15, Y=849280.01, Z=425.16 / R=44544, G=44032, B=37632 / Classification=2(Ground)
점 1: X=638852.82, Y=849328.60, Z=424.54 / R=22016, G=28416, B=27648 / Classification=2(Ground)
...
```

**확인된 사항:**
- `view.getter('X')(i)` → Scale/Offset 자동 적용된 실제 미터 좌표 반환 ✅
- R/G/B 범위: 0~65535 (uint16) ✅
- Classification=2 → Ground 포인트 ✅

---

## 3. COPC + CesiumJS 연결 (PoC)

### 3-1. 환경 세팅 (Vite + vite-plugin-cesium)

CDN 방식 대신 Vite 번들러 사용. `laz-perf.wasm` 로드 문제를 플러그인이 자동 처리함.

```bash
npm create vite@latest
npm install copc proj4
npm install -D cesium vite-plugin-cesium
```

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
export default defineConfig({ plugins: [cesium()] });
```

`.env.local`에 토큰 보관 (gitignore):
```
VITE_CESIUM_TOKEN=eyJ...
```

```javascript
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;
```

---

### 3-2. 좌표계 (Autzen 샘플)

Autzen 데이터셋은 **EPSG:2992** (NAD83 / Oregon Lambert, 피트 단위) 사용.

```javascript
proj4.defs('EPSG:2992',
  '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
  ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs'
);

// 좌표 변환 + Z축 단위 변환
const [lon, lat] = proj4('EPSG:2992', 'EPSG:4326', [x, y]);
const altMeters = z * 0.3048; // 피트 → 미터
```

---

### 3-3. copc.info.cube 구조

실제 확인 결과: `copc.info.cube`는 `{ center, halfSize }` 객체가 **아니라** `[minx, miny, minz, maxx, maxy, maxz]` **배열**임.

```javascript
const [minx, miny, minz, maxx, maxy, maxz] = copc.info.cube;
const rootCenter = {
  x: (minx + maxx) / 2,
  y: (miny + maxy) / 2,
  z: (minz + maxz) / 2,
};
const rootHalfSize = (maxx - minx) / 2; // 정육면체이므로 x축만으로 충분
```

---

### 3-4. LoD (Level of Detail)

카메라 고도에 따라 Octree 깊이를 동적으로 선택. 깊이는 데이터에서 직접 계산.

```javascript
// 데이터의 실제 최대 깊이 동적 계산
const maxDepth = Math.max(...Object.keys(nodes).map(getDepth));
// Autzen 결과: maxDepth = 5 (깊이 0~5, 노드 278개)

// 로그 스케일로 고도 → 깊이 매핑
function heightToDepth(height, maxDepth) {
  const HIGH = 8000; // 이상이면 depth 0
  const LOW  = 150;  // 이하이면 maxDepth
  if (height >= HIGH) return 0;
  if (height <= LOW)  return maxDepth;
  const t = Math.log(height / LOW) / Math.log(HIGH / LOW);
  return Math.round((1 - t) * maxDepth);
}
```

**핵심 포인트:**
- 하드코딩 대신 `maxDepth`를 데이터에서 읽어서 사용 → 다른 COPC 파일에도 자동 대응
- 로그 스케일: 멀리서는 큰 단위로, 가까이서는 세밀하게

---

### 3-5. 프러스텀 컬링 (Frustum Culling)

카메라 시야 밖의 노드는 로드하지 않음. 노드의 BoundingSphere를 계산해서 frustum과 교차 판정.

```javascript
// 노드 키(D-X-Y-Z)로 BoundingSphere 계산
function getNodeBoundingSphere(key, rootCenter, rootHalfSize) {
  const [level, xi, yi, zi] = key.split('-').map(Number);
  const nodeHalfSize = rootHalfSize / Math.pow(2, level);

  // 노드 중심 = 루트 최소점 + 격자 인덱스로 이동
  const cx = rootCenter.x - rootHalfSize + (2 * xi + 1) * nodeHalfSize;
  const cy = rootCenter.y - rootHalfSize + (2 * yi + 1) * nodeHalfSize;
  const cz = rootCenter.z - rootHalfSize + (2 * zi + 1) * nodeHalfSize;

  const [lon, lat] = proj4('EPSG:2992', 'EPSG:4326', [cx, cy]);
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, cz * 0.3048);
  const radius = nodeHalfSize * 0.3048 * Math.sqrt(3); // 정육면체 대각선 절반

  return new Cesium.BoundingSphere(center, radius);
}

// frustum 교차 판정
function isNodeInFrustum(boundingSphere) {
  const cullingVolume = viewer.camera.frustum.computeCullingVolume(
    viewer.camera.position,
    viewer.camera.direction,
    viewer.camera.up
  );
  return cullingVolume.computeVisibility(boundingSphere) !== Cesium.Intersect.OUTSIDE;
}
```

---

### 3-6. ERR_CACHE_OPERATION_NOT_SUPPORTED 해결

**원인:** 브라우저가 Cross-origin Range Request에 Cache API를 지원하지 않아 발생.
`cache: 'no-store'`를 강제하면 해결되지만, `window.fetch` 패치를 main.js 안에서 하면 **ES 모듈 호이스팅** 때문에 copc.js가 먼저 `fetch`를 캡처해버려서 패치가 적용 안 됨.

**해결:** `index.html`에 인라인 클래식 스크립트로 패치. 클래식 스크립트는 모듈보다 먼저 실행됨.

```html
<!-- 모듈 로드 전에 실행되는 클래식 스크립트 -->
<script>
  (function () {
    var _fetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      return _fetch(input, Object.assign({}, init, { cache: 'no-store' }));
    };
  })();
</script>
<script type="module" src="/src/main.js"></script>
```

**핵심 포인트:**
- ES 모듈의 `import`는 코드 실행 전에 호이스팅되어 평가됨
- 인라인 클래식 스크립트는 `defer` 없이 즉시 실행 → 모듈 평가보다 먼저 실행 보장

---

### 3-7. 현재 구현 전체 흐름

```
main()
  ├─ Copc.create()          → 헤더 + info VLR (Range Request ~589B)
  ├─ Copc.loadHierarchyPage() → 노드 키 맵 (278개, 깊이 0~5)
  ├─ maxDepth = 5 (동적 계산)
  ├─ camera.flyTo()         → 초기 시점 이동
  └─ updateLoD()
       ├─ heightToDepth()   → 고도 → 깊이 (로그 스케일)
       ├─ 후보 노드 필터링  → 해당 깊이의 노드만
       ├─ getNodeBoundingSphere() + isNodeInFrustum() → 시야 밖 제거
       ├─ 시야 밖 노드 primitives에서 제거
       └─ 새 노드 loadNode() → PointPrimitiveCollection 추가
            (동시 5개, CONCURRENCY 제한)

camera.changed → debounce 300ms → updateLoD() 재실행
```

