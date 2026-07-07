# COPC × CesiumJS 가시화 라이브러리 개발 — 학습 가이드

> 이 파일은 과제 개발에 필요한 개념을 단계별로 공부할 수 있도록 구성한 로드맵입니다.  
> 각 섹션의 `📝 내 정리` 항목에 구글링·실험한 내용을 직접 채워 넣으세요.

---

## 전체 그림 (먼저 읽기)

```
[원본 파일]          [파싱]              [렌더링]           [결과]
COPC (.copc.laz) → copc.js로 읽기 → CesiumJS로 그리기 → 웹 브라우저 3D 지구본
     (S3/CDN)       (TypeScript)     (PointPrimitive)
```

**우리가 만들 것:**  
`copc.js`로 데이터를 읽고, `CesiumJS`로 점을 지구본 위에 그리는 **연결 라이브러리(어댑터)**

---

## Chapter 1. 점군(Point Cloud) 데이터 기초

> 왜 배우나: 우리가 다루는 데이터가 무엇인지 모르면 파싱도, 렌더링도 설계할 수 없다.

### 1-1. 점군 데이터란?

- 수백만~수십억 개의 점(X, Y, Z)과 각 점의 속성으로 구성된 3D 데이터
- 드론·LiDAR로 현실 공간을 스캔해서 얻음
- 각 점이 가질 수 있는 속성: **X, Y, Z, Intensity, R, G, B, Classification, GPS Time** 등

| 취득 방식 | 특징 |
|-----------|------|
| 항공 LiDAR | 비행기에서 레이저 발사, 반사 거리 측정 |
| 지상 LiDAR | 지상에서 360° 스캔, 밀도 매우 높음 |
| 드론 사진측량 | 여러 사진에서 3D 좌표 추출 (SfM 기법) |

**Classification 코드 (ASPRS 표준)**

| 값 | 의미 |
|----|------|
| 0  | Unclassified |
| 2  | Ground (지면) |
| 3  | Low Vegetation |
| 5  | High Vegetation |
| 6  | Building (건물) |
| 9  | Water (수계) |

### 📝 내 정리 — 점군 데이터
<!-- 여기에 공부한 내용, 그림, 의문점 등을 자유롭게 작성 -->

---

### 1-2. LAS / LAZ 포맷

- **LAS**: ASPRS(미국사진측량원격탐사학회)가 정의한 점군 데이터 표준 바이너리 포맷
- **LAZ**: LAS를 LASzip 알고리즘으로 **무손실 압축**한 포맷 (원본 대비 7~20% 크기)
- COPC는 LAS **1.4** 기반 — 다른 버전(1.0~1.3)과는 구분

**LAS 파일 내부 구조**
```
[Public File Header Block]   ← 파일 전체 메타데이터 (scale, offset, point 수, bounding box 등)
[Variable Length Records (VLR)]  ← 좌표계(WKT), 압축 정보 등
[Point Data Records]         ← 실제 점 데이터 (X, Y, Z, Intensity, ...)
[Extended VLR (EVLR)]        ← LAS 1.4 신규, 대용량 메타데이터
```

**중요: Scale & Offset**
- LAS의 X, Y, Z는 정수로 저장됨
- 실제 좌표 = (정수값 × scale) + offset
- 예: scale=0.001, offset=123456.0 → 정수 0 → 실제 좌표 123456.000

**공부할 키워드:** `ASPRS LAS specification`, `LASzip`, `pdal`, `liblas`

### 📝 내 정리 — LAS/LAZ
<!-- 여기에 공부한 내용을 작성 -->

---

## Chapter 2. COPC (Cloud Optimized Point Cloud)

> 왜 배우나: 우리가 읽어야 할 데이터 포맷의 핵심. 이 구조를 이해해야 효율적인 스트리밍을 구현할 수 있다.

### 2-1. COPC가 해결하는 문제

**기존 문제 (LAS/LAZ):**
- 파일을 처음부터 순서대로 읽어야 함 → 필요한 일부만 꺼낼 수 없음
- 웹 브라우저에서 수 GB 파일 전체를 받아야 함 → 사실상 불가능

