# 렌더링/LoD 파이프라인 성능 분석

작성일: 2026-07-23
범위: 신규 기능 추가 전, 매 프레임/매 노드 로드마다 반복 실행되는 핫 패스 위주로 점검.
실측 프로파일링(Chrome Performance 탭 등)은 아직 진행하지 않았으며, 코드 리딩 기반의
1차 분석입니다. 우선순위는 "실행 빈도 × 실행 비용" 기준으로 매겼습니다.

---

## 🔥 빠르고 확실한 개선 (자체완결적, 리스크 낮음)

### 1. `_selectNodesBFS`의 우선순위 큐가 배열 정렬 방식 — 가장 큰 핫스팟

**위치:** `src/lib/CopcDataSource.ts:347-381`

노드를 확장할 때마다 `pq.push()` 후 `pq.sort((a,b) => b.sse - a.sse)`로 배열
전체를 재정렬(O(n log n))하고, `pq.shift()`(O(n) 배열 시프트)로 꺼냅니다.

```ts
const pq: Array<{ key: string; sse: number }> = [{ key: '0-0-0-0', sse: rootSse }];

while (pq.length > 0) {
  const { key } = pq.shift()!;               // O(n)
  ...
  for (const k of children) {
    pq.push({ key: k, sse: screenSpaceError(getSphere(k), camera, scene) });
  }
  pq.sort((a, b) => b.sse - a.sse);           // O(n log n) — 확장할 때마다
  ...
}
```

이 로직은 카메라가 움직이는 동안 200ms마다(`_startListening`, `:558-588`)
실행되며, 순회하는 내부 노드 수에 비례해 비용이 커집니다. New Zealand
프리셋(44~45M pts)처럼 옥트리가 깊은 데이터셋에서는 체감 차이가 클 수 있습니다.

**개선안:** 실제 이진 힙(binary heap)으로 교체 → 삽입/추출을 O(log n)으로 축소.

---

### 2. `_sphere()`의 heightOffset 보정이 매 호출마다 새 객체 할당

**위치:** `src/lib/CopcDataSource.ts:286-306`

지난 QA 패스(heightOffset 컬링 정확도 수정)에서 추가된 코드로,
`heightOffset ≠ 0`일 때 `_sphere(key)`를 호출할 때마다 `Cartesian3` 2개 +
`BoundingSphere` 1개를 새로 할당합니다.

```ts
const offset = this._heightOffsetRef.value;
if (offset === 0) return s;
const shift  = Cesium.Cartesian3.multiplyByScalar(this._upVecRef.value, offset, new Cesium.Cartesian3());
const center = Cesium.Cartesian3.add(s.center, shift, new Cesium.Cartesian3());
return new Cesium.BoundingSphere(center, s.radius);
```

`_sphere()`는 BFS 순회 중 노드당 여러 번(트리 확장 시 자식 스캔, 가시성
갱신 등) 호출되므로, heightOffset을 조정 중일 때 GC 압박이 늘어납니다.

**개선안:** key별로 "마지막 적용된 offset 값 + 보정된 sphere"를 캐시하고,
offset이 실제로 바뀔 때만 재계산.

---

### 3. `WorkerPool._flush()`의 `_queue.shift()`도 동일 패턴

**위치:** `src/lib/WorkerPool.ts:143-149`

```ts
private _flush(): void {
  while (this._idle.length > 0 && this._queue.length > 0) {
    const worker = this._idle.pop()!;
    const { id, msg, transfer, resolve, reject } = this._queue.shift()!;  // O(n)
    ...
  }
}
```

큐에서 꺼낼 때마다 O(n) 시프트. 노드가 많이 몰릴 때(동시 로드 대기열,
`maxVisibleNodes` 기본 100) 누적됩니다.

**개선안:** 인덱스 커서 기반 디큐로 교체.

---

## ⚙️ 중간 난이도, 확실한 효과

### 4. `viewer.scene.requestRenderMode` 미사용 — 정적 화면에서도 매 프레임 풀 렌더링

**위치:** `src/main.ts:9-19` (Viewer 생성 옵션)

`requestRenderMode`를 설정하지 않아 기본값(연속 렌더링)으로 동작합니다.
카메라가 정지해 있고 아무 것도 안 바뀌어도 계속 씬을 다시 그리는 중입니다
(테스트 중 79~121 FPS가 계속 찍힘 — 정적 뷰에서도 GPU/CPU를 상시 소모).

