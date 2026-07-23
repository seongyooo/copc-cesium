# 구현 현황 및 로드맵

작성일: 2026-07-23
목적: QA·성능 개선·렌더링 수정 작업 전체를 한 곳에 정리. 세부 성능 수치/분석은
`docs/performance.md`, 요구명세서 대조는 `docs/explain.md`, 아키텍처/API는
`README.md` 참고 — 이 문서는 그 세 문서를 아우르는 상위 요약 + 로드맵.

관련 커밋: `9fbffc4` ~ `10aebf3` (아래 각 항목에 표시), 그리고 이 문서 작성 시점
기준 아직 커밋되지 않은 작업(§1-4, §1-5 일부)이 있음 — `git status`로 확인.

---

## 1. 지금까지 구현한 것

### 1-1. QA에서 발견·수정한 버그

**커밋:** `9fbffc4`, `e13cb88`, `3e08494`

| 심각도 | 내용 | 위치 |
|---|---|---|
| 🔴 Critical | 프로덕션 빌드에서 워커가 `.ts` 확장자로 서빙되어(`video/mp2t` MIME) 전혀 로드되지 않던 문제 | `vite.config.js`, `worker.ts` 임포트 방식 |
| 🟠 High | GPU 리소스 생성 실패가 Cesium 렌더 루프 전체를 멈출 수 있던 문제 → 노드 단위로 격리 | `loader.ts` `PointCloudPrimitive.update()` |
| 🟡 Medium | `sseThreshold`/`_updateLoD` 재귀 호출의 unhandled promise rejection | `CopcDataSource.ts` |
| 🟡 Medium | 분류 필터 비트마스크가 class ≥32에서 32-mod 오버플로우로 다른 클래스를 오염시키던 문제 (Autzen 실데이터로 재현됨: 클래스 64/65/66/68/73 존재) | `main.ts` `updateClassMask()` |
| 🟡 Medium | `heightOffset`이 컬링/SSE용 BoundingSphere에 반영되지 않던 문제 | `CopcDataSource.ts` `_sphere()`, `lod.ts` |
| 🟡 Medium | Terrain/Imagery 드롭다운 빠른 연속 전환 시 레이스 컨디션 (세대 카운터로 해결) | `main.ts` |
| 🟢 Low(참고) | COMPD_CS(수평+수직 CRS 복합) WKT에서 EPSG 코드가 수직 CRS 값으로 오추출될 수 있던 문제 | `CopcDataSource.ts` `detectCrsFromWkt` |

**의도적으로 남겨둔 것** (별도 스코프 필요, §3 참고):
- 프리셋 빠른 연속 클릭 시 두 `CopcDataSource._init()`이 동시 실행되며 카메라 flyTo가 경합할 수 있음
- Color mode(Elevation/Intensity/RGB)·Opacity 컨트롤이 UI만 있고 실제 렌더링에 미연동

### 1-2. 성능 개선 — 1차 (자체완결적 핫패스)

**커밋:** `c20ca18`, `10aebf3`, 그리고 워크트리에 미커밋 상태로 남은 항목

| # | 내용 | 위치 |
|---|---|---|
| 1 | BFS 우선순위 큐를 배열 push+sort(O(n log n)) 방식에서 이진 힙(`MaxHeap`, O(log n))으로 교체 | `CopcDataSource.ts` `_selectNodesBFS` |
| 2 | `_sphere()`의 heightOffset 보정 결과를 key별로 캐싱(`_shiftedSphereCache`) — 매번 새 Cartesian3/BoundingSphere 할당하지 않음 | `CopcDataSource.ts` |
| 3 | `WorkerPool` 큐 dequeue를 O(n) `shift()`에서 `_queueHead` 커서 기반 O(1)로 전환 | `WorkerPool.ts` |
| 4 | `viewer.scene.requestRenderMode = true` 전환 — 정적 화면에서 불필요한 매 프레임 렌더링 제거. `CopcDataSource`가 씬을 직접 바꾸는 모든 지점(노드 add/remove/show, pixelSize/heightOffset/sseThreshold/classMask 변경)에 명시적 `requestRender()` 호출 추가 | `main.ts`, `CopcDataSource.ts` |
| 5 | 노드 로드 진행상황 emit을 leading+trailing 스로틀(100ms)로 코일레싱 — DOM 갱신 빈도 제한, 최종 상태는 항상 보존 | `CopcDataSource.ts` `_emit`/`_flushEmit` |
| 9 | `worker.ts` 포인트 배열 순회를 5패스 → 4패스로 축소 (maxColor 스캔을 속성 추출 루프에 병합, RTE high/low 분리를 좌표 변환 루프에 병합) | `worker.ts` |
| 10 | `_selectNodesBFS`에서 리프 노드로 판정될 때(SSE ≤ threshold) `getChildKeys` 계산을 생략하도록 순서 변경 | `CopcDataSource.ts` |

