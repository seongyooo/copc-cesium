import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAZ_WASM = resolve('node_modules/laz-perf/lib/laz-perf.wasm');
const LAZ_PERF_WORKER_ENTRY = resolve('node_modules/laz-perf/lib/worker/index.js');

/**
 * laz-perf는 web/node/worker용으로 각각 다른 진입점을 배포하는데
 * (lib/web, lib/node, lib/worker — 실제 .wasm 바이너리는 동일하고 JS 글루
 * 코드의 ENVIRONMENT_IS_WORKER 플래그만 다름), copc 패키지는 무조건
 * `require('laz-perf')`로 web 빌드를 가져온다. worker.ts 번들링 시에만
 * 이 특정 import를 worker 전용 빌드로 바꿔치기한다.
 */
const lazPerfWorkerAliasPlugin = {
  name: 'laz-perf-worker-alias',
  enforce: 'pre',
  resolveId(source) {
    if (source === 'laz-perf') return LAZ_PERF_WORKER_ENTRY;
    return null;
  },
};

/**
 * laz-perf-wasm 플러그인
 *
 * Vite가 copc/laz-perf를 번들링하면 laz-perf.js가 번들 경로 기준으로
 * laz-perf.wasm을 fetch하지만 wasm 파일은 복사되지 않아 404가 발생합니다.
 *
 * - dev:   어느 경로의 laz-perf.wasm 요청이든 실제 파일로 응답하는 미들웨어
 * - build: worker 청크(dist/assets/worker-*.js)와 같은 assets/ 아래에 배치.
 *          laz-perf 워커 빌드의 글루 코드는 자기 스크립트 URL 기준 상대경로로
 *          "laz-perf.wasm"을 요청하므로(scriptDirectory + 파일명), 청크와
 *          같은 디렉터리에 있어야 한다. 다른 경로에 두면 404 → SPA 폴백으로
 *          index.html이 대신 반환되어 "expected magic word" 에러가 난다.
 *
 * 라이브러리 사용자도 이 플러그인만 추가하면 별도 설정 불필요.
 */
const lazPerfWasmPlugin = {
  name: 'laz-perf-wasm',

  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url.includes('laz-perf.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(LAZ_WASM));
        return;
      }
      next();
    });
  },

  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'assets/laz-perf.wasm',
      source: readFileSync(LAZ_WASM),
    });
  },
};

export default defineConfig({
  plugins: [cesium(), lazPerfWasmPlugin],
  // worker.ts는 laz-perf.wasm(워커 빌드)을 fetch로 로드해야 하는데, 이
  // 글루 코드는 자신의 self.location.href가 blob: URL이면 상대경로를
  // 해석하지 못한다(scriptDirectory=""로 처리 → "Failed to parse URL").
  // 그래서 ?worker&inline(Blob) 대신 실제 URL을 갖는 별도 청크로 분리하는
  // ?worker를 사용한다. ES 포맷으로 번들해야 worker.ts 내부의
  // `import proj4 from 'proj4'`가 처리된다.
  worker: {
    format: 'es',
    plugins: () => [lazPerfWorkerAliasPlugin],
  },
});