**COPC의 해결책:**
- 데이터를 **Octree + LoD** 구조로 내부 재배열
- **HTTP Range Request**로 필요한 블록만 부분 요청
- 단일 파일 — 서버에 특별한 소프트웨어 불필요, S3/CDN에 그냥 올려도 됨
- 확장자: `.copc.laz`

### 2-2. HTTP Range Request

```
일반 요청:  GET /file.copc.laz
            → 전체 파일 (수 GB) 다운로드

Range 요청: GET /file.copc.laz
            Range: bytes=123456-234567
            → 해당 바이트 범위만 (수 KB) 다운로드
```

유튜브 스트리밍과 같은 원리 — 지금 보는 부분만 받아온다.

**공부할 키워드:** `HTTP Range Request`, `206 Partial Content`, `fetch API Range`

### 📝 내 정리 — HTTP Range Request
<!-- 여기에 공부한 내용을 작성 -->

---

### 2-3. Octree 구조

3D 공간을 재귀적으로 8등분하는 트리 자료구조.

```
깊이 0 (루트): 전체 공간을 1개 큐브가 커버
깊이 1: 루트를 8개 자식 큐브로 분할
깊이 2: 각 자식을 다시 8개로 분할
...
```

**노드 키 형식: `D-X-Y-Z`**
- D = 깊이(depth)
- X, Y, Z = 해당 깊이에서의 격자 인덱스

```
루트: 0-0-0-0
자식: 1-0-0-0 / 1-1-0-0 / 1-0-1-0 / 1-0-0-1
      1-1-1-0 / 1-1-0-1 / 1-0-1-1 / 1-1-1-1
```

**시각적 비유:**
- 깊이 0: 서울 전체를 하나의 점으로 표현 (1개 점)
- 깊이 3: 서울을 동 단위로 나눠 표현 (수천 개 점)
- 깊이 10: 건물 개별 벽돌까지 (수백만 개 점)

**공부할 키워드:** `Octree data structure`, `spatial indexing`, `point cloud LOD`

### 📝 내 정리 — Octree
<!-- 여기에 공부한 내용을 작성 -->

---

### 2-4. LoD (Level of Detail)

멀리서 볼 때는 적은 점, 가까이서 볼 때는 많은 점을 표시하는 기법.

```
카메라 멀리 있을 때:  깊이 0~2 노드만 로드 → 수천 개 점, 빠름
카메라 가까이 있을 때: 깊이 0~8 노드 로드  → 수백만 개 점, 상세
```

**LoD 계산 공식 (Potree 방식):**
```
필요 깊이 = f(카메라-노드 거리, 화면 픽셀 크기, 목표 점 밀도)
```

**공부할 키워드:** `LOD point cloud`, `Potree LOD`, `screen space error`

### 📝 내 정리 — LoD
<!-- 여기에 공부한 내용을 작성 -->

---

### 2-5. COPC 파일 내부 구조 (심화)

```
[LAS 1.4 File Header]
  ├─ magic: "LASF"
  ├─ scale: (0.001, 0.001, 0.001)
  ├─ offset: (경도, 위도, 고도 기준값)
  └─ pointCount: 전체 점 수

[VLR: copc-info]
  ├─ center: 공간 큐브 중심 (x, y, z)
  ├─ halfSize: 공간 큐브 반지름
  └─ rootHierarchyPage: 루트 계층 페이지 위치 {byteOffset, byteSize}

[VLR: copc-hierarchy]
  └─ 노드 키 → {byteOffset, byteSize, pointCount} 매핑 테이블

[LAZ 청크 데이터]
  └─ 각 Octree 노드의 압축된 점군 블록
     (byteOffset, byteSize로 Range Request 접근)
```

**읽는 순서:**
1. 처음 수 KB만 Range Request → 헤더 + VLR 파싱 → `copc-info` 취득
2. `rootHierarchyPage` 위치로 Range Request → 노드 키 맵 취득
3. 필요한 노드의 `byteOffset`, `byteSize`로 Range Request → LAZ 청크 디코딩

**참고 자료:**
- https://copc.io/ (COPC 공식 스펙)
- https://copc.io/software.html (지원 소프트웨어 목록)

### 📝 내 정리 — COPC 파일 구조
<!-- 여기에 공부한 내용을 작성 -->

---

