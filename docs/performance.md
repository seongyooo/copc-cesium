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

### 6. 포인트 속성 추출 루프가 메인 스레드에서 실행됨

**위치:** `src/lib/loader.ts:300-312`

```ts
for (let i = 0; i < n; i++) {
  xs[i] = getX(i); ys[i] = getY(i); zs[i] = getZ(i);
  if (hasRGB && getR && getG && getB) {
    rs[i] = getR(i); gs[i] = getG(i); bs[i] = getB(i);
  } else if (getI) {
    rs[i] = gs[i] = bs[i] = getI(i);
  } else {
    rs[i] = gs[i] = bs[i] = 65535;
  }
  const c = getCls ? (getCls(i) & 0xFF) : 0;
  ...
}
```

X/Y/Z/RGB/Classification까지 포인트당 최대 7번의 getter 호출이 워커로
넘기기 *전에* 메인 스레드에서 동기 실행됩니다. 현재 워커(`worker.ts`)는
proj4 좌표 변환 부분만 맡고 있어서, 노드가 크거나 동시 로드가 많을 때
(기본 `concurrency: 5`) 이 루프가 실제 프레임 드랍(버벅임)의 원인일
가능성이 가장 높습니다.

**개선안:** LAZ 디코딩(`Copc.loadPointDataView` 호출 자체)을 워커로 옮기면
메인 스레드 부담을 크게 줄일 수 있지만, 아키텍처 변경이 커서 별도 스프린트
필요.

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

## 추천 순서

1. **1 → 2 → 3** (반나절 이내, 리스크 낮음, 자체완결적) 먼저 적용
2. 효과를 확인하면서 **4 (requestRenderMode)** 를 신중하게 적용 — 회귀 테스트 필수
3. **5**는 여유 있을 때 곁들이기
4. **6 / 7 / 8**은 신규 기능 스프린트 이후, 별도 아키텍처 작업으로 분리

## 상태

- [x] 1. BFS 우선순위 큐 → 이진 힙 (2026-07-23, `CopcDataSource.ts`의 `MaxHeap` 클래스)
- [x] 2. `_sphere()` heightOffset 보정 캐싱 (2026-07-23, `_shiftedSphereCache`)
- [x] 3. `WorkerPool` 큐 O(n) shift 제거 (2026-07-23, `_queueHead` 커서 방식)
- [ ] 4. `requestRenderMode` 전환
- [ ] 5. progress emit 코일레싱
- [ ] 6. 포인트 속성 추출 워커 이전 (구조 변경)
- [ ] 7. draw call 병합 (구조 변경)
- [ ] 8. 노드 키 정수 패킹 (구조 변경)