이 앱은 애니메이션 엔티티가 없는 정적 포인트클라우드 뷰어 특성상
`requestRenderMode: true`로 전환하고, 다음 시점에 명시적으로
`viewer.scene.requestRender()`를 호출하는 방식이 적합합니다.

- 슬라이더/필터 변경 (pixelSize, sseThreshold, classMask, heightOffset)
- 노드가 캐시/씬에 추가·제거될 때 (`_updateLoD` 내부)
- 카메라 이동은 Cesium이 자동으로 재렌더 요청함 (별도 처리 불요)

**주의:** 호출 지점을 빠짐없이 챙기지 않으면 "조작했는데 화면이 안 바뀜"
같은 회귀 버그가 생기므로 신중한 작업과 꼼꼼한 수동 테스트가 필요합니다.

---

### 5. 노드 로드 완료마다 진행 상태 emit이 즉시 DOM에 반영됨

**위치:** `src/lib/CopcDataSource.ts:472-479`(`makeLoadTask` 내부 `_emit`)
→ `src/main.ts:494-521`(`onProgress` 핸들러)

매 노드 로드 완료마다 `chipDot`/`ftNodes`/`ftElev`/`infoStatus` 텍스트를
갱신합니다. 개별 쓰기 자체는 저렴하지만(전체 `innerHTML` 재구성은
`points`가 있는 마지막 emit에서만 발생), 노드가 한꺼번에 몰려 로드될 때
불필요하게 잦은 DOM 갱신이 발생합니다.

**개선안:** ~100ms 간격으로 코일레싱(마지막 상태만 반영). 우선순위는 낮은 편.

---

## 🏗️ 더 큰 구조적 레버 (참고용 — 이번 패스 범위 밖)

### 6. ~~포인트 속성 추출 루프가 메인 스레드에서 실행됨~~ — ✅ 해결됨 (2026-07-23)

`Copc.loadPointDataView()`(fetch + LAZ 압축 해제) 호출 자체를 `worker.ts`로 옮겨서,
속성 추출부터 좌표 변환까지 전부 워커 안에서 수행하도록 재구성했다. 메인 스레드는
결과 버퍼(posHigh/posLow/colors/cls)로 GPU 프리미티브만 조립한다.

핵심은 `laz-perf`(copc.js가 내부적으로 쓰는 wasm 모듈)가 web/node/worker용 빌드를
각각 배포한다는 점 — 실제 wasm 바이너리는 동일하고 JS 글루 코드의
`ENVIRONMENT_IS_WORKER` 플래그만 다르다. `vite.config.js`에 worker 전용
`resolveId` 플러그인을 추가해 워커 번들링 시에만 `laz-perf` → `laz-perf/lib/worker/index.js`로
바꿔치기했다. 우회 과정에서 두 가지를 추가로 발견/수정:

- Blob URL 워커(`?worker&inline`)에서는 laz-perf 글루 코드가 `self.location.href`의
  `blob:` 프리픽스를 보고 `scriptDirectory`를 빈 문자열로 처리해 `fetch("laz-perf.wasm")`이
  실패한다(`Failed to parse URL`) — `?worker`(실제 URL을 갖는 별도 청크)로 전환해 해결.
- wasm 자산을 워커 청크와 다른 디렉터리에 두면, 글루 코드의 스크립트-상대경로 요청이
  404 → SPA 폴백(`index.html`)을 받아 `WebAssembly.instantiate(): expected magic word`
  에러가 난다 — wasm을 워커 청크와 같은 `dist/assets/`에 배치해 해결.

자세한 배경은 README.md §8 "laz-perf.wasm — Worker에서 사용 가능"과 `vite.config.js`
주석 참고. 브라우저 실측(Autzen 10.7M, New Zealand 44.2M 데이터셋, 분류 필터·스트리밍
동작 포함)으로 검증 완료, `npm run dev`/`vite preview` 양쪽 확인.

---

### 7. 노드당 별도 draw call

현재 화면에 보이는 옥트리 노드 하나하나가 각자 `DrawCommand`를 가집니다
(`loader.ts`의 `PointCloudPrimitive`). `maxVisibleNodes` 기본값 100 →
프레임당 최대 100 draw call.

