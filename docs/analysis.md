# copc-cesium 코드 분석

## 1. 모듈 의존성 그래프

```
main.js
└── CopcDataSource.js
    ├── cesium          (외부)
    ├── copc            (외부)
    ├── proj4           (외부)
    ├── lod.js
    │   ├── cesium      (외부)
    │   └── proj4       (외부)
    ├── loader.js
    │   ├── cesium      (외부)
    │   └── copc        (외부)
    └── WorkerPool.js   (의존 없음)

worker.js               (독립 실행 — WorkerPool이 URL로 참조)
└── proj4               (외부)
```

### 의존 방향 요약

| 모듈 | 의존하는 모듈 | 역할 |
|---|---|---|
| `main.js` | `CopcDataSource` | UI 진입점 |
| `CopcDataSource.js` | cesium, copc, proj4, lod, loader, WorkerPool | 핵심 오케스트레이터 |
| `loader.js` | cesium, copc | 노드 fetch + GPU 프리미티브 |
| `lod.js` | cesium, proj4 | BFS/SSE, BoundingSphere, 프러스텀 |
| `worker.js` | proj4 | 좌표 변환 (별도 스레드) |
| `WorkerPool.js` | (없음) | 워커 풀 추상화 |

---

## 2. 결합도가 높은 모듈과 분리 제안

### 2-1. `CopcDataSource` — God Class (★★★ 심각)

`CopcDataSource.js` 한 파일에 다섯 가지 책임이 혼재합니다.

| 책임 | 현재 위치 | 분리 제안 |
|---|---|---|
| WKT CRS 파싱 | `CopcDataSource.js` 상단 4개 함수 | `src/lib/crs.js` |
| COPC 파일 초기화 | `_init()` | 유지 (factory 메서드) |
| BFS LoD 선택 | `_selectNodesBFS()` | `lod.js`로 이동 또는 `src/lib/lod-selector.js` |
| LRU 캐시 + Scene 관리 | `_evict()`, `_container` 조작 | `src/lib/NodeCache.js` |
| 카메라 이벤트/디바운스 | `_startListening()` | `src/lib/CameraWatcher.js` |

**구체적 분리안:**

```
src/lib/
  crs.js           ← detectCrsFromWkt, _extractInnerCrs, _extractLinearUnit, _extractEpsgCode
  NodeCache.js     ← Map 기반 LRU + _inScene Set + _evict
  CameraWatcher.js ← camera.changed/moveEnd 리스너 + 디바운스
  CopcDataSource.js (경량화) ← 위 모듈들을 조합하는 조율자만 남음
```

---

### 2-2. `loader.js` — 렌더링 + 데이터 로딩 혼재 (★★ 중간)

`PointCloudPrimitive` (GPU 리소스 관리) 와 `loadNode` (네트워크 + 좌표 변환) 가
한 파일에 있습니다. `PointCloudPrimitive` 는 재사용 가능한 독립 컴포넌트입니다.

```
현재: loader.js = [PointCloudPrimitive 클래스] + [loadNode 함수]

제안:
  src/lib/PointCloudPrimitive.js  ← GPU DrawCommand 래퍼만
  src/lib/loader.js               ← loadNode (fetch + worker 호출 + primitive 조립)
```

---

### 2-3. `lod.js` — 좌표 변환과 Cesium 기하학 혼재 (★ 경미)

`getNodeBoundingSphere`는 `proj4` 변환 로직과 `Cesium.BoundingSphere` 생성을
하나의 함수에서 처리합니다. proj4 부분을 `crs.js`로 분리하면 lod.js는 순수하게
Cesium 기하학만 다루는 모듈이 됩니다.

```js
// 분리 후 lod.js
export function getNodeBoundingSphere(key, rootCenter, rootHalfSize, lonLatFn, geoidOffset, zFactor, xyFactor) {
  const [cx, cy, cz] = computeNodeCenter(key, rootCenter, rootHalfSize);
  const [lon, lat] = lonLatFn(cx, cy);   // ← 주입된 변환 함수
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, cz * zFactor + geoidOffset);
  return new Cesium.BoundingSphere(center, nodeHalfSize * xyFactor * Math.sqrt(3));
}
```

이렇게 하면 `lod.js`에서 `proj4` 의존을 제거할 수 있습니다.

---

### 2-4. `CopcDataSource` → `Cesium.Viewer` 직접 참조 (★ 경미)

생성자가 `Cesium.Viewer`를 받아 `viewer.scene`, `viewer.camera`, `viewer.imageryLayers`에
직접 접근합니다. 필요한 인터페이스만 추상화하면 테스트 용이성이 크게 높아집니다.

