# 아키텍처 및 구현 로직 상세 설명

> `CopcDataSource` 클래스를 중심으로, 개발 과정에서 추가·수정된 모든 로직을 정리한 문서입니다.

---

## 목차

1. [전체 흐름 개요](#1-전체-흐름-개요)
2. [BFS + SSE LoD 선택 알고리즘](#2-bfs--sse-lod-선택-알고리즘)
3. [카메라 이벤트 이중 경로](#3-카메라-이벤트-이중-경로)
4. [씬 관리 — PrimitiveCollection 컨테이너](#4-씬-관리--primitivecollection-컨테이너)
5. [로드 세대(Generation) 취소 메커니즘](#5-로드-세대generation-취소-메커니즘)
6. [동시성 제한 (_runConcurrent)](#6-동시성-제한-_runconcurrent)
7. [BoundingSphere 메모이제이션 (sphereMap)](#7-boundingsphere-메모이제이션-spheremap)
8. [중심 우선 로딩 정렬](#8-중심-우선-로딩-정렬)
9. [LRU 캐시 및 eviction](#9-lru-캐시-및-eviction)
10. [Web Worker 풀 (WorkerPool)](#10-web-worker-풀-workerpool)
11. [rAF 청크 로딩 (loader.js)](#11-raf-청크-로딩-loaderjs)
12. [SSE Threshold 기본값 설계](#12-sse-threshold-기본값-설계)
13. [내부 상태 변수 전체 목록](#13-내부-상태-변수-전체-목록)
14. [옵션 레퍼런스](#14-옵션-레퍼런스)

---

## 1. 전체 흐름 개요

```
CopcDataSource.load(url, viewer, opts)
  └─ _init(url)
       ├─ Copc.create(url)            // HTTP HEAD + 헤더 파싱
       ├─ Copc.loadHierarchyPage()    // 전체 노드 트리 로드
       ├─ camera.flyToBoundingSphere() // 초기 시점 이동
       ├─ _updateLoD()               // 첫 LoD 계산 + 노드 로드
       └─ _startListening()          // 카메라 이벤트 등록

카메라 움직임 감지
  ├─ [빠른 경로] _updateVisibility()  // _lastTargetSet 범위만 frustum on/off
  └─ [느린 경로] setTimeout → _updateLoD()  // BFS 재계산 + 노드 로드/제거
```

`_updateLoD` 내부 단계:

```
1. _selectNodesBFS()     → BFS 탐색, SSE 계산, 중심 우선 정렬
2. 캐시 히트 확인        → 씬에 없으면 container.add, show=true
3. toLoad 정렬           → sphereMap 재사용, 중심 방향 우선
4. _runConcurrent()      → 세대 확인 후 loadNode, 결과 씬에 추가
5. 비대상 노드 제거      → container.remove (show=false 아님)
6. _evict()              → LRU 순 캐시 정리, collection.destroy()
7. 프러스텀 최종 동기화  → targetSet 내에서 show 재확인
```

---

## 2. BFS + SSE LoD 선택 알고리즘

### 핵심 아이디어

Potree가 사용하는 방식과 동일합니다. 고도 기반 깊이 결정이 아니라, **각 노드의 바운딩 스피어가 화면에서 차지하는 픽셀 크기(Screen Space Error)**로 깊이를 결정합니다.

```
SSE = (radius / dist) × (screenHeight / (2 × tan(fovY / 2)))
```

- SSE가 크다 → 화면에서 크게 보인다 → 더 세밀한 자식 노드가 필요
- SSE가 작다 → 화면에서 작게 보인다 → 현재 노드로 충분

### BFS 탐색 규칙

```
루트(0-0-0-0)부터 큐에 넣고 반복:
  - frustum 밖 → 해당 노드 + 자손 전체 스킵 (컬링)
  - pointCount == 0 → 자식만 큐에 추가, 본인은 렌더링 안 함
  - SSE > threshold AND 자식 존재 → 자식을 큐에 추가 (세분화)
  - SSE ≤ threshold OR 자식 없음 → visibleKeys에 추가 (리프)
```

결과: 카메라에 가까운 영역은 깊은 노드, 먼 영역은 얕은 노드가 자연스럽게 혼재합니다.

### 고도 기반 방식과의 차이

| | 고도 기반 (구) | SSE 기반 (현재) |
|---|---|---|
| 기준 | 카메라 고도 | 노드 화면 픽셀 크기 |
| 수평 시점 | 고도 낮아도 멀리 있으면 오류 | dist 기반이라 정확 |
| 혼합 깊이 | 전체 동일 깊이 | 영역마다 다른 깊이 |
| 자식 없는 희소 트리 | 빈 화면 가능 | BFS가 자연히 처리 |

### 구현 위치

- SSE 공식: `src/lib/lod.js` → `screenSpaceError()`
- BFS 탐색: `src/lib/CopcDataSource.js` → `_selectNodesBFS()`

---

## 3. 카메라 이벤트 이중 경로

카메라가 움직일 때 두 가지 경로가 분리되어 실행됩니다.

```
camera.changed 이벤트
  │
  ├─ [즉시] _updateVisibility()   ← 빠른 경로
  │         _lastTargetSet 범위 내에서만 frustum show/hide
  │
  └─ [debounceMs 후] _updateLoD() ← 느린 경로
                     BFS 재계산 + 네트워크 요청
```

### 빠른 경로가 필요한 이유

카메라가 패닝/회전할 때마다 BFS + 네트워크 요청을 실행하면 과부하가 발생합니다. 빠른 경로는 이미 로드된 노드들만 보이는지 여부를 빠르게 갱신합니다.

### `_lastTargetSet`이 중요한 이유

초기 버전에서는 `_cache` 전체를 순회했는데, 이렇게 하면 LoD로 숨긴 깊은 노드가 카메라 이동 시 다시 `show=true`가 되는 버그가 발생했습니다.

```
수정 전 (버그):
  for ([key, data] of this._cache)  // 캐시 전체 순회
    data.collection.show = isInFrustum(...)  // LoD 숨긴 노드도 다시 살아남

수정 후:
  for (key of this._lastTargetSet)  // 마지막 LoD 선택 범위만
    this._cache.get(key)?.collection.show = isInFrustum(...)
```

`_lastTargetSet`은 `_updateLoD`에서 BFS 결과가 나오는 즉시 저장됩니다.

---

## 4. 씬 관리 — PrimitiveCollection 컨테이너

### 문제: Cesium의 자동 destroy

`scene.primitives`의 기본 설정은 `destroyPrimitives: true`입니다. `primitives.remove(collection)`을 호출하면 Cesium이 **자동으로 `collection.destroy()`를 실행**합니다.

캐시에서 노드를 꺼내 재추가하려 할 때 이미 파괴된 객체라 `DeveloperError: This object was destroyed` 에러가 발생했습니다.

### 해결: 전용 컨테이너

```js
this._container = new Cesium.PrimitiveCollection({ destroyPrimitives: false });
viewer.scene.primitives.add(this._container);
```

씬에는 이 컨테이너 하나만 추가하고, 모든 point cloud 컬렉션은 `this._container`를 통해 add/remove합니다. `destroyPrimitives: false`이므로 remove해도 객체가 살아있어 캐시에서 꺼내 재추가할 수 있습니다.

실제 WebGL 해제는 `_evict`에서 명시적으로 `collection.destroy()`를 호출합니다.

### show=false 대신 remove/add

```
이전 방식:
  비대상 노드 → collection.show = false
  (Cesium 업데이트 루프에서 계속 순회, GPU 버퍼 잔류)

현재 방식:
  비대상 노드 → this._container.remove(collection)
  (Cesium 업데이트 루프 대상에서 완전히 제외)
  캐시에는 유지 → 재진입 시 this._container.add(collection)로 즉시 복원
```

`_inScene` Set이 현재 컨테이너에 들어있는 키를 추적합니다.

---

## 5. 로드 세대(Generation) 취소 메커니즘

### 문제

줌인 후 깊은 노드 20개를 로딩 중에 줌아웃하면, 20개가 모두 끝날 때까지 줌아웃 LoD 계산이 시작되지 않습니다. `_isUpdating = true`인 동안 새 `_updateLoD`는 `_pendingUpdate = true`만 설정하고 대기하기 때문입니다.

### 해결: _loadGen 세대 번호

```js
// 카메라 핸들러에서
if (h > prevHeight) this._loadGen++;  // 줌아웃 시에만 증가

// _updateLoD 시작 시
const gen = this._loadGen;  // 현재 세대 캡처

// loadNode 호출 전
if (gen !== this._loadGen) return;  // 세대 바뀌면 스킵

// loadNode 완료 후
if (gen !== this._loadGen) {
  data.collection.destroy();  // 결과 폐기
  return;
}
```

### 줌인/줌아웃 비대칭 처리

| 동작 | 고도 변화 | `_loadGen` | 이유 |
|---|---|---|---|
| 줌인 | 감소 | 유지 | 얕은 캐시가 placeholder 역할, 진행 중 로딩 유지가 자연스러움 |
| 줌아웃 | 증가 | +1 | 깊은 노드 로딩을 즉시 폐기, 빠르게 얕은 LoD로 전환 |
| 패닝/회전 | 거의 변화 없음 | 유지 | 같은 깊이 수준이므로 로딩 유지 |

네트워크 fetch 자체는 취소 불가하지만, 완료된 결과를 씬에 추가하지 않고 즉시 파기합니다.

---

## 6. 동시성 제한 (_runConcurrent)

### 문제

기존 `Promise.all(tasks.map(t => t()))`는 노드가 100개면 100개 `loadNode`를 동시에 시작합니다. `loadNode`는 `pool.run` 전에도 이미 `Float64Array × 3 + Float32Array × 3`를 메인 스레드에서 할당하므로, 100개 동시 = 수백 MB 즉시 소모 → Out of Memory.

```
노드당 메모리 (예: 10만 포인트):
  xs/ys/zs: Float64Array × 3 = 100k × 8 × 3 = 2.4MB
  rs/gs/bs: Float32Array × 3 = 100k × 4 × 3 = 1.2MB
  합계: ~3.6MB × 동시 실행 수
```

### 해결: 진짜 동시성 제한

```js
async _runConcurrent(tasks) {
  const limit   = this._opts.concurrency;  // 기본 5
  const running = new Set();
  for (const task of tasks) {
    const p = task().finally(() => running.delete(p));
    running.add(p);
    if (running.size >= limit) await Promise.race(running);  // 하나 끝날 때까지 대기
  }
  if (running.size > 0) await Promise.all(running);
}
```

`Promise.race`로 실행 중인 작업이 `concurrency` 개를 넘지 않도록 제어합니다. 하나가 끝나면 다음 작업을 시작합니다.

---

## 7. BoundingSphere 메모이제이션 (sphereMap)

### 문제

`_sphere(key)` 는 내부적으로 `proj4` 좌표 변환을 실행합니다. `_selectNodesBFS`의 sort 비교자는 O(n log n)번 호출되며, 같은 키에 대해 `_sphere()`를 반복 호출했습니다.

```
100개 노드 sort → ~700번 비교 × 키당 2회 = ~1400번 proj4 호출
proj4 호출당 ~0.1ms → 140ms 메인 스레드 블로킹
```

줌 레벨 전환 시마다 이 블로킹이 발생해 렉이 느껴졌습니다.

### 해결: sphereMap 캐시

```js
const sphereMap = new Map();
const getSphere = (key) => {
  let s = sphereMap.get(key);
  if (!s) { s = this._sphere(key); sphereMap.set(key, s); }
  return s;
};
```

BFS 루프에서 처음 계산된 BoundingSphere를 Map에 저장하고, sort와 `_updateLoD`의 `toLoad.sort`에서 O(1)로 재사용합니다. proj4 호출이 노드당 1회로 줄어듭니다.

`sphereMap`은 `_selectNodesBFS`의 반환값에 포함되어 `_updateLoD`로 전달됩니다.

---

## 8. 중심 우선 로딩 정렬

### BFS는 레벨 순 탐색

BFS는 루트 → 레벨1 → 레벨2 순서로 탐색하므로, 같은 레벨 내 노드는 카메라 방향과 무관한 순서로 큐에 쌓입니다.

### 정렬 기준: 카메라 방향 dot product

```js
visibleKeys.sort((a, b) => {
  // a 방향 벡터와 카메라 방향의 내적
  const dotA = dot(normalize(sphere_a.center - camPos), camDir);
  const dotB = dot(normalize(sphere_b.center - camPos), camDir);
  return dotB - dotA;  // dot이 클수록 화면 중심에 가까움
});
```

내적이 1에 가까울수록 카메라가 정면으로 바라보는 노드 → 먼저 로드됩니다.

가장자리 노드는 잘라내지 않고 **우선순위만 뒤로 밀립니다**. `_runConcurrent`의 concurrency 제한(기본 5)과 함께 동작해, 중심 5개가 먼저 로드 완료된 후 가장자리 노드들이 순차 로드됩니다.

---

## 9. LRU 캐시 및 eviction

### 캐시 구조

```
this._cache: Map<key, { collection, pointCount, lastUsed }>
this._inScene: Set<key>  // 현재 container에 들어있는 키
this._lastTargetSet: Set<key>  // 마지막 LoD 선택 결과
```

### 캐시 생명 주기

```
loadNode 완료
  → cache.set(key, data)
  → container.add(collection)
  → inScene.add(key)

_updateLoD: 비대상 노드
  → container.remove(collection)   // 씬에서 제거
  → inScene.delete(key)
  → cache에는 유지

_updateLoD: 캐시 히트 (재진입)
  → inScene에 없으면 container.add(collection)  // 씬에 재추가
  → show = true

_evict: cache.size > maxCacheNodes
  → lastUsed 오름차순 정렬 → 가장 오래된 것부터 제거
  → collection.destroy()  // WebGL 버퍼 해제
  → cache.delete(key)
```

### eviction 시 주의

`_evict`는 `keepSet`(현재 targetSet)에 포함된 노드는 건드리지 않습니다. 현재 화면에 필요한 노드를 실수로 파기하는 것을 방지합니다.

---

## 10. Web Worker 풀 (WorkerPool)

좌표 변환(proj4 + WGS84 Cartesian3 계산)은 CPU 집약적이므로 Web Worker에서 실행합니다. `laz-perf.wasm`(LAZ 디코딩)은 Worker에서 동작하지 않아 메인 스레드에서 실행합니다.

```
메인 스레드               Worker
──────────────────────    ────────────────────────
fetch + LAZ 파싱          proj4 변환 (EPSG → WGS84)
  (Copc.loadPointDataView)  Cartesian3 계산
raw 배열 → Transferable →  → positions/colors 배열
← Transferable 결과 ←
PointPrimitiveCollection 생성 (WebGL 필요)
```

### WorkerPool 주요 로직

| 기능 | 구현 |
|---|---|
| 고정 크기 풀 | 생성자에서 `size`개 Worker 생성 |
| 큐잉 | 유휴 Worker 없으면 `_queue`에서 대기 |
| 타임아웃 | 30초 후 자동 reject, `settled` 플래그로 중복 방지 |
| 크래시 복구 | `onerror`에서 해당 Worker pending 전부 reject 후 교체 Worker 생성 |
| Transferable | ArrayBuffer 소유권 이전으로 복사 없는 전송 |

---

## 11. rAF 청크 로딩 (loader.js)

### 문제

`PointPrimitiveCollection.add()`를 수만 번 동기 호출하면 메인 스레드가 수백ms 블로킹됩니다.

### 해결: requestAnimationFrame 청크

```js
const CHUNK = 3000;
for (let start = 0; start < pointCount; start += CHUNK) {
  // CHUNK개 포인트 추가
  if (end < pointCount)
    await new Promise(r => requestAnimationFrame(r));  // 렌더 프레임 양보
}
```

3000개씩 추가한 뒤 다음 rAF까지 제어를 돌려줍니다. 로딩 중에도 Cesium이 정상적으로 렌더링됩니다.

scratch 객체(`scratchPos`, `scratchColor`) 재사용으로 GC 압박도 최소화합니다.

---

## 12. SSE Threshold 기본값 설계

### 초기 뷰에서의 SSE 계산

초기 카메라 위치는 `rootSphere.radius × 4` 거리입니다.

```
SSE_root = (radius / (4 × radius)) × (screenHeight / (2 × tan(fovY/2)))
         = 0.25 × screenHeight / (2 × tan(30°))
         ≈ 0.25 × 935   (1080p, fovY=60° 기준)
         ≈ 234px
```

루트 노드(depth 0)가 초기 뷰에서 즉시 선택되려면 `sseThreshold ≥ 234`이어야 합니다. 기본값을 **250px**로 설정한 이유입니다.

### 거리별 선택 깊이 예시 (1080p, autzen 데이터셋 기준)

| 카메라 거리 | SSE_root | 선택 depth |
|---|---|---|
| radius × 4 (초기 조망) | 234px < 250 | **0** (루트 즉시) |
| radius × 2 | 468px | 1 |
| radius × 1 | 936px | 2~3 |
| radius × 0.5 | 1872px | 3~4 |
| radius × 0.1 | 9360px | 5~6 |

낮출수록 더 세밀(깊은 깊이), 높일수록 성능 우선입니다.

---

## 13. 내부 상태 변수 전체 목록

| 변수 | 타입 | 역할 |
|---|---|---|
| `_viewer` | `Cesium.Viewer` | CesiumJS 뷰어 참조 |
| `_opts` | `object` | 병합된 옵션 |
| `_pool` | `WorkerPool` | Worker 풀 |
| `_container` | `PrimitiveCollection` | `destroyPrimitives:false` 전용 컨테이너 |
| `_cache` | `Map<key, data>` | 로드된 노드 LRU 캐시 |
| `_inScene` | `Set<key>` | 현재 `_container`에 추가된 키 집합 |
| `_lastTargetSet` | `Set<key>` | 마지막 LoD 선택 결과 (빠른 경로용) |
| `_isUpdating` | `boolean` | `_updateLoD` 실행 중 플래그 |
| `_pendingUpdate` | `boolean` | 로딩 중 카메라 이동 → 완료 후 재실행 예약 |
| `_debounceTimer` | `number` | debounce setTimeout ID |
| `_loadGen` | `number` | 로드 세대 번호 (줌아웃 시 증가) |
| `_removeCameraListener` | `function` | 카메라 이벤트 해제 함수 |
| `_url` | `string` | COPC 파일 URL |
| `_copc` | `object` | `Copc.create()` 반환값 |
| `_nodes` | `object` | 전체 Octree 노드 맵 |
| `_rootCenter` | `{x,y,z}` | 루트 노드 중심 (COPC 좌표) |
| `_rootHalfSize` | `number` | 루트 노드 절반 크기 |
| `_maxDepth` | `number` | 데이터 최대 깊이 |

---

## 14. 옵션 레퍼런스

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `proj` | `'EPSG:4326'` | COPC 데이터 좌표계 |
| `projDef` | `null` | proj4 정의 문자열 (proj ≠ 4326일 때 필수) |
| `geoidOffset` | `0` | 지오이드 보정값 (m) |
| `concurrency` | `5` | 동시 노드 로드 수 / Worker 풀 크기 |
| `debounceMs` | `300` | 카메라 정지 후 LoD 갱신 대기 시간 (ms) |
| `maxCacheNodes` | `80` | LRU 캐시 최대 노드 수 |
| `maxVisibleNodes` | `100` | BFS 최대 후보 노드 수 (OOM 방지 상한) |
| `pixelSize` | `2` | 점 크기 (px) |
| `sseThreshold` | `250` | BFS 확장 임계값 (px). 낮을수록 세밀, 높을수록 성능 우선 |

### 성능 튜닝 가이드

```js
// FPS 우선 (저사양)
{
  sseThreshold:    400,   // 덜 세밀하게
  maxVisibleNodes: 50,    // BFS 후보 제한
  maxCacheNodes:   40,    // GPU 메모리 절약
  concurrency:     3,     // 동시 로드 감소
}

// 품질 우선 (고사양)
{
  sseThreshold:    100,   // 더 세밀하게
  maxVisibleNodes: 150,
  maxCacheNodes:   120,
  concurrency:     8,
}
```