**개선안:** 인접 노드를 하나의 버퍼로 병합하면 draw call 수를 줄일 수 있지만,
LRU 캐시/eviction 모델을 다시 설계해야 해서 리스크가 큼.

---

### 8. 문자열 키(`"D-X-Y-Z"`) 기반 Map/Set

`getChildKeys`(`src/lib/lod.ts`)가 내부 노드 확장마다 문자열 8개를 새로
생성합니다. 트리 순회가 잦은 만큼 작은 문자열 할당이 누적됩니다.

**개선안:** 숫자/bigint로 키를 패킹하면 할당·해싱 비용이 줄지만, `CopcDataSource`,
`loader.ts`, `main.ts` 등 여러 파일에 걸친 리팩터라 효과 대비 손이 많이 감.

---

---

## 2차 분석 (2026-07-23, LAZ 디코딩 워커 이전 + 공유 워커 풀 적용 이후)

worker.ts가 이제 노드당 fetch+LAZ 디코딩+속성 추출+좌표 변환을 전부 떠맡고 있어서,
그 내부 루프 구조와 그 앞단(BFS 노드 선택)의 낭비를 다시 점검했다.

### 9. worker.ts가 포인트 배열을 3번 순회 — 2번으로 줄일 수 있음

**위치:** `src/lib/worker.ts:95-168`

현재 노드 하나당 다음 순서로 포인트 배열을 훑는다:

1. `95-107`: getter로 X/Y/Z/RGB·Intensity/Classification 추출
2. `110-115`: RGB/Intensity 색상 스케일용 `maxColor` 재스캔 (1번에서 이미 채운 `rs/gs/bs`를 다시 훑음)
3. `141-168`: proj4 변환 + ECEF 계산 + 색상 정규화
4. `173-178`: Float32 high/low(RTE) 분리 (3번에서 이미 계산한 `positions`를 다시 훑음)
5. `181-198`: BoundingSphere 평균/최대거리 (2개 하위 패스, 구조상 축소 어려움)

**2번(maxColor)은 1번 루프 안에서 값을 채우는 동시에 `if (rs[i] > maxColor) maxColor = rs[i]`
식으로 같이 추적하면 별도 패스가 필요 없다.** 마찬가지로 **4번(RTE 분리)은 3번 루프에서
`positions[i*3+k]`를 쓰는 바로 그 자리에서 `posHigh`/`posLow`도 함께 계산**하면 된다 (5번의
BoundingSphere는 전체 평균이 필요해서 `positions` 자체는 계속 남겨둬야 하지만, RTE 분리
자체는 포인트별 독립 연산이라 굳이 별도 패스일 필요가 없다).

이렇게 하면 노드당 순회 횟수가 5패스(1,2,3,4,+ 5의 2개 하위패스)에서 약 4패스(1+2 합침,
3+4 합침, 5의 2개 하위패스)로 줄어든다. 포인트 수가 많은 노드(수만~십만 점)일수록 체감이
클 수 있다.

---

### 10. `_selectNodesBFS`가 리프 노드에서도 자식 키를 미리 계산함

**위치:** `src/lib/CopcDataSource.ts:456-467`

```ts
const sse = screenSpaceError(sphere, camera, scene);
const children = getChildKeys(key).filter(k => this._nodes[k]);  // ← 항상 계산됨

if (visibleKeys.length < maxNodes && sse > threshold && children.length > 0) {
  // 자식으로 확장
} else {
  visibleKeys.push(key);  // sse가 이미 threshold 이하라도 children은 이미 계산해버린 뒤
}
```

`children`(8개 키 문자열 생성 + `this._nodes` 조회 8회 + 배열 필터)이 `sse > threshold`
조건을 확인하기도 전에 무조건 계산된다. 실제로는 **BFS가 종료되는 리프 노드가 내부
노드보다 훨씬 많은데**, 리프로 판정되는 경우(`sse <= threshold`)엔 `children`이 애초에
필요 없다. `sse > threshold`일 때만 `children`을 계산하도록 순서를 바꾸면, 매 LoD
갱신마다(카메라 이동 중 200ms 간격) 다수의 불필요한 문자열 생성·해시맵 조회를 없앨 수 있다.

---

### 11. 공유 워커 풀 크기가 5로 고정됨 — 코어 수에 맞춰 조정 여지

**위치:** `src/main.ts` (`const sharedWorkerPool = new WorkerPool(CopcWorker, 5);`)

