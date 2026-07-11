/// <reference lib="webworker" />
/**
 * CopcDataSource Worker
 *
 * 메인 스레드에서 copc.js로 추출한 raw 좌표 배열을 받아
 * proj4 변환 + WGS84 Cartesian3 계산을 수행합니다.
 * (copc.js / laz-perf.wasm 사용 안 됨)
 *
 * 변경 이력:
 *  B-6: EPSG:4326 데이터는 proj4 항등변환 불필요 → 스킵 (성능)
 *  A-7: RGB max 샘플링으로 8-bit / 16-bit 자동 판별
 *  C-4: colors를 Float32Array → Uint8Array로 직접 반환
 *       (메인 스레드의 변환 루프 제거 + 전송 크기 4배 절약)
 */
import proj4 from 'proj4';

interface WorkerMessage {
  id: string;
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  rs: Float32Array;
  gs: Float32Array;
  bs: Float32Array;
  pointCount: number;
  srcProj: string;
  projDef: string | null;
  geoidOffset: number;
  zFactor?: number;
  hasRGB?: boolean;
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

self.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
  const { id, xs, ys, zs, rs, gs, bs, pointCount, srcProj, projDef, geoidOffset, zFactor = 0.3048, hasRGB = true } = data;

  try {
    if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > 10_000_000) {
      throw new Error(`유효하지 않은 pointCount: ${pointCount}`);
    }

    // ── proj4 정의 등록 ─────────────────────────────────────
    if (srcProj !== 'EPSG:4326' && projDef && !_registeredProjs.has(srcProj)) {
      proj4.defs(srcProj, projDef);
      _registeredProjs.add(srcProj);
    }

    // ── proj4 변환 객체 생성 (루프 밖에서 한 번만 — PERF) ──────
    const needsProj = srcProj !== 'EPSG:4326'; // B-6: 4326이면 항등변환이므로 스킵
    const converter = needsProj ? proj4(srcProj, 'EPSG:4326') : null;
    if (needsProj && converter && pointCount > 0) {
      const [testLon, testLat] = converter.forward([xs[0], ys[0]]);
      if (!isFinite(testLon) || !isFinite(testLat)) {
        throw new Error(
          `proj4 변환 실패 (NaN): srcProj=${srcProj}, x=${xs[0]}, y=${ys[0]}. ` +
          `projDef가 올바른지 확인하세요.`
        );
      }
    }

    // ── A-7: 색상 스케일 결정 ────────────────────────────────
    // RGB: uint16(0-65535) or uint8(0-255) → 최댓값으로 판별
    // Intensity(grayscale): 실제 max로 정규화하여 전체 밝기 범위 활용
    let maxColor = 0;
    for (let i = 0; i < pointCount; i++) {
      if (rs[i] > maxColor) maxColor = rs[i];
      if (gs[i] > maxColor) maxColor = gs[i];
      if (bs[i] > maxColor) maxColor = bs[i];
    }
    const colorScale = hasRGB
      ? (maxColor > 255 ? 65535 : 255)
      : (maxColor || 1);

    // ── 출력 버퍼 ────────────────────────────────────────────
    const positions = new Float64Array(pointCount * 3);
    // C-4: Uint8Array로 직접 생성 (Float32 대비 전송 크기 4배 절약)
    const colors    = new Uint8Array(pointCount * 4);

    for (let i = 0; i < pointCount; i++) {
      // B-6: EPSG:4326이면 proj4 호출 스킵 (항등변환)
      let lon: number;
      let lat: number;
      if (needsProj && converter) {
        [lon, lat] = converter.forward([xs[i], ys[i]]);
        // A5: 첫 포인트뿐만 아니라 모든 포인트에서 NaN 감지
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

      // C-4: 0-255 Uint8로 직접 저장
      colors[i * 4]     = (rs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 1] = (gs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 2] = (bs[i] / colorScale * 255 + 0.5) | 0;
      colors[i * 4 + 3] = 255;
    }

    self.postMessage(
      { id, positions, colors, pointCount },
      [positions.buffer, colors.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
