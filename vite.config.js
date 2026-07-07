import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAZ_WASM = resolve('node_modules/laz-perf/lib/laz-perf.wasm');

/**
 * laz-perf-wasm 플러그인
 *
 * Vite가 copc/laz-perf를 번들링하면 laz-perf.js가 번들 경로 기준으로
 * laz-perf.wasm을 fetch하지만 wasm 파일은 복사되지 않아 404가 발생합니다.
 *
 * - dev:   어느 경로의 laz-perf.wasm 요청이든 실제 파일로 응답하는 미들웨어
 * - build: 번들 출력에 laz-perf.wasm을 자산으로 포함
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
      fileName: 'laz-perf.wasm',
      source: readFileSync(LAZ_WASM),
    });
  },
};

export default defineConfig({
  plugins: [cesium(), lazPerfWasmPlugin],
});
