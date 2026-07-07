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
│  ├─ camera.changed  → updateVisibility() [빠른 경로]         │
│  ├─ camera.moveEnd  → updateVisibility() [방향 변경 감지]     │
│  └─ debounce 300ms  → _updateLoD()      [느린 경로]          │
│       │                                                     │
│       ├─ 1. _selectNodesBFS()  ← BFS + SSE LoD 선택          │
│       │      ├─ 루트부터 너비 우선 탐색                         │
│       │      ├─ 노드별 screenSpaceError() 계산                 │
│       │      └─ SSE > threshold → 자식 확장                   │
│       ├─ 2. LRU 캐시 히트 확인                                │
│       └─ 3. loadNode()         ← 캐시 미스                   │
│              ├─ Copc.loadPointDataView()  (fetch + LAZ 파싱) │
│              └─ pool.run()  ──────────────────────────────┐ │
│                                                           │ │
│  PointCloudPrimitive (DrawCommand) ← GPU 지연 초기화       │ │
│                                                           │ │
└───────────────────────────────────────────────────────────┼─┘
                                                            │
┌───────────────────────────────────────────────────────────┼─┐
│                     Web Worker (×N)                        │ │
│                                                           │ │
│  worker.js  ◄─────────────────────────────────────────────┘ │
│  ├─ proj4: srcProj → EPSG:4326                              │
│  └─ lonLatAlt → WGS84 Cartesian3 (Cesium 없이 직접 계산)     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 역할 분리 원칙

| 역할 | 스레드 | 이유 |
|------|--------|------|
| COPC 헤더·계층 파싱 | 메인 | `Copc.create()` 비동기 API |
| LAZ 압축 해제 | 메인 | `laz-perf.wasm`은 Worker에서 사용 불가 |
| 좌표 변환 (proj4 + WGS84) | **Worker** | CPU 집약 작업, 메인 스레드 블로킹 방지 |
| Primitive 생성 (WebGL) | 메인 | WebGL 컨텍스트는 메인 스레드 전용 |

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
camera.changed / camera.moveEnd
  ├─ [빠른 경로] !isUpdating → updateVisibility()
  │   캐시된 노드만 show/hide, 새 로드 없음, 즉시 실행
  │
  └─ [느린 경로] debounce 300ms → _updateLoD()
      새 노드 로드, LoD 재계산
      isUpdating = true 동안 빠른 경로 차단 (race condition 방지)
```

---

### 3-3. LRU 노드 캐싱

한 번 로드한 노드를 캐시에 유지해 카메라 이동 시 재사용합니다.

```
캐시: Map<key, { collection, pointCount, lastUsed }>

eviction 조건: cache.size > maxCacheNodes (기본 40)
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

고정 크기 Worker 풀로 좌표 변환 병렬 처리합니다.

```
WorkerPool (size = concurrency)
  ├─ idle[]: 유휴 Worker 목록
  ├─ queue[]: 대기 중인 작업
  └─ pending: Map<id, {resolve, reject, worker}>

run(msg, transfer) → Promise
  유휴 Worker 있으면 즉시 실행, 없으면 queue 대기
  30초 타임아웃 — hung Worker 시 자동 reject
  Worker 크래시 → pending reject + 새 Worker 자동 교체
```

**Transferable Objects** — 버퍼 복사 없이 Worker로 이동:

```
메인 스레드                    Worker
Float64Array (xs,ys,zs) ──transfer──▶ proj4 변환
Float32Array (rs,gs,bs) ──transfer──▶ 색상 정규화
                                       ↓
Float64Array (positions) ◀─transfer── WGS84 Cartesian3
Float32Array (colors)    ◀─transfer── RGBA [0,1]
```

---

### 3-5. 좌표 변환 파이프라인

```
COPC 원본 좌표 (예: EPSG:2992 Oregon Lambert, feet 단위)
    │
    │  proj4: srcProj → EPSG:4326
    ↓
위경도 (lon, lat) + 고도 보정
    고도 = Z_feet × 0.3048 + geoidOffset
    (feet → meters, NAVD88 → WGS84 타원체고 보정)
    │
    │  직접 WGS84 Cartesian3 계산 (Worker에서 Cesium 없이)
    │  N = a / sqrt(1 - e² × sin²(lat))
    │  X = (N + alt) × cos(lat) × cos(lon)
    │  Y = (N + alt) × cos(lat) × sin(lon)
    │  Z = (N(1-e²) + alt) × sin(lat)
    ↓
WGS84 Cartesian3 (Float64 ECEF)
    │
    │  Float32 high/low 분리 (RTE — Relative-to-Eye)
    │  high = Math.fround(x);  low = x - high;
    ↓
PointCloudPrimitive GPU 버퍼 (Float32 × 2 채널)
```

---

## 4. 프로젝트 구조