### 1-3. 아키텍처 변경 — LAZ 디코딩을 메인 스레드에서 Worker로 이전

**커밋:** `10aebf3`, 그리고 지속 워커 풀 관련 후속 수정은 미커밋

기존에는 `Copc.loadPointDataView()`(HTTP Range fetch + LAZ 압축 해제)가 메인
스레드에서 실행되고, Worker는 proj4 좌표 변환만 담당했다. 이제 fetch부터
좌표 변환·RTE 분리·BoundingSphere 계산까지 전부 Worker 안에서 수행하고,
메인 스레드는 결과 버퍼로 GPU 프리미티브만 조립한다.

**핵심 발견**: `laz-perf`(copc.js가 쓰는 wasm 모듈)는 web/node/worker용 빌드를
각각 배포하며 실제 .wasm 바이너리는 동일 — "Worker에서 사용 불가"라는 기존 기록은
틀렸음을 확인. `vite.config.js`에 worker-scoped `resolveId` 플러그인을 추가해
워커 번들링 시에만 `laz-perf` → `laz-perf/lib/worker/index.js`로 바꿔치기.

**우회하며 실제로 만난 두 버그**:
1. Blob URL 워커(`?worker&inline`)에서는 laz-perf 글루 코드가 `self.location.href`의
   `blob:` 프리픽스 때문에 상대경로 wasm 요청을 못 만듦(`Failed to parse URL`) →
   `?worker`(실제 URL을 갖는 별도 청크)로 전환.
2. wasm 자산이 워커 청크와 다른 디렉터리에 있으면 404 → SPA 폴백으로 `index.html`을
   받아 `expected magic word` 에러 → wasm을 워커 청크와 같은 `dist/assets/`에 배치.

**후속 회귀 수정** (데이터셋 전환 시 체감 저하 리포트 후 발견): `CopcDataSource`가
매번 자체 `WorkerPool`을 새로 만들어서, 데이터셋을 전환할 때마다 워커 5개가
재생성되고 laz-perf wasm도 워커마다 다시 컴파일해야 했음. `main.ts`가 앱 생명주기
동안 유지되는 `sharedWorkerPool`을 만들어 모든 `CopcDataSource.load()` 호출에
전달하도록 변경 — `CopcDataSource`는 외부 풀이 주어지면 재사용하고 자기 것이
아니면 `destroy()`에서 풀을 건드리지 않음(`_ownsPool` 플래그).

자세한 배경은 `README.md` §2(아키텍처), §8(기술 결정 기록) 참고.

### 1-4. 요구명세서(`docs/explain.md`) 대조 결과

실제 코드가 대회 요구명세서를 얼마나 충족하는지 항목별로 점검한 기록. 상세 표는
`explain.md` 대조 시점 대화 내용 참고 — 핵심만 요약:

- ✅ 충족: COPC URL 직접 로드, Cesium 통합, 스트리밍 렌더링, LoD·프러스텀 컬링,
  노드 캐시/우선순위 큐/취소 정책, **LAZ 디코딩 Worker 이전**(요구명세서가 명시한
  항목, §1-3에서 완료), HTTP Range 요청, 동시 요청 제한, WKT→ECEF 좌표 변환,
  한국 좌표계(EPSG:5174-5188) 지원, RGB/Intensity/Classification 색상, 분류 필터
- ⚠️ 부분 충족: "노드 상대좌표 + ModelMatrix" 대신 포인트별 proj4 변환 + 수동 RTE
  분리 방식 채택(정밀도는 더 좋지만 명세와 다른 기법)
- ❌ 미충족 (§3 로드맵 참고): Elevation 색상 모드, AbortController 기반 실제 요청
  취소, 인접 요청 병합, npm 패키지화

---

## 2. 렌더링 관련 수정사항 (상세)

이 프로젝트의 "렌더링"은 COPC 옥트리 순회(LoD 선택) → 노드 로드 → GPU 업로드 →
프레임 합성까지 전체 파이프라인을 뜻한다. 그 중 **화면에 실제로 그려지는 결과물이나
그리는 방식 자체를 바꾼 변경**만 추려서 정리한다 (빌드 설정 같은 순수 인프라 변경은
제외 — §1-3 참고).