## Chapter 3. CesiumJS

> 왜 배우나: 데이터를 파싱했으면 이 위에 올려야 한다. 어떤 API를 써서 점을 렌더링할지 결정해야 한다.

### 3-1. CesiumJS 개요

- WebGL 기반 오픈소스 3D 지구본 라이브러리
- WGS84 타원체 지구 위에 위성 이미지, 지형, 3D 건물 등을 표현
- GitHub: https://github.com/CesiumGS/cesium

**핵심 개념:**
- **Viewer**: CesiumJS의 메인 컨테이너 (지구본 + 카메라 + UI)
- **Scene**: 3D 장면 관리 (조명, 안개, 카메라)
- **Cartesian3**: CesiumJS의 3D 좌표 타입 (지구 중심 기준 XYZ)
- **WGS84**: 위경도 좌표계 (GPS에서 쓰는 그것)

```javascript
// 기본 사용법
const viewer = new Cesium.Viewer('cesiumContainer');

// 위경도 → Cartesian3 변환
const position = Cesium.Cartesian3.fromDegrees(126.97, 37.57, 100); // 서울, 고도 100m
```

**공부할 키워드:** `CesiumJS tutorial`, `Cesium ion`, `Cesium Viewer API`

### 📝 내 정리 — CesiumJS 기초
<!-- 여기에 공부한 내용을 작성 -->

---

### 3-2. 점 렌더링 API 비교

| API | 특징 | 적합한 상황 |
|-----|------|------------|
| `Entity API` | 쉬움, 고수준 | 수백 개 이하 |
| `PointPrimitiveCollection` | 중간 수준, 점 특화 | 수십만 개 |
| `커스텀 Primitive + GLSL` | 어려움, 최고 성능 | 수백만 개 이상 |

**PointPrimitiveCollection 예시:**
```javascript
const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());

// 점 하나 추가
points.add({
  position: Cesium.Cartesian3.fromDegrees(126.97, 37.57, 50),
  pixelSize: 3,
  color: Cesium.Color.RED
});
```

**점군 수백만 개 렌더링 시 고려사항:**
- 한 번에 다 올리면 브라우저 멈춤 → **청크 단위로 분할 업로드**
- GPU 메모리 관리 → **카메라에서 멀면 unload**
- 매 프레임 색상 변경 → `STREAM_DRAW`, 고정이면 `STATIC_DRAW`

**공부할 키워드:** `CesiumJS PointPrimitiveCollection`, `Cesium Primitive API`, `WebGL draw calls`

### 📝 내 정리 — CesiumJS 렌더링 API
<!-- 여기에 공부한 내용을 작성 -->

---

### 3-3. 좌표 변환

LAS 파일의 좌표계 → CesiumJS 좌표계로 변환이 필요하다.

**LAS 좌표 → 실제 좌표:**
```
실제 X = (LAS_X × scaleX) + offsetX
실제 Y = (LAS_Y × scaleY) + offsetY
실제 Z = (LAS_Z × scaleZ) + offsetZ
```

**실제 좌표 → CesiumJS Cartesian3:**
- 좌표계(WKT)를 보고 EPSG 코드 확인 → proj4js로 WGS84로 변환 → Cartesian3으로 변환
- 예: UTM 좌표 → WGS84 위경도 → Cesium.Cartesian3

```javascript
// WGS84 위경도 → Cartesian3
Cesium.Cartesian3.fromDegrees(longitude, latitude, height)

// 또는 라디안으로
Cesium.Cartesian3.fromRadians(longitude, latitude, height)
```

**공부할 키워드:** `proj4js`, `EPSG 코드`, `WGS84`, `UTM 좌표계`, `Cesium Cartesian3`

### 📝 내 정리 — 좌표 변환
<!-- 여기에 공부한 내용을 작성 -->

---

### 3-4. CesiumJS 생명주기 & 커스텀 DataSource

DataSource 방식으로 라이브러리를 CesiumJS에 통합하는 구조:

```typescript
class CopcDataSource {
  // 정적 생성자 (비동기 초기화)
  static async load(url: string): Promise<CopcDataSource> { ... }

  // CesiumJS가 매 프레임마다 호출
  update(time: JulianDate): boolean { ... }

  // 정리
  destroy(): void { ... }
}

// 사용법
const dataSource = await CopcDataSource.load('https://example.com/data.copc.laz');
viewer.dataSources.add(dataSource);
```