LAZ 디코딩이 이제 진짜로 별도 OS 스레드(Worker)에서 병렬 실행되므로, 코어가 많은
머신에서는 워커 수를 늘리면 디코딩 처리량이 실제로 늘어날 여지가 있다. 지금은 5로
고정돼 있는데, `navigator.hardwareConcurrency`를 참고해 적응형으로 정하면(예:
`Math.min(navigator.hardwareConcurrency - 1, 8)` 등 상한을 두고) 저사양 기기에서
과도한 워커 생성을 막으면서 고사양 기기에서는 처리량을 더 끌어올릴 수 있다. 다만 네트워크
동시 연결 수(브라우저별 origin당 제한) 쪽 병목도 같이 고려해야 무의미하게 워커만
늘리는 걸 피할 수 있다.

---

### 12. (참고, 영향 적음) 공유 워커 풀 전환의 부수 효과

**위치:** `src/lib/CopcDataSource.ts` `destroy()` — 공유 풀은 `_ownsPool`이 false면
`pool.destroy()`를 호출하지 않음

데이터셋을 전환하면 이전 `CopcDataSource`가 `destroy()`되지만, 공유 풀에 그 인스턴스가
아직 큐잉해둔(디스패치 전) 요청이 있었다면 풀 안에 그대로 남아있다가 워커가 비는 대로
실행된 뒤 `_destroyed`/`_loadGen` 체크로 결과가 버려진다 — 정확성 문제는 없지만, 새
데이터셋의 정당한 요청보다 앞서 워커 슬롯을 잠깐 점유할 수 있다. 현재는 `CopcDataSource`의
동시 로드 제한(`concurrency`)이 풀 크기와 같아서(둘 다 5) 큐에 남는 항목이 거의 없어
실질 영향이 미미하지만, 11번처럼 풀 크기를 키우거나 여러 `CopcDataSource`를 동시에 쓰는
시나리오가 생기면 재검토할 만하다.

---

## 추천 순서

1. **1 → 2 → 3** (반나절 이내, 리스크 낮음, 자체완결적) 먼저 적용
2. 효과를 확인하면서 **4 (requestRenderMode)** 를 신중하게 적용 — 회귀 테스트 필수
3. **5**는 여유 있을 때 곁들이기
4. **6 / 7 / 8**은 신규 기능 스프린트 이후, 별도 아키텍처 작업으로 분리
5. (2차) **9 → 10**은 자체완결적이고 리스크 낮아 바로 적용 가능
6. (2차) **11**은 실측 후 상한값 정해서 적용, **12**는 11을 하지 않는 한 보류

## 상태

- [x] 1. BFS 우선순위 큐 → 이진 힙 (2026-07-23, `CopcDataSource.ts`의 `MaxHeap` 클래스)
- [x] 2. `_sphere()` heightOffset 보정 캐싱 (2026-07-23, `_shiftedSphereCache`)
- [x] 3. `WorkerPool` 큐 O(n) shift 제거 (2026-07-23, `_queueHead` 커서 방식)
- [x] 4. `requestRenderMode` 전환 (2026-07-23, `main.ts` Viewer 옵션 + `CopcDataSource`
      노드 add/remove/show, pixelSize/heightOffset/sseThreshold/classMask 변경 시
      `scene.requestRender()` 명시 호출)
- [x] 5. progress emit 코일레싱 (2026-07-23, `_emit`/`_flushEmit` leading+trailing
      throttle, 100ms 간격, 최종 상태는 항상 보존)
- [x] 6. 포인트 속성 추출(+ fetch/LAZ 디코딩) 워커 이전 (2026-07-23, `worker.ts` 전체
      재구성 + `vite.config.js` laz-perf worker alias, 상세 내용은 위 6번 항목 참고)
- [ ] 7. draw call 병합 (구조 변경)
- [ ] 8. 노드 키 정수 패킹 (구조 변경)
- [ ] 9. worker.ts 3패스 → 2패스로 축소 (maxColor/RTE 분리 루프 병합)
- [ ] 10. `_selectNodesBFS` 리프 노드에서 불필요한 `getChildKeys` 계산 제거
- [ ] 11. 공유 워커 풀 크기 적응형 조정 (`navigator.hardwareConcurrency`)
- [ ] 12. (참고, 영향 적음) 공유 풀 전환 시 잔여 큐 항목의 워커 슬롯 점유