### 2-1. LoD 선택 (무엇을 그릴지 고르는 로직)
- BFS + Screen Space Error 알고리즘 자체는 이번 세션 이전부터 있었음(우선순위 큐
  방식만 배열 정렬 → 이진 힙으로 교체, §1-2 #1).
- `heightOffset` 적용 시 컬링용 BoundingSphere가 실제 렌더링 위치(셰이더에서
  `u_upVec * u_heightOffset`만큼 이동)와 어긋나 있던 버그 수정 — 이제 `_sphere()`가
  현재 heightOffset을 반영한 좌표로 컬링/SSE를 계산한다 (§1-1).
- 리프 노드에서 자식 키 계산을 생략하도록 순서 변경 (§1-2 #10) — 선택되는 노드
  집합 자체는 동일, 계산 과정만 가벼워짐.

### 2-2. 프레임 렌더링 트리거
- `requestRenderMode` 전환으로, 정적 화면에서는 프레임을 그리지 않다가 다음
  이벤트에서만 그림: 카메라 이동(Cesium 자동), 지형/이미지리 교체, 노드
  add/remove/show 변경, pixelSize/heightOffset/sseThreshold/classMask 변경.
  이 지점들을 놓치면 "조작했는데 화면이 안 바뀜" 회귀가 생기므로, 씬을 건드리는
  새 코드를 추가할 때는 항상 `viewer.scene.requestRender()` 호출 여부를 확인해야
  한다 (§1-2 #4).

### 2-3. GPU 프리미티브 (실제로 점을 그리는 부분)
- `PointCloudPrimitive`(DrawCommand 직접 사용, `loader.ts`)는 구조 자체는 이전과
  동일 — `gl_PointSize = u_pixelSize`(카메라 거리와 무관한 고정 화면 픽셀 크기),
  `depthTest: enabled`, `depthMask: true`.
- 변경된 것은 **이 프리미티브가 받는 입력 데이터가 어디서 만들어지는가** —
  이전에는 메인 스레드에서 LAZ 디코딩 후 만든 배열을 Worker에 보내 좌표변환만
  받아왔는데, 지금은 Worker가 fetch부터 RTE 분리·BoundingSphere까지 전부 계산해서
  최종 GPU 업로드용 버퍼(`posHigh`/`posLow`/`colors`/`cls`)를 그대로 반환한다.
  메인 스레드(`loader.ts::loadNode`)는 이제 이 버퍼로 `PointCloudPrimitive`를
  생성만 한다 (§1-3).
- GPU 리소스 생성 실패 시 그 노드만 렌더링에서 제외하고 씬 전체는 계속 그려지도록
  격리 (§1-1).

### 2-4. 색상·분류
- 분류 필터 비트마스크가 class≥32에서 다른 클래스를 오염시키던 버그 수정 —
  셰이더의 `u_classMask`는 여전히 32비트라 class≥32는 항상 렌더링되지만(원래
  한계), 최소한 이 필터가 class<32의 필터링을 망가뜨리지는 않는다 (§1-1).
- RGB/Intensity 자동 판별(A-7), 8-bit/16-bit 색상 스케일 판별 로직은 그대로
  유지된 채 워커 안으로 이동 (§1-3).

### 2-5. 아직 "렌더링에 실질적 영향 없음"으로 확인된 것 (참고)
- San Diego 2005 데이터셋에서 가까이 볼 때 성기게 보이는 현상 — 옥트리 실제
  최대 깊이(6)와 고정 화면 픽셀 크기(`gl_PointSize`) 조합에 의한 정상적인 결과로
  확인, 렌더링 버그 아님 (별도 조사 기록, 이 문서 작성 시점 대화 참고).

---

## 3. 앞으로 구현이 더 필요한 것 (로드맵)

### 우선순위 높음 — 명세 미충족 + 사용자 체감 영향 큼

- [ ] **Elevation 색상 모드 구현**. `index.html`에 버튼은 있지만 `main.ts`의
      `colorModeGrid` 클릭 핸들러가 `// TODO`로 미구현. Classification처럼 GPU
      속성만 갱신되도록(재다운로드 없이) 하려면, Z 값 또는 별도 컬러램프 인덱스를
      버텍스 속성으로 이미 갖고 있거나 셰이더에서 계산 가능해야 함 — 현재는 RGB가
      로드 시점에 워커에서 한 번만 계산되어 버텍스 버퍼에 구워지므로, 모드
      전환을 지원하려면 셰이더/버퍼 설계를 같이 손봐야 함.
- [ ] **Opacity 슬라이더 구현**. 마찬가지로 `// TODO` 상태. 프래그먼트 셰이더에서
      `u_opacity` uniform 추가 + `fragColor.a`에 반영하면 비교적 간단.
- [ ] **draw call 병합** (`docs/performance.md` #7). 노드당 별도 DrawCommand라
      `maxVisibleNodes` 기본 100 → 프레임당 최대 100 draw call. 인접 노드를 하나의
      버퍼로 합치면 줄일 수 있으나 LRU 캐시/eviction 모델을 다시 설계해야 해서
      리스크가 큼 — 이번 세션에서 계속 "구조 변경, 참고용"으로 미룬 항목.

### 우선순위 중간 — 명세 요구사항이지만 체감 영향은 상대적으로 작음

- [ ] **AbortController 기반 실제 요청 취소**. 지금은 카메라가 이동해 더 이상
      필요 없어진 노드도 fetch+디코딩이 끝까지 진행된 뒤(`_loadGen` 비교로)
      결과만 버려짐 — 네트워크/CPU 낭비. Worker 안에서 `fetch`에 `AbortSignal`을
      연결하고, `WorkerPool`이 특정 요청을 취소할 수 있는 API를 추가해야 함.
- [ ] **인접 HTTP Range 요청 병합**. 노드별로 개별 Range 요청을 보내는데, 같은
      파일 내 인접한 두 노드의 바이트 범위가 가깝다면 하나의 요청으로 합쳐 왕복
      횟수를 줄일 수 있음 — `copc` 라이브러리 레벨 지원이 없어 직접 구현 필요.
- [ ] **적응형 워커 풀 크기** (`docs/performance.md` #11). `main.ts`의
      `sharedWorkerPool`이 5로 고정. LAZ 디코딩이 이제 진짜 병렬(OS 스레드)이므로
      `navigator.hardwareConcurrency` 기반으로 상한 두고 조정하면 고사양 기기에서
      처리량을 더 끌어올릴 수 있음. 네트워크 동시 연결 제한과 같이 고려해야 함.

### 우선순위 낮음 / 참고용 (구조 변경 크거나 영향 적음)

- [ ] **노드 키 정수 패킹** (`docs/performance.md` #8). `"D-X-Y-Z"` 문자열 키를
      숫자/bigint로 바꾸면 할당·해싱 비용이 줄지만 여러 파일에 걸친 리팩터.
- [ ] **npm 패키지 배포 준비**. `CopcDataSource`의 공개 API 자체는 정리돼 있지만
      `package.json`에 `exports`/라이브러리 빌드 모드 설정이 없어 실제 npm 배포
      가능한 상태는 아님 (`docs/analysis.md` §4에 상세).
- [ ] **프리셋 연속 클릭 시 카메라 경합**. `loadCopc()`의 취소 플래그가
      `CopcDataSource.load()` 완료 후에만 체크돼서, 빠르게 두 번 클릭하면
      `_init()` 두 개가 동시에 돌며 `flyToBoundingSphere`가 경합할 수 있음 —
      취소 신호를 `_init()` 내부까지 전파해야 해서 API 변경 범위가 커서 보류.
- [ ] **공유 워커 풀 전환의 잔여 큐 항목 문제** (`docs/performance.md` #12).
      데이터셋 전환 시 이전 세션이 큐잉해둔 요청이 새 요청보다 먼저 워커를 잠깐
      점유할 수 있음 — 현재 concurrency 설정(=풀 크기)에서는 자기제한적이라
      실질 영향 적어서 보류, 위 "적응형 워커 풀 크기"를 적용하면 재검토 필요.
- [ ] **라이선스 표기 불일치 정리**. `package.json`은 `"license": "ISC"`, README
      하단은 "MIT" — 실제 의도한 라이선스를 정해서 통일 필요 (임의로 정하지 않고
      보류 중).

---

## 참고 문서

- `README.md` — 아키텍처, API 레퍼런스, 기술 결정 기록
- `docs/performance.md` — 성능 분석 상세 (1차/2차), 실행 빈도·비용 기준 우선순위
- `docs/explain.md` — 대회 요구명세서 원문
- `docs/analysis.md` — 모듈 결합도, npm 패키지 배포 시 고려사항 (다소 오래된 기록,
  `.js`→`.ts` 마이그레이션 이전 내용 일부 포함 — 구조 설명은 유효하나 파일 확장자는
  현재 `.ts`로 읽어야 함)