```
copc/
├── src/
│   ├── lib/
│   │   ├── CopcDataSource.js  # 퍼블릭 API — LoD 오케스트레이터
│   │   ├── lod.js             # distanceToDepth, BoundingSphere, 프러스텀 컬링
│   │   ├── loader.js          # loadNode (PointCloudPrimitive 생성, DrawCommand 기반)
│   │   ├── worker.js          # proj4 변환 + WGS84 Cartesian3 (Worker 전용)
│   │   └── WorkerPool.js      # 고정 크기 Worker 풀, 타임아웃·에러 복구
│   └── main.js                # 데모 앱 진입점
├── scripts/
│   └── convert-to-copc.mjs   # LAS/LAZ → COPC 변환 CLI
├── docs/                      # 대회 자료, COPC 스펙, 학습 가이드
├── index.html                 # fetch cache 패치 포함
└── vite.config.js             # cesium 플러그인 + laz-perf.wasm 핸들러
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
  proj:          'EPSG:2992',       // COPC 원본 좌표계
  projDef:       '+proj=lcc ...',   // proj4 정의 문자열 (EPSG:4326 외 필수)
  geoidOffset:   -20,               // NAVD88 → WGS84 타원체고 보정 (m)
  concurrency:   5,                 // Worker 풀 크기 / 동시 로드 수
  debounceMs:    300,               // 카메라 정지 후 LoD 갱신 대기 (ms)
  maxCacheNodes: 40,                // LRU 캐시 최대 노드 수 (80→40으로 변경: DrawCommand 방식은 노드당 메모리가 적어 캐시 상한을 낮춰도 동일 체감 품질)
  pixelSize:     2,                 // 점 크기 (px)
  sseThreshold:  250,               // BFS 확장 임계값 (px). 낮을수록 고해상도, 높을수록 성능 우선
});
```

### 진행 상황 콜백

```javascript
ds.onProgress = ({ depth, visible, culled, loading, points, cached, height }) => {
  // depth:   현재 렌더링 중인 Octree 깊이
  // visible: 화면에 보이는 노드 수
  // culled:  프러스텀 컬링으로 제외된 노드 수
  // loading: 현재 로드 중인 노드 수
  // points:  화면에 표시된 총 점 수
  // cached:  LRU 캐시에 보관된 노드 수
  // height:  카메라 고도 (m)
};
```

### 게터 및 정리

```javascript
ds.maxDepth       // 데이터의 최대 Octree 깊이
ds.nodeCount      // 전체 노드 수
ds.maxCacheNodes  // LRU 캐시 최대 크기
ds.cacheSize      // 현재 캐시된 노드 수

ds.destroy()      // 모든 Primitive 제거, Worker 종료, 이벤트 리스너 해제
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

### laz-perf.wasm — Worker에서 사용 불가

`copc.js`가 내부적으로 `laz-perf.wasm`을 사용하는데, Vite 번들 시 wasm 파일이 출력에 포함되지 않아 404가 발생합니다. `lazPerfWasmPlugin`으로 해결:

- **dev**: 미들웨어가 모든 `laz-perf.wasm` 요청을 가로채 실제 파일 서빙
- **build**: `generateBundle`로 wasm 파일을 출력에 포함

또한 `copc.js`는 CJS 모듈이라 `optimizeDeps.exclude`로 ESM 변환이 불가합니다.

### fetch 캐시 패치 (`index.html`)

ES 모듈 호이스팅으로 인해 `import * as Cesium from 'cesium'`이 실행되기 전에 fetch 패치를 적용해야 합니다. `index.html`의 인라인 클래식 스크립트에서 `cache: 'no-store'`를 강제해 `ERR_CACHE_OPERATION_NOT_SUPPORTED`를 방지합니다.

### Worker 역할 분리

`laz-perf.wasm`이 Worker에서 작동하지 않으므로 LAZ 파싱은 메인 스레드에서 수행합니다. Worker는 CPU 집약적인 proj4 좌표 변환만 담당하며, Transferable로 버퍼를 zero-copy 전달합니다.

### Cesium.Primitive 대신 DrawCommand 직접 사용

`Cesium.Primitive`를 사용하면 내부 geometry pipeline이 **batchId 셰이더 코드를 무조건 주입**합니다. 커스텀 셰이더에 `a_batchId` 어트리뷰트가 없으면 `WebGL: INVALID_OPERATION`이 발생합니다. 이를 우회하기 위해 `DrawCommand`를 직접 사용합니다.

- `Cesium.Buffer.createVertexBuffer`로 posHigh/posLow/color 버퍼를 직접 생성
- `Cesium.ShaderProgram.fromCache`로 GLSL ES 3.00 셰이더 컴파일
- `Cesium.DrawCommand`를 `frameState.commandList`에 직접 push
- 결과: batchId pipeline 완전 우회, 메모리 14배 감소 (JS 객체 400B/점 → Float32 GPU 버퍼)

### camera.moveEnd 추가

`camera.changed`는 카메라 **위치** 변화량 기반으로 발동합니다. Ctrl+드래그로 방향(direction)만 바꾸는 경우 위치가 고정되어 `changed`가 발동되지 않고 LoD 갱신이 누락되는 문제가 있었습니다. `camera.moveEnd`를 동일 handler로 추가 구독해 방향 변경도 감지합니다.

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