**공부할 키워드:** `CesiumJS CustomDataSource`, `CesiumJS DataSource interface`, `Cesium scene preRender event`

### 📝 내 정리 — CesiumJS 통합 구조
<!-- 여기에 공부한 내용을 작성 -->

---

## Chapter 4. copc.js 라이브러리

> 왜 배우나: 라이브러리 개발의 핵심 의존성. 이 API를 잘 써야 COPC를 효율적으로 읽을 수 있다.

**GitHub:** https://github.com/connormanning/copc.js  
**설치:** `npm install copc`

### 4-1. 기본 사용법

```typescript
import { Copc } from 'copc';

// Step 1: 헤더 + 메타데이터 로드 (처음 수 KB만 Range Request)
const copc = await Copc.create('https://example.com/data.copc.laz');

console.log(copc.header);  // LAS 헤더 (scale, offset, point 수 등)
console.log(copc.info);    // COPC 정보 (공간 큐브, 루트 계층 위치)
console.log(copc.wkt);     // 좌표계 문자열

// Step 2: 계층(Hierarchy) 로드 — 노드 키 맵 취득
const { nodes } = await Copc.loadHierarchyPage(
  'https://example.com/data.copc.laz',
  copc.info.rootHierarchyPage
);
// nodes: { '0-0-0-0': { pointCount: 5000, byteOffset: 100000, byteSize: 50000 }, ... }

// Step 3: 특정 노드의 실제 점 데이터 로드
const view = await Copc.loadPointDataView(
  'https://example.com/data.copc.laz',
  copc,
  nodes['0-0-0-0']
);

// Step 4: 점 데이터 읽기
const getX = view.getter('X');      // 실제 미터 좌표
const getY = view.getter('Y');
const getZ = view.getter('Z');
const getR = view.getter('Red');    // 0~65535
const getG = view.getter('Green');
const getB = view.getter('Blue');

for (let i = 0; i < view.pointCount; i++) {
  const x = getX(i);
  const y = getY(i);
  const z = getZ(i);
}
```

### 4-2. copc.info 구조

```typescript
copc.info = {
  center: { x, y, z },   // 공간 큐브 중심
  halfSize: number,       // 큐브 반지름 (미터)
  rootHierarchyPage: {
    pageByteOffset: number,
    pageByteSize: number
  },
  gpsTimeRange: [min, max]
}
```

### 📝 내 정리 — copc.js
<!-- 여기에 공부한 내용을 작성. 실제로 npm install copc 후 테스트한 내용도 기록 -->

---

## Chapter 5. 참고 구현체 분석

> 왜 배우나: 우리 라이브러리의 구조 설계에 직접 참고한다.

### 5-1. TIFFImageryProvider (COG → CesiumJS)

**GitHub:** https://github.com/hongfaqiu/TIFFImageryProvider  
COG(Cloud Optimized GeoTIFF)를 CesiumJS에 올리는 라이브러리. 우리 과제와 같은 "Cloud Optimized 포맷 → CesiumJS" 구조.

**배울 점:**
- 정적 생성자 패턴 (`fromUrl()` 또는 `load()`)
- 비동기 초기화 분리 (생성자에서 await 불가 → 별도 init 메서드)
- CesiumJS `destroy()` 패턴 (메모리 누수 방지)
- Web Worker로 메인 스레드 블로킹 방지

**핵심 패턴:**
```typescript
// 안티패턴: 생성자에서 await
const provider = new MyProvider(url);  // await 불가 ❌

// 권장 패턴: 정적 팩토리 메서드
const provider = await MyProvider.fromUrl(url);  // ✅
```

### 📝 내 정리 — TIFFImageryProvider 구조 분석
<!-- GitHub 소스 분석한 내용 작성 -->

---

### 5-2. Potree (WebGL 점군 렌더러)

**GitHub:** https://github.com/potree/potree

우리 과제와 구조가 가장 유사하나, Three.js 기반. CesiumJS용으로 동일한 알고리즘을 재구현하는 것이 목표.

