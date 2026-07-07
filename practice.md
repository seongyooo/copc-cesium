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

> 추후 작성 예정

