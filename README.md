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
│  ├─ camera.changed → updateVisibility() [빠른 경로]          │
│  └─ debounce 300ms → _updateLoD()      [느린 경로]           │
│       │                                                     │
│       ├─ 1. distanceToDepth()  ← scene.globe.pick           │
│       ├─ 2. _candidatesAt()    ← Octree 노드 필터링           │
│       ├─ 3. isInFrustum()      ← 프러스텀 컬링                │
│       ├─ 4. LRU 캐시 히트 확인                                │
│       └─ 5. loadNode()         ← 캐시 미스                   │
│              ├─ Copc.loadPointDataView()  (fetch + LAZ 파싱) │
│              └─ pool.run()  ──────────────────────────────┐ │
│                                                           │ │
│  PointPrimitiveCollection ←── rAF 청크 추가                │ │
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

### 3-1. LoD (Level of Detail) — 거리 기반 깊이 선택

카메라와 화면 중앙 지점 사이의 **실제 3D 거리**로 Octree 깊이를 결정합니다.

```
거리 ≤ 200m  →  maxDepth (최고 해상도)
거리 ≥ 8000m →  depth 0  (최저 해상도)
그 사이      →  로그 스케일 보간
```

```
targetDepth = round((1 - log(dist/NEAR) / log(FAR/NEAR)) × maxDepth)
```

#### 고도 기반 방식 vs 거리 기반 방식

```
[고도 기반 - 구 방식]              [거리 기반 - 현재]
카메라 고도만 봄                   화면 중앙에 ray를 쏴서
→ 수평 시점에서 고도가 낮아도       실제 지표까지의 거리 측정
  실제 데이터는 멀리 있음           → 어느 방향에서 봐도 정확한 LoD

       👆 45°                            👆 45°     →→ 0°
       카메라                            카메라
       고도:100m                         거리:141m    거리:500m
       → depth 5 (맞음)                  → depth 5    → depth 3 (맞음)
```

**pick 실패 시 fallback 순서:**
1. `scene.globe.pick()` — terrain 반영 지표면
2. `IntersectionTests.rayEllipsoid()` — 타원체 교차
3. 카메라 고도 직접 사용

#### 프러스텀 fallback

같은 깊이에 노드가 없거나 모두 frustum 밖이면 자동으로 더 얕은 깊이로 내려갑니다. 빈 화면을 방지합니다.

```javascript
// depth 5 노드가 모두 frustum 밖이면 depth 4 → 3 → ... 순으로 fallback
if (visibleKeys.length === 0 && targetDepth > 0) {
  for (let d = targetDepth - 1; d >= 0; d--) { ... }
}
```

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
camera.changed
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

eviction 조건: cache.size > maxCacheNodes (기본 80)
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

### 3-5. 메인 스레드 블로킹 방지 (rAF 청크)

`PointPrimitiveCollection`에 수만 개의 점을 한 번에 추가하면 메인 스레드가 수백 ms 동안 블로킹됩니다. `requestAnimationFrame`으로 프레임마다 청크씩 나눠 추가합니다.

```
pointCount = 50,000, CHUNK = 3,000
→ 17프레임 × ~16ms = ~280ms 분산 처리
→ UI 블로킹 없이 Cesium이 중간 프레임 렌더링 가능

또한 scratch 객체 재사용으로 GC 압박 최소화:
  new Cartesian3() × 50,000 → scratch 1개 재사용
  (collection.add() 내부에서 값 복사 보장)
```

---

### 3-6. 좌표 변환 파이프라인

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
WGS84 Cartesian3 (Cesium 렌더링 좌표)
```

---

## 4. 프로젝트 구조

```
copc/
├── src/
│   ├── lib/
│   │   ├── CopcDataSource.js  # 퍼블릭 API — LoD 오케스트레이터
│   │   ├── lod.js             # distanceToDepth, BoundingSphere, 프러스텀 컬링
│   │   ├── loader.js          # loadNode (메인스레드: fetch+파싱+청크 추가)
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
  maxCacheNodes: 80,                // LRU 캐시 최대 노드 수
  pixelSize:     2,                 // 점 크기 (px)
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