**배울 점:**
- **LOD 선택 알고리즘**: 카메라 거리 + 화면 픽셀 밀도 → 노드 우선순위 큐
- **프러스텀 컬링**: 카메라 시야 밖 노드 스킵
- **Worker 패턴**: LAZ 디코딩을 백그라운드 스레드에서 처리

**Potree의 LOD 흐름:**
```
1. 카메라 이동 감지
2. 루트 노드부터 BFS(너비 우선 탐색)
3. 각 노드에 대해: 화면상 점 밀도 계산
4. 밀도 > 임계값 → 자식 노드 로드 큐에 추가
5. 화면 밖 노드 (프러스텀 컬링) → 스킵
6. 큐 순서대로 Range Request + LAZ 디코딩
7. GPU 버퍼 업데이트
```

**공부할 키워드:** `Potree LOD algorithm`, `frustum culling`, `BFS octree traversal`

### 📝 내 정리 — Potree 알고리즘
<!-- 여기에 공부한 내용을 작성 -->

---

## Chapter 6. 웹 성능 최적화 기법

> 왜 배우나: 수백만 개 점을 웹에서 부드럽게 렌더링하려면 이 기법들이 필수다.

### 6-1. Web Worker

브라우저의 멀티스레딩 API. LAZ 압축 해제처럼 무거운 연산을 메인 스레드와 분리.

```javascript
// main.js
const worker = new Worker('decoder.worker.js');
worker.postMessage({ buffer: lazData });
worker.onmessage = (e) => {
  const { positions, colors } = e.data;
  // CesiumJS에 점 추가
};

// decoder.worker.js
self.onmessage = async (e) => {
  const decoded = await decodeLaz(e.data.buffer);
  self.postMessage(decoded, [decoded.positions.buffer]); // Transferable
};
```

**Transferable Objects**: 복사 없이 Worker와 메모리를 전달 → 성능 핵심

**공부할 키워드:** `Web Worker`, `Transferable Objects`, `Worker pool`

### 📝 내 정리 — Web Worker
<!-- 여기에 공부한 내용을 작성 -->

---

### 6-2. TypedArray & GPU 버퍼

점 좌표 데이터는 일반 JS 배열이 아닌 TypedArray로 다뤄야 한다.

```javascript
// 일반 배열 ❌ (느림, 메모리 많이 씀)
const positions = [];
for (let i = 0; i < 1000000; i++) positions.push(x, y, z);

// TypedArray ✅ (빠름, 메모리 효율, GPU 직접 전달 가능)
const positions = new Float32Array(pointCount * 3);
for (let i = 0; i < pointCount; i++) {
  positions[i * 3]     = x;
  positions[i * 3 + 1] = y;
  positions[i * 3 + 2] = z;
}
```

**공부할 키워드:** `TypedArray JavaScript`, `ArrayBuffer`, `Float32Array WebGL`

### 📝 내 정리 — TypedArray
<!-- 여기에 공부한 내용을 작성 -->

---

### 6-3. LRU 캐시

Octree 노드 데이터를 메모리에 캐시하되, 메모리 한계를 초과하면 오래된 것을 제거하는 전략.

```
카메라가 A 구역 볼 때: A의 노드들 → GPU 메모리
카메라가 B 구역으로 이동: B의 노드 로드, A의 노드 중 오래된 것 제거
```

**공부할 키워드:** `LRU Cache`, `lru-cache npm`

### 📝 내 정리 — LRU 캐시
<!-- 여기에 공부한 내용을 작성 -->

---

## Chapter 7. 개발 환경 & 도구

> 실제 코딩 시작 전에 세팅해야 할 것들

### 7-1. 필요한 도구

| 도구 | 용도 | 설치 |
|------|------|------|
| Node.js 20+ | JS 런타임 | https://nodejs.org |
| TypeScript | 타입 안전 JS | `npm i -D typescript` |
| Vite | 번들러/개발 서버 | `npm create vite@latest` |
| copc.js | COPC 파싱 | `npm i copc` |
| CesiumJS | 3D 렌더링 | `npm i cesium` |
| vite-plugin-cesium | Cesium + Vite 연동 | `npm i -D vite-plugin-cesium` |

### 7-2. 샘플 COPC 파일 확보

