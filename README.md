# copc-cesium

> **COPC 데이터의 CesiumJS 가시화 라이브러리**  
> 2026 오픈소스 개발자대회 지정과제 — 가이아쓰리디

COPC(Cloud Optimized Point Cloud) 파일을 별도의 사전 변환 없이 CesiumJS 3D 지구본에 스트리밍 방식으로 가시화하는 JavaScript 라이브러리입니다.

---

## 목차

1. [배경 및 동기](#1-배경-및-동기)
2. [아키텍처](#2-아키텍처)
3. [핵심 알고리즘](#3-핵심-알고리즘)
4. [프로젝트 구조](#4-프로젝트-구조)
5. [빠른 시작](#5-빠른-시작)
6. [API 레퍼런스](#6-api-레퍼런스)
7. [COPC 변환 도구](#7-copc-변환-도구)
8. [기술 결정 기록](#8-기술-결정-기록)
9. [의존성](#9-의존성)

---

## 1. 배경 및 동기

### 기존 문제

드론·LiDAR로 취득한 수억 개의 점군(Point Cloud) 데이터를 웹에 올리려면 3D Tiles 같은 포맷으로 **사전 변환(타일링)**이 필수였습니다. 변환에는 수 시간이 걸리고, 원본 파일과 타일 파일을 이중으로 보관해야 했습니다.

### COPC의 해결책

**COPC**는 LAS 1.4 기반으로 내부 데이터를 Octree + LoD 구조로 정렬한 단일 파일 포맷입니다. HTTP Range Request로 필요한 청크만 요청할 수 있어, 유튜브 스트리밍처럼 필요한 부분만 즉시 로드합니다.

| 항목 | 기존 방식 (3D Tiles) | COPC |
|------|---------------------|------|
| 사전 변환 | 필수 (수 시간) | 불필요 |
| 파일 수 | tileset.json + 수천 개 타일 | **단일 파일** |
| 서버 요구사항 | 정적 서버 가능 | Range Request 지원만 |
| CesiumJS 지원 | 네이티브 | **이 라이브러리가 연결** |

### 이 라이브러리

CesiumJS는 COPC를 네이티브로 지원하지 않습니다. 이 라이브러리는 COPC ↔ CesiumJS 사이의 **어댑터** 역할을 하며, [TIFFImageryProvider](https://github.com/hongfaqiu/TIFFImageryProvider)와 유사한 패턴으로 설계되었습니다.

---

## 2. 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                        브라우저 (메인 스레드)                    │
│                                                             │
│  CopcDataSource                                             │
│  ├─ scene.postUpdate (매 프레임)                              │
│  │   ├─ [즉시] _updateVisibility()   [빠른 경로]              │
│  │   └─ [200ms 간격] _updateLoD()   [느린 경로]              │
│  └─ camera.moveEnd → _updateLoD()   [정지 시 즉시 갱신]       │
│       │                                                     │
│       ├─ 1. _selectNodesBFS()  ← BFS + SSE LoD 선택          │
│       │      ├─ 루트부터 너비 우선 탐색 (이진 힙 우선순위 큐)      │
│       │      ├─ 노드별 screenSpaceError() 계산                 │
│       │      └─ SSE > threshold → 자식 확장                   │
│       ├─ 2. LRU 캐시 히트 확인                                │
│       └─ 3. loadNode()         ← 캐시 미스                   │
│              └─ pool.run({url, copc, nodeInfo, ...}) ──────┐ │
│                                                           │ │
│  PointCloudPrimitive (DrawCommand) ← GPU 지연 초기화       │ │
│  결과 버퍼(posHigh/posLow/colors/cls)로 조립만 수행           │ │
│                                                           │ │
└───────────────────────────────────────────────────────────┼─┘
                                                            │
┌───────────────────────────────────────────────────────────┼─┐
│                     Web Worker (×N)                        │ │
│                                                           │ │
│  worker.js  ◄─────────────────────────────────────────────┘ │
│  ├─ Copc.loadPointDataView()  (fetch + LAZ 압축 해제)        │
│  ├─ X/Y/Z/RGB·Intensity/Classification 속성 추출             │
│  ├─ proj4: srcProj → EPSG:4326                              │
│  ├─ lonLatAlt → WGS84 Cartesian3 (Cesium 없이 직접 계산)     │
│  └─ Float32 high/low 분리(RTE) + BoundingSphere 계산         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 역할 분리 원칙

| 역할 | 스레드 | 이유 |
|------|--------|------|
| COPC 헤더·계층 파싱 | 메인 | `Copc.create()`/`loadHierarchyPage()` — 노드 선택 전 반드시 필요, 데이터량이 작음(수십 KB) |
| **fetch + LAZ 압축 해제** | **Worker** | `laz-perf`가 web/node/worker용 빌드를 각각 배포하며 실제 wasm 바이너리는 동일 — vite.config.js의 worker-scoped alias로 워커 전용 빌드를 사용하도록 전환. 메인 스레드에서 돌리면 카메라 조작이 끊김 |
| 속성 추출 + 좌표 변환 (proj4 + WGS84) | **Worker** | CPU 집약 작업, LAZ 디코딩과 같은 왕복에서 한 번에 처리 |
| Primitive 생성 (WebGL) | 메인 | WebGL 컨텍스트는 메인 스레드 전용 |

> **참고**: `?worker&inline`(Blob URL)로 워커를 인라인하면 laz-perf 워커 빌드의 글루 코드가
> `self.location.href`(blob: URL)로부터 `laz-perf.wasm`의 상대경로를 해석하지 못해 로드가
> 실패한다. 그래서 워커는 `?worker`(실제 URL을 갖는 별도 청크)로 분리하고, wasm 자산도
> 워커 청크와 같은 `assets/` 디렉터리에 놓아야 한다 (`vite.config.js` 참고).

---

## 3. 핵심 알고리즘

### 3-1. LoD (Level of Detail) — BFS + Screen Space Error

[Potree](https://github.com/potree/potree) 방식을 참고한 BFS(너비 우선 탐색) + SSE(Screen Space Error) 알고리즘입니다.

#### 전체 흐름

```
루트 노드 (0-0-0-0) 를 큐에 넣음
                │
         ┌──────▼──────┐
         │  큐에서 꺼냄  │
         └──────┬──────┘
                │
         프러스텀 컬링
         (OUTSIDE → 스킵)
                │
         SSE 계산
         sphere.radius / dist × (h / 2tan(fovY/2))
                │
       ┌────────┴────────┐
  SSE > threshold    SSE ≤ threshold
  AND 자식 존재       OR 자식 없음
       │                 │
  자식 8개 큐에 추가    이 노드를 렌더링 목록에 추가
       │
  (반복)
```

#### 전역 깊이 방식과의 차이

```
[전역 깊이 방식]                      [BFS + SSE 방식]
카메라 거리 → depth N                 노드마다 SSE 계산
→ 화면 전체를 depth N으로 균일 처리    → 가까운 곳 depth 5,
                                         먼 곳 depth 2 혼재

   카메라
     ↓
[ depth 3 ][ depth 3 ][ depth 3 ]    [ depth 5 ][ depth 3 ][ depth 2 ]
 (가까움)   (중간)     (멀음)           (가까움)   (중간)     (멀음)
```

#### SSE 공식

```
SSE = (radius / dist) × (screenHeight / (2 × tan(fovY / 2)))
```

- `radius`: 노드 BoundingSphere 반지름 (미터)
- `dist`: 카메라에서 노드 중심까지의 거리
- 결과값 단위: 픽셀

SSE가 클수록 화면에서 크게 보이므로 더 세밀한 데이터가 필요함. `sseThreshold`(기본 250px)보다 크면 자식으로 확장합니다.

#### Autzen 데이터 기준 SSE 예시

| 깊이 | 반지름(m) | 5km 거리 SSE | 500m 거리 SSE |
|------|-----------|-------------|--------------|
| 0    | ~906      | ~125px → 확장 | ~1256px → 확장 |
| 3    | ~113      | ~16px → 리프  | ~157px → 확장 |
| 5    | ~28       | ~4px → 리프   | ~39px → 확장  |

---

### 3-2. 프러스텀 컬링 (Frustum Culling)

카메라 시야각 밖의 노드를 렌더링 파이프라인에서 제외합니다.

```
camera.frustum.computeCullingVolume(position, direction, up)
    → CullingVolume (6개 평면으로 정의된 절두체)

각 노드의 BoundingSphere vs CullingVolume
    → INSIDE / INTERSECTING → 표시
    → OUTSIDE               → 스킵
```

**BoundingSphere 계산** (`lod.js::getNodeBoundingSphere`):

```
노드 키 D-Xi-Yi-Zi 에서:
  nodeHalfSize = rootHalfSize / 2^D
  center = rootCenter + (2*i + 1) * nodeHalfSize  (각 축)
  radius = nodeHalfSize * sqrt(3)  (큐브의 외접구 반지름)
```

좌표계 변환: `srcProj → EPSG:4326 → Cesium.Cartesian3`

#### 카메라 이벤트 두 경로

```
scene.postUpdate (매 프레임)
  ├─ [즉시] !isUpdating → _updateVisibility()
  │   _lastTargetSet 범위 내에서만 frustum show/hide, 새 로드 없음
  │
  └─ [200ms 간격] → _updateLoD()
      새 노드 로드, LoD 재계산
      isUpdating = true 동안 빠른 경로만 실행 (race condition 방지)

camera.moveEnd (카메라 완전 정지 시)
  └─ 즉시 _updateLoD() 실행 → 200ms 인터벌 기다리지 않고 최종 갱신 보장
```

---

### 3-3. LRU 노드 캐싱

한 번 로드한 노드를 캐시에 유지해 카메라 이동 시 재사용합니다.

```
캐시: Map<key, { collection, pointCount, lastUsed }>

eviction 조건: cache.size > maxCacheNodes (기본 150)
eviction 대상: targetSet에 없는 노드 중 lastUsed가 가장 오래된 것
```

```
카메라 A 구역 → A 노드 로드, 캐시 저장
카메라 B 구역 이동 → B 노드 로드
카메라 A로 복귀 → 캐시 히트, 즉시 표시 (Range Request 없음)
캐시 한계 초과 → LRU 노드 GPU 메모리에서 제거
```

---

### 3-4. Web Worker 풀 (WorkerPool)

고정 크기 Worker 풀로 노드 로드(fetch + LAZ 디코딩 + 좌표 변환)를 병렬 처리합니다.

```
WorkerPool (size = concurrency)
  ├─ idle[]: 유휴 Worker 목록
  ├─ queue[]: 대기 중인 작업 (인덱스 커서로 dequeue, O(1))
  └─ pending: Map<id, {resolve, reject, worker}>

run(msg, transfer) → Promise
  유휴 Worker 있으면 즉시 실행, 없으면 queue 대기
  30초 타임아웃 — hung Worker 시 자동 reject
  Worker 크래시 → pending reject + 새 Worker 자동 교체
```

**요청/응답** — 요청은 작은 메타데이터(url, copc 헤더/계층 정보, nodeInfo)만 보내고,
응답은 GPU에 바로 올릴 수 있는 버퍼를 Transferable로 반환합니다 (버퍼 복사 없이 이동):

```
메인 스레드                                    Worker
{ url, copc, nodeInfo,           ────▶  fetch(HTTP Range) + LAZ 압축 해제
  srcProj, projDef,                     → X/Y/Z/RGB·Intensity/Classification 추출
  geoidOffset, zFactor }                → proj4 변환 + WGS84 Cartesian3
                                         → Float32 high/low 분리 + BoundingSphere
                                                       │
{ posHigh, posLow, colors, cls,  ◀─transfer──────────┘
  pointCount, sphereCenter,
  sphereRadius, seenClasses }
```

---

### 3-5. 좌표 변환 파이프라인 (Worker 내부)

```
Copc.loadPointDataView()  ← fetch(HTTP Range) + LAZ 압축 해제 (laz-perf.wasm)
    │
    │  X/Y/Z/RGB·Intensity/Classification 속성 추출
    ↓
COPC 원본 좌표 (예: EPSG:2992 Oregon Lambert, feet 단위)
    │
    │  proj4: srcProj → EPSG:4326
    ↓
위경도 (lon, lat) + 고도 보정
    고도 = Z_feet × 0.3048 + geoidOffset
    (feet → meters, NAVD88 → WGS84 타원체고 보정)
    │
    │  직접 WGS84 Cartesian3 계산 (Cesium 없이)
    │  N = a / sqrt(1 - e² × sin²(lat))
    │  X = (N + alt) × cos(lat) × cos(lon)
    │  Y = (N + alt) × cos(lat) × sin(lon)
    │  Z = (N(1-e²) + alt) × sin(lat)
    ↓
WGS84 Cartesian3 (Float64 ECEF)
    │
    │  Float32 high/low 분리 (RTE — Relative-to-Eye)
    │  high = Math.fround(x);  low = x - high;
    │  + BoundingSphere(평균 중심/최대거리) 계산
    ↓
메인 스레드로 Transferable 반환 → PointCloudPrimitive GPU 버퍼
```

---

## 4. 프로젝트 구조

```
copc/
├── src/
│   ├── lib/
│   │   ├── CopcDataSource.ts  # 퍼블릭 API — LoD 오케스트레이터
│   │   ├── lod.ts             # BoundingSphere, SSE, 프러스텀 컬링
│   │   ├── loader.ts          # loadNode (PointCloudPrimitive 생성, DrawCommand 기반)
│   │   ├── worker.ts          # fetch+LAZ 디코딩+속성 추출+좌표 변환 (Worker 전용)
│   │   └── WorkerPool.ts      # 고정 크기 Worker 풀, 타임아웃·에러 복구
│   └── main.ts                # 데모 앱 진입점
├── scripts/
│   └── convert-to-copc.mjs   # LAS/LAZ → COPC 변환 CLI
├── docs/                      # 대회 자료, COPC 스펙, 학습 가이드, 성능 분석
├── index.html                 # fetch cache 패치 포함
└── vite.config.js             # cesium 플러그인 + laz-perf 워커 얼라이어싱/wasm 핸들러
```

---

## 5. 빠른 시작

### 설치 및 실행

```bash
git clone https://github.com/seongyooo/copc-cesium
cd copc-cesium
npm install
```

`.env` 파일에 Cesium Ion 토큰 설정:

```
VITE_CESIUM_TOKEN=your_cesium_ion_token
```

```bash
npm run dev
# → http://localhost:5173
```

### 테스트 데이터

```
URL: https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz
좌표계: EPSG:2992 (Oregon Lambert, feet)
포인트: 10,653,336개 | 노드: 278개 | 깊이: 0~5
```

---

## 6. API 레퍼런스

### `CopcDataSource.load(url, viewer, options)`

```javascript
const ds = await CopcDataSource.load(url, viewer, {
  proj:            'EPSG:2992',     // COPC 원본 좌표계
  projDef:         '+proj=lcc ...', // proj4 정의 문자열 (EPSG:4326 외 필수)
  geoidOffset:     -20,             // NAVD88 → WGS84 타원체고 보정 (m)
  concurrency:     5,               // Worker 풀 크기 / 동시 로드 수
  maxCacheNodes:   150,             // LRU 캐시 최대 노드 수 (maxVisibleNodes보다 크게 유지)
  maxVisibleNodes: 100,             // BFS 최대 렌더링 노드 수 (OOM 방지 상한)
  pixelSize:       2,               // 점 크기 (px)
  sseThreshold:    250,             // BFS 확장 임계값 (px). 낮을수록 고해상도, 높을수록 성능 우선
});
```

### 진행 상황 콜백

```javascript
ds.onProgress = ({ depth, visible, culled, loading, points, cached, height, seenClasses }) => {
  // depth:       현재 렌더링 중인 Octree 깊이
  // visible:     화면에 보이는 노드 수
  // culled:      프러스텀 컬링으로 제외된 노드 수
  // loading:     현재 로드 중인 노드 수
  // points:      화면에 표시된 총 점 수
  // cached:      LRU 캐시에 보관된 노드 수
  // height:      카메라 고도 (m)
  // seenClasses: 지금까지 발견된 ASPRS 분류값 집합 (Set<number>)
};
```

### 런타임 세터 (재로드 없이 즉시 반영)

```javascript
ds.pixelSize    = 3;     // 점 크기 변경 (px)
ds.sseThreshold = 150;   // 세밀도 임계값 변경 → _updateLoD 즉시 재실행
ds.heightOffset = -20;   // 고도 보정 오프셋 (m) — 셰이더에 즉시 반영
ds.setClassMask(0b111);  // 분류 필터: 비트 N = 클래스 N 표시 / -1 = 전체
```

### 게터 및 정리

```javascript
ds.maxDepth     // 데이터의 최대 Octree 깊이
ds.nodeCount    // 전체 노드 수
ds.maxCacheNodes // LRU 캐시 최대 크기
ds.cacheSize    // 현재 캐시된 노드 수
ds.seenClasses  // 로드된 노드에서 발견된 분류값 집합 (Set<number>)

ds.destroy()    // 모든 Primitive 제거, Worker 종료, 이벤트 리스너 해제
```

---

## 7. COPC 변환 도구

LAS, LAZ 등 기존 포맷을 COPC로 변환합니다. `pdal` 또는 `untwine`이 PATH에 있어야 합니다.

```bash
# 변환
npm run convert sample.las
npm run convert sample.las output/sample.copc.laz

# pdal 설치 (conda 권장)
conda install -c conda-forge pdal

# 또는 untwine
# https://github.com/hobuinc/untwine/releases
```

변환 없이 즉시 시도하려면 [viewer.copc.io](https://viewer.copc.io) 온라인 변환기를 사용할 수 있습니다.

---

## 8. 기술 결정 기록

### laz-perf.wasm — Worker에서 사용 가능 (이전 기록 정정)

`copc.js`가 내부적으로 `laz-perf.wasm`을 사용하는데, Vite 번들 시 wasm 파일이 출력에 포함되지 않아 404가 발생합니다. `lazPerfWasmPlugin`으로 해결:

- **dev**: 미들웨어가 모든 `laz-perf.wasm` 요청을 가로채 실제 파일 서빙
- **build**: `generateBundle`로 워커 청크와 같은 `assets/` 디렉터리에 wasm 파일을 포함

또한 `copc.js`는 CJS 모듈이라 `optimizeDeps.exclude`로 ESM 변환이 불가합니다.

> 과거 기록에는 "laz-perf.wasm은 Worker에서 사용 불가"라고 되어 있었으나 사실이 아니었습니다.
> `laz-perf` 패키지는 web/node/worker용 빌드를 각각 배포하며(`lib/web`, `lib/node`, `lib/worker`),
> 세 빌드는 컴파일 타임 `ENVIRONMENT_IS_WORKER` 플래그와 스크립트 경로 해석 방식만 다르고
> **실제 .wasm 바이너리는 동일**합니다. 다만 `copc` 패키지가 `require('laz-perf')`로 무조건
> web 빌드를 가져오므로, `vite.config.js`의 worker-scoped `resolveId` 플러그인으로 워커
> 번들링 시에만 `laz-perf` → `laz-perf/lib/worker/index.js`로 바꿔치기했습니다.
>
> 실제 우회 과정에서 두 가지를 더 발견했습니다:
> 1. **Blob URL 워커(`?worker&inline`)에서는 로드 실패**: laz-perf 워커 빌드의 글루 코드는
>    `self.location.href`가 `blob:`으로 시작하면 `scriptDirectory`를 빈 문자열로 처리해
>    `fetch("laz-perf.wasm")`이 base URL 없이 상대경로를 못 만든다
>    (`Failed to parse URL from laz-perf.wasm`). 워커를 `?worker`(실제 URL을 갖는 별도 청크)로
>    분리해서 해결했다.
> 2. **wasm 파일 위치가 워커 청크와 달라도 실패**: 글루 코드는 자기 스크립트 URL 기준
>    상대경로로 `laz-perf.wasm`을 요청한다(`scriptDirectory + 파일명`). wasm을 dist 루트에
>    두면 워커 청크(`dist/assets/worker-*.js`) 입장에선 404 → Vite preview의 SPA 폴백으로
>    `index.html`이 대신 반환되어 `WebAssembly.instantiate(): expected magic word` 에러가
>    난다. wasm을 워커 청크와 같은 `assets/`에 배치해서 해결했다.

### fetch 캐시 패치 (`index.html`)

ES 모듈 호이스팅으로 인해 `import * as Cesium from 'cesium'`이 실행되기 전에 fetch 패치를 적용해야 합니다. `index.html`의 인라인 클래식 스크립트에서 `cache: 'no-store'`를 강제해 `ERR_CACHE_OPERATION_NOT_SUPPORTED`를 방지합니다.

### Worker 역할 분리

fetch(HTTP Range) + LAZ 압축 해제 + 속성 추출 + 좌표 변환까지 전부 Worker에서
수행합니다 (위 "laz-perf.wasm — Worker에서 사용 가능" 참고). 메인 스레드는 결과로 받은
Transferable 버퍼(posHigh/posLow/colors/cls)로 GPU 프리미티브를 조립하는 역할만 합니다.

### Cesium.Primitive 대신 DrawCommand 직접 사용

`Cesium.Primitive`를 사용하면 내부 geometry pipeline이 **batchId 셰이더 코드를 무조건 주입**합니다. 커스텀 셰이더에 `a_batchId` 어트리뷰트가 없으면 `WebGL: INVALID_OPERATION`이 발생합니다. 이를 우회하기 위해 `DrawCommand`를 직접 사용합니다.

- `Cesium.Buffer.createVertexBuffer`로 posHigh/posLow/color 버퍼를 직접 생성
- `Cesium.ShaderProgram.fromCache`로 GLSL ES 3.00 셰이더 컴파일
- `Cesium.DrawCommand`를 `frameState.commandList`에 직접 push
- 결과: batchId pipeline 완전 우회, 메모리 14배 감소 (JS 객체 400B/점 → Float32 GPU 버퍼)

### scene.postUpdate 기반 카메라 감지

초기 구현은 `camera.changed`(위치 변화량 기반, ~1% 임계치)로 LoD를 갱신했습니다. Ctrl+드래그처럼 방향만 바꾸는 소폭 조작에서 이벤트가 발동되지 않아 LoD 갱신이 누락되는 문제가 있었습니다.

현재는 **`scene.postUpdate`(매 프레임)**를 기반으로 두 경로를 분리합니다:
- **빠른 경로**: 매 프레임 즉시 실행. `_lastTargetSet` 범위 내에서만 frustum show/hide.
- **느린 경로**: 200ms 인터벌. BFS 재계산 + 새 노드 로드.

`camera.moveEnd`는 카메라가 완전히 정지했을 때 200ms를 기다리지 않고 `_updateLoD()`를 즉시 실행해 최종 고품질 렌더를 보장합니다.

### Autzen 샘플 데이터 좌표계

```
EPSG:2992 (Oregon Lambert, feet 단위)
Z 보정: × 0.3048 (feet → meters) + (-20m) (NAVD88 → WGS84 타원체고)
```

---

## 9. 의존성

| 패키지 | 용도 |
|--------|------|
| `cesium` | 3D 지구본 렌더링 |
| `copc` | COPC 파싱 (HTTP Range Request + LAZ 디코딩) |
| `proj4` | 좌표계 변환 |
| `vite` | 번들러 / 개발 서버 |
| `vite-plugin-cesium` | Cesium 에셋 자동 복사 |

---

## 라이선스

MIT

---

*2026 오픈소스 개발자대회 제20회 — 가이아쓰리디 지정과제*