```js
// 제안: 최소 인터페이스 타입 정의 (JSDoc)
/**
 * @typedef {{ scene: Cesium.Scene, camera: Cesium.Camera }} ViewerLike
 */
```

---

## 3. 기술 부채

### 3-1. Deprecated / 내부 API 사용

| 항목 | 위치 | 내용 |
|---|---|---|
| `Cesium.Buffer` | `loader.js:54` | `Cesium.Buffer.createVertexBuffer`는 공개 API이지만 `DrawCommand`, `VertexArray`, `ShaderProgram`, `RenderState`, `Pass` 모두 Cesium의 **비공개 내부 렌더링 API**입니다. Cesium 메이저 버전 업그레이드 시 경고 없이 제거·변경될 수 있습니다. |
| `Cesium.destroyObject` | `loader.js:165` | 마찬가지로 내부 유틸리티 함수입니다. |
| `camera.percentageChanged` | `CopcDataSource.js:586` | 공개 API이나 값을 직접 덮어씌우는 방식(`= 0.01`)은 Viewer를 공유할 경우 다른 코드와 충돌합니다. |

---

### 3-2. 오래된 의존성 구조

| 항목 | 현재 | 문제 |
|---|---|---|
| `copc` 패키지 | `^0.0.8` | 버전이 `0.0.x`로 아직 실험적 단계. 안정 API 보장 없음. |
| `cesium` | `devDependencies`에 `^1.143.0` | 라이브러리로 배포할 경우 `peerDependencies`로 옮겨야 합니다. |
| `tslib` | `dependencies`에 있으나 미사용 | TypeScript를 쓰지 않는데 포함되어 있습니다. 제거 대상. |
| `vite-plugin-cesium` | `^1.2.23` | Vite 8.x 기준 호환 여부 확인 필요 (플러그인이 Vite 5 기준으로 작성된 경우가 많음). |

---

### 3-3. 중복 코드 / 복사-붙여넣기 패턴

**① `toLoad.sort` 중복 — `CopcDataSource.js`**

`_selectNodesBFS`(411행)와 `_updateLoD`의 `toLoad.sort`(473행) 두 곳에서
"카메라 방향 기준 dot product 정렬" 로직이 거의 동일하게 반복됩니다.

```js
// 두 곳에 동일한 패턴
Cesium.Cartesian3.subtract(getSphere(x).center, camPos, scratch);
Cesium.Cartesian3.normalize(scratch, scratch);
const dot = Cesium.Cartesian3.dot(scratch, camDir);
```

헬퍼로 추출하면 됩니다:
```js
function dotToCamera(sphere, camPos, camDir, scratch) {
  Cesium.Cartesian3.subtract(sphere.center, camPos, scratch);
  Cesium.Cartesian3.normalize(scratch, scratch);
  return Cesium.Cartesian3.dot(scratch, camDir);
}
```

**② `getSphere` 클로저 중복 — `CopcDataSource.js`**

`_selectNodesBFS`(353행)와 `_updateLoD`(446행) 각각에서 동일한 `getSphere(key)` 캐싱 클로저를 독립적으로 정의합니다.

**③ `proj4.defs` 등록 — 3곳 중복**

`CopcDataSource` 생성자(184행), `_init`(259행), `worker.js`(46행) 세 곳에서 `proj4.defs` 등록 코드가 분산되어 있습니다.

---

### 3-4. 런타임 외부 네트워크 의존

```js
// CopcDataSource.js:116
const res = await fetch(`https://epsg.io/${epsgCode}.proj4`);
```

WKT CRS 자동 감지 실패 시 `epsg.io`에 실시간 HTTP 요청합니다.
- 오프라인·에어갭 환경에서 작동하지 않습니다.
- 해당 서비스 장애 시 CRS 감지가 무음 실패(fallback to EPSG:4326)합니다.
- CORS 정책 이슈가 발생할 수 있습니다.

**완화 방안:** 자주 쓰는 EPSG 코드(2992, 6419, 32610 등)의 proj4 정의를 번들에 내장하고, epsg.io 요청은 마지막 수단으로 남깁니다.

---

### 3-5. 하드코딩된 기본값

- `zFactor = 0.3048`(feet 기본값)이 `loader.js`, `lod.js`, `CopcDataSource.js`, `worker.js` 네 곳에 흩어져 있습니다.
- GLSL 셰이더 문자열이 `loader.js` 내 `_initGpu`에 인라인으로 하드코딩되어 있습니다(`gl_PointSize = ${pxSz.toFixed(1)}`). `pixelSize` 변경 시 셰이더를 재컴파일하는 방법이 없습니다.

---

## 4. npm 패키지 배포 시 고민할 사항

### 4-1. 패키지 메타데이터 정비

```jsonc
// 현재
"name": "copc"   // ← npm에 이미 'copc' 패키지가 존재. 충돌

