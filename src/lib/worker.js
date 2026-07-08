/**
 * CopcDataSource Worker
 *
 * 메인 스레드에서 copc.js로 추출한 raw 좌표 배열을 받아
 * proj4 변환 + WGS84 Cartesian3 계산을 수행합니다.
 * (copc.js / laz-perf.wasm 사용 안 함)
 *
 * 변경 이력:
 *  B-6: EPSG:4326 데이터는 proj4 항등변환 불필요 → 스킵 (성능)
 *  A-7: RGB max 샘플링으로 8-bit / 16-bit 자동 판별
 *  C-4: colors를 Float32Array → Uint8Array로 직접 반환
 *       (메인 스레드의 변환 루프 제거 + 전송 크기 4배 절약)
 */
import proj4 from 'proj4';

// WGS84 타원체 파라미터 (Cesium 없이 직접 Cartesian3 계산)
const WGS84_A  = 6378137.0;
const WGS84_E2 = 0.00669437999014;

function lonLatAltToCartesian(lonDeg, latDeg, altM) {
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
const _registeredProjs = new Set();

self.onmessage = ({ data }) => {
  const { id, xs, ys, zs, rs, gs, bs, pointCount, srcProj, projDef, geoidOffset } = data;

  try {
    if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > 10_000_000) {
      throw new Error(`유효하지 않은 pointCount: ${pointCount}`);
    }

    // ── proj4 정의 등록 ─────────────────────────────────────
    if (srcProj !== 'EPSG:4326' && projDef && !_registeredProjs.has(srcProj)) {
      proj4.defs(srcProj, projDef);
      _registeredProjs.add(srcProj);
    }

    // ── proj4 설정 검증 (첫 포인트로 빠른 실패) ─────────────
    const needsProj = srcProj !== 'EPSG:4326'; // B-6: 4326이면 항등변환이므로 스킵
    if (needsProj && pointCount > 0) {
      const [testLon, testLat] = proj4(srcProj, 'EPSG:4326', [xs[0], ys[0]]);
      if (!isFinite(testLon) || !isFinite(testLat)) {
        throw new Error(
          `proj4 변환 실패 (NaN): srcProj=${srcProj}, x=${xs[0]}, y=${ys[0]}. ` +
          `projDef가 올바른지 확인하세요.`
        );
      }
    }

    // ── A-7: RGB 비트 심도 자동 판별 ────────────────────────
    // COPC 포맷은 R/G/B를 uint16(0-65535) 또는 uint8(0-255)로 저장할 수 있다.
    // 최댓값을 샘플링하여 255 초과 시 16-bit, 이하이면 8-bit로 판정.
    let maxColor = 0;
    for (let i = 0; i < pointCount; i++) {
      if (rs[i] > maxColor) maxColor = rs[i];
      if (gs[i] > maxColor) maxColor = gs[i];
      if (bs[i] > maxColor) maxColor = bs[i];
    }
    const colorScale = maxColor > 255 ? 65535 : 255;

    // ── 출력 버퍼 ────────────────────────────────────────────
    const positions = new Float64Array(pointCount * 3);
    // C-4: Uint8Array로 직접 생성 (Float32 대비 전송 크기 4배 절약)
    const colors    = new Uint8Array(pointCount * 4);

    for (let i = 0; i < pointCount; i++) {
      // B-6: EPSG:4326이면 proj4 호출 스킵 (항등변환)
      let lon, lat;
      if (needsProj) {
        [lon, lat] = proj4(srcProj, 'EPSG:4326', [xs[i], ys[i]]);
      } else {
        lon = xs[i];
        lat = ys[i];
      }

      const alt          = zs[i] * 0.3048 + geoidOffset;
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
    self.postMessage({ id, error: err.message });
  }
};