- https://github.com/PDAL/data 의 샘플 데이터
- https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz (유명한 테스트용 점군)

### 7-3. COPC 파일 직접 열어보기

```bash
# QGIS (GUI 도구) — 무료, 설치형
# https://qgis.org

# PDAL (커맨드라인)
pdal info data.copc.laz --summary

# Potree Converter 결과와 비교
```

### 📝 내 정리 — 개발 환경 세팅
<!-- 실제 세팅하면서 겪은 문제/해결책 기록 -->

---

## Chapter 8. 3D Tiles (비교 이해용)

> 왜 배우나: CesiumJS의 기본 대용량 포맷. COPC와의 차이를 알아야 우리 라이브러리의 존재 이유를 설명할 수 있다.

### 8-1. 3D Tiles 개요

- CesiumGS가 만든 OGC 표준, 대규모 3D 데이터 스트리밍 포맷
- CesiumJS에서 `Cesium3DTileset`으로 네이티브 지원
- 구조: `tileset.json` + 다수의 타일 파일 (`.pnts`, `.b3dm`, `.glb` 등)

### 8-2. COPC vs 3D Tiles

| 항목 | COPC | 3D Tiles |
|------|------|----------|
| 파일 수 | **단일 파일** | tileset.json + 수천 개 타일 |
| 서버 요건 | Range Request 지원만 | 정적 서버 가능 |
| 사전 변환 | **불필요** (원본 직접 사용) | 필요 (변환 도구 필요) |
| CesiumJS 지원 | 기본 미지원 → **우리가 만드는 것** | 네이티브 지원 |
| 점군 특화 | ✅ | .pnts는 deprecated 중 |

**→ 이것이 우리 라이브러리의 존재 이유:** COPC를 3D Tiles로 변환하는 번거로움 없이 원본 그대로 CesiumJS에서 볼 수 있게 한다.

### 📝 내 정리 — 3D Tiles
<!-- 여기에 공부한 내용을 작성 -->

---

## 학습 체크리스트

각 항목을 공부한 후 체크하세요.

### 기초 개념
- [ ] 점군(Point Cloud) 데이터가 무엇인지 설명할 수 있다
- [ ] LAS와 LAZ의 차이를 설명할 수 있다
- [ ] HTTP Range Request의 원리를 설명할 수 있다
- [ ] Octree가 무엇인지, 왜 점군에 쓰이는지 설명할 수 있다
- [ ] LoD(Level of Detail)가 무엇인지 설명할 수 있다

### COPC
- [ ] COPC 파일의 내부 구조(헤더, VLR, 청크)를 설명할 수 있다
- [ ] 노드 키(`D-X-Y-Z`) 형식을 이해한다
- [ ] COPC 파일을 읽는 3단계 순서를 설명할 수 있다

### CesiumJS
- [ ] CesiumJS 기본 예제를 직접 실행해봤다
- [ ] `PointPrimitiveCollection`으로 점을 찍어봤다
- [ ] 위경도 좌표를 Cartesian3으로 변환할 수 있다

### copc.js
- [ ] `npm install copc` 후 기본 예제를 실행해봤다
- [ ] `Copc.create()` → `loadHierarchyPage()` → `loadPointDataView()` 흐름을 이해한다
- [ ] 실제 .copc.laz 파일에서 점 좌표를 읽어봤다

### 구현 준비
- [ ] TIFFImageryProvider 소스코드를 읽고 구조를 이해했다
- [ ] Potree 소스코드에서 LOD 알고리즘 부분을 찾아 읽었다
- [ ] Web Worker 기본 예제를 작성해봤다
- [ ] copc.js로 읽은 점을 CesiumJS에 찍어보는 PoC(개념 증명)를 만들어봤다

---

## 공부 순서 추천

```
Week 1: Chapter 1 → 2 → 7-2 (샘플 파일 받아서 QGIS로 열어보기)
Week 2: Chapter 3 → 4 (CesiumJS 예제 + copc.js 예제 직접 실행)
Week 3: Chapter 5 → 6 (참고 구현체 소스 분석 + PoC 개발 시작)
Week 4~: 실제 라이브러리 개발
```

---

*마지막 업데이트: 2026-07-07*