// 제안
"name": "copc-cesium"   // 또는 스코프 패키지 "@yourorg/copc-cesium"
```

`package.json`에 `exports`, `module`, `types` 필드가 없습니다:

```jsonc
{
  "exports": {
    ".": {
      "import": "./dist/copc-cesium.js",
      "require": "./dist/copc-cesium.cjs"
    }
  },
  "types": "./dist/copc-cesium.d.ts"
}
```

---

### 4-2. peerDependencies 재분류

| 패키지 | 현재 | 변경 제안 | 이유 |
|---|---|---|---|
| `cesium` | `devDependencies` | `peerDependencies` | 사용자가 이미 cesium을 가지고 있을 것이므로 번들에 포함하면 중복 |
| `proj4` | `dependencies` | `dependencies` 유지 | 라이브러리 자체 기능이므로 포함 |
| `copc` | `dependencies` | `dependencies` 유지 | 동일 |
| `tslib` | `dependencies` | 제거 | TypeScript 미사용 |

---

### 4-3. 번들 빌드 분리 (library mode)

현재 `vite.config.js`는 **애플리케이션** 빌드 설정입니다. 라이브러리로 배포하려면 별도 설정이 필요합니다:

```js
// vite.config.lib.js
export default defineConfig({
  build: {
    lib: {
      entry: 'src/lib/CopcDataSource.js',
      name: 'CopcCesium',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['cesium', 'copc', 'proj4'],  // peerDeps는 번들에서 제외
    },
  },
});
```

---

### 4-4. Web Worker 패키징 문제 (★★★ 가장 어렵)

```js
// CopcDataSource.js:189 — Vite/번들러 특정 문법
this._pool = new WorkerPool(
  new URL('./worker.js', import.meta.url),
  ...
);
```

`new URL('./worker.js', import.meta.url)` 패턴은 Vite/Webpack5 이상에서는 작동하지만,
**Node.js 직접 임포트**, **Jest/Vitest**, **구형 번들러** 환경에서는 워커 파일을 찾지 못합니다.

**선택지:**

| 방법 | 장점 | 단점 |
|---|---|---|
| 인라인 워커 (Blob URL) | 단일 파일 배포 가능 | 코드 가독성 저하 |
| 워커 파일 별도 배포 + 경로 주입 옵션 | 유연성 높음 | 사용자가 경로 설정 필요 |
| Comlink 등 라이브러리 활용 | 타입 안전, 표준화 | 의존성 추가 |

---

### 4-5. laz-perf.wasm 배포

`vite.config.js`의 `lazPerfWasmPlugin`은 wasm 파일을 번들 출력에 포함시키는 핵심 로직입니다.
npm 패키지로 배포 시 사용자의 빌드 환경(Webpack, Rollup, Next.js 등)에서도
wasm이 올바르게 복사·서빙되어야 합니다.

```
사용자 프로젝트 빌드 시:
  laz-perf.wasm → public/ 또는 static/ 에 복사되어야 함
  Content-Type: application/wasm 으로 서빙되어야 함
```

**선택지:**
- wasm 파일을 Base64로 인라인 (번들 크기 ~30% 증가)
- 사용자에게 wasm 경로를 `CopcDataSource.load(url, viewer, { wasmPath: '...' })` 옵션으로 주입받기
- 번들러별 플러그인/설정 가이드 문서 제공

---

### 4-6. 타입 정의 없음

현재 TypeScript 또는 JSDoc 타입이 일부 있지만 공식 `.d.ts` 파일이 없습니다.
npm 배포 시 TypeScript 사용자를 위해 최소한 다음 타입은 필요합니다:

```ts
export declare class CopcDataSource {
  static load(url: string, viewer: Cesium.Viewer, options?: CopcOptions): Promise<CopcDataSource>;
  onProgress: ((info: ProgressInfo) => void) | null;
  destroy(): void;
  readonly maxDepth: number;
  readonly nodeCount: number;
  readonly cacheSize: number;
}
```

---

### 4-7. 외부 서비스 의존 (epsg.io)

npm 패키지 사용자는 epsg.io가 CORS를 허용하지 않는 환경(Node.js SSR, 특정 CDN)에서
CRS 자동 감지가 무음 실패합니다. 배포 전에 이 로직을 옵션으로 분리하거나
오프라인 fallback을 제공해야 합니다.

```js
// 제안: 사용자가 커스텀 CRS 리졸버를 주입 가능하게
CopcDataSource.load(url, viewer, {
  resolveCrs: async (epsgCode) => { /* 자체 구현 */ }
});
```
