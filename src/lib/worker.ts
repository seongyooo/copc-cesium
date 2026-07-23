/// <reference lib="webworker" />
/**
 * CopcDataSource Worker
 *
 * 노드의 fetch(HTTP Range) + LAZ 압축 해제 + 속성 추출 + proj4 변환 +
 * WGS84 Cartesian3 계산까지 전부 이 워커 안에서 수행합니다.
 * (메인 스레드는 GPU 버퍼 업로드만 담당)
 *
 * 변경 이력:
 *  구조 변경: LAZ 디코딩(copc.js/laz-perf.wasm)을 메인 스레드에서 워커로 이전.
 *    laz-perf는 web/node/worker용 빌드를 각각 배포하는데(실제 .wasm 바이너리는
 *    동일, JS 글루 코드의 ENVIRONMENT_IS_WORKER 플래그만 다름), vite.config.js의
 *    worker-scoped alias로 이 파일 안에서 `import 'laz-perf'`가 worker 빌드를
 *    가져오도록 했다.
 *  B-6: EPSG:4326 데이터는 proj4 항등변환 불필요 → 스킵 (성능)
 *  A-7: RGB max 샘플링으로 8-bit / 16-bit 자동 판별
 *  C-4: colors를 Float32Array → Uint8Array로 직접 반환
 */
import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import proj4 from 'proj4';

interface WorkerMessage {
  id: string;
  url: string;
  copc: Awaited<ReturnType<typeof Copc.create>>;
  nodeInfo: Hierarchy.Node;
  srcProj: string;
  projDef: string | null;
  geoidOffset: number;
  zFactor?: number;
}

// WGS84 타원체 파라미터 (Cesium 없이 직접 Cartesian3 계산)
const WGS84_A  = 6378137.0;
const WGS84_E2 = 0.00669437999014;

function lonLatAltToCartesian(lonDeg: number, latDeg: number, altM: number): [number, number, number] {
  const lon    = lonDeg * (Math.PI / 180);
  const lat    = latDeg * (Math.PI / 180);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N      = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (N + altM) * cosLat * Math.cos(lon),
    (N + altM) * cosLat * Math.sin(lon),
    (N * (1 - WGS84_E2) + altM) * sinLat,
  ];
}

// srcProj별 등록 여부 추적
const _registeredProjs = new Set<string>();

self.onmessage = async ({ data }: MessageEvent<WorkerMessage>) => {
  const { id, url, copc, nodeInfo, srcProj, projDef, geoidOffset, zFactor = 0.3048 } = data;

  try {
    // ── 1. fetch(HTTP Range) + LAZ 압축 해제 ─────────────────
    const view = await Copc.loadPointDataView(url, copc, nodeInfo);
    const n    = view.pointCount;

    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
      throw new Error(`유효하지 않은 pointCount: ${n}`);
    }

    const getX = view.getter('X');
    const getY = view.getter('Y');
    const getZ = view.getter('Z');

    let getR: ((i: number) => number) | undefined;
    let getG: ((i: number) => number) | undefined;
    let getB: ((i: number) => number) | undefined;
    try { getR = view.getter('Red');   } catch { /* RGB 없음 */ }
    try { getG = view.getter('Green'); } catch { /* RGB 없음 */ }
    try { getB = view.getter('Blue');  } catch { /* RGB 없음 */ }
    const hasRGB = !!(getR && getG && getB);

    let getI: ((i: number) => number) | undefined;
    if (!hasRGB) {
      try { getI = view.getter('Intensity'); } catch { /* Intensity도 없음 */ }
    }

    let getCls: ((i: number) => number) | undefined;
    try { getCls = view.getter('Classification'); } catch { /* Classification 없음 */ }

    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const zs = new Float64Array(n);
    const rs = new Float32Array(n);
    const gs = new Float32Array(n);
    const bs = new Float32Array(n);
    const cls = new Uint8Array(n);
    const seenClasses = new Set<number>();

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
      cls[i] = c;
      seenClasses.add(c);
    }

    // ── 2. RGB/Intensity 색상 스케일 판별 (A-7) ──────────────
    let maxColor = 0;
    for (let i = 0; i < n; i++) {
      if (rs[i] > maxColor) maxColor = rs[i];
      if (gs[i] > maxColor) maxColor = gs[i];
      if (bs[i] > maxColor) maxColor = bs[i];
    }
    const colorScale = hasRGB
      ? (maxColor > 255 ? 65535 : 255)
      : (maxColor || 1);

    // ── 3. proj4 정의 등록 + 변환 객체 (루프 밖에서 한 번만) ──
    if (srcProj !== 'EPSG:4326' && projDef && !_registeredProjs.has(srcProj)) {
      proj4.defs(srcProj, projDef);
      _registeredProjs.add(srcProj);
    }
    const needsProj = srcProj !== 'EPSG:4326'; // B-6: 4326이면 항등변환이므로 스킵
    const converter = needsProj ? proj4(srcProj, 'EPSG:4326') : null;
    if (needsProj && converter && n > 0) {
      const [testLon, testLat] = converter.forward([xs[0], ys[0]]);
      if (!isFinite(testLon) || !isFinite(testLat)) {
        throw new Error(
          `proj4 변환 실패 (NaN): srcProj=${srcProj}, x=${xs[0]}, y=${ys[0]}. ` +
          `projDef가 올바른지 확인하세요.`
        );
      }
    }

    // ── 4. 좌표 변환 (proj4 → lon/lat) + ECEF Cartesian3 계산 ─
    const positions = new Float64Array(n * 3);
    const colors    = new Uint8Array(n * 4); // C-4: Uint8Array로 직접 생성

    for (let i = 0; i < n; i++) {
      let lon: number;
      let lat: number;
      if (needsProj && converter) {
        [lon, lat] = converter.forward([xs[i], ys[i]]);
        if (!isFinite(lon) || !isFinite(lat)) {
          throw new Error(
            `proj4 변환 실패 (index ${i}, NaN): x=${xs[i]}, y=${ys[i]}. ` +
            `projDef가 올바른지 확인하세요.`
          );
        }
      } else {
        lon = xs[i];
        lat = ys[i];
      }

      const alt          = zs[i] * zFactor + geoidOffset;
      const [cx, cy, cz] = lonLatAltToCartesian(lon, lat, alt);

      positions[i * 3]     = cx;
      positions[i * 3 + 1] = cy;
      positions[i * 3 + 2] = cz;

      colors[i * 4]     = (rs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 1] = (gs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 2] = (bs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 3] = 255;
    }

    // ── 5. ECEF Float64 → Float32 high/low 분리 (RTE) ────────
    const posHigh = new Float32Array(n * 3);
    const posLow  = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      const v    = positions[i];
      const hi   = Math.fround(v);
      posHigh[i] = hi;
      posLow[i]  = v - hi;
    }

    // ── 6. BoundingSphere (ECEF, Float64 평균/최대거리) ──────
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < n; i++) {
      sumX += positions[i * 3];
      sumY += positions[i * 3 + 1];
      sumZ += positions[i * 3 + 2];
    }
    const cx = sumX / n;
    const cy = sumY / n;
    const cz = sumZ / n;

    let rSq = 0;
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3]     - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const d  = dx * dx + dy * dy + dz * dz;
      if (d > rSq) rSq = d;
    }

    self.postMessage(
      {
        id, posHigh, posLow, colors, cls, pointCount: n,
        sphereCenter: [cx, cy, cz] as [number, number, number],
        sphereRadius: Math.sqrt(rSq),
        seenClasses: [...seenClasses],
      },
      [posHigh.buffer, posLow.buffer, colors.buffer, cls.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
