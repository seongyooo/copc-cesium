/**
 * CopcDataSource Worker
 *
 * 메인 스레드에서 copc.js로 추출한 raw 좌표 배열을 받아
 * proj4 변환 + WGS84 Cartesian3 계산을 수행합니다.
 * (copc.js / laz-perf.wasm 사용 안 함)
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

// srcProj별 등록 여부 추적 (boolean 플래그 대신 Set 사용)
// Worker 재생성 시 Set이 초기화되므로 자동으로 재등록됨
const _registeredProjs = new Set();

self.onmessage = ({ data }) => {
  const { id, xs, ys, zs, rs, gs, bs, pointCount, srcProj, projDef, geoidOffset } = data;

  try {
    // 입력값 검증
    if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > 10_000_000) {
      throw new Error(`유효하지 않은 pointCount: ${pointCount}`);
    }

    // proj4 정의 등록 (srcProj별 1회, Worker 재생성 시에도 재등록)
    if (srcProj !== 'EPSG:4326' && projDef && !_registeredProjs.has(srcProj)) {
      proj4.defs(srcProj, projDef);
      _registeredProjs.add(srcProj);
    }

    // proj4 설정 검증: 첫 포인트로 빠른 실패 (전체 루프 전에 감지)
    if (srcProj !== 'EPSG:4326' && pointCount > 0) {
      const [testLon, testLat] = proj4(srcProj, 'EPSG:4326', [xs[0], ys[0]]);
      if (!isFinite(testLon) || !isFinite(testLat)) {
        throw new Error(
          `proj4 변환 실패 (NaN): srcProj=${srcProj}, x=${xs[0]}, y=${ys[0]}. ` +
          `projDef가 올바른지 확인하세요.`
        );
      }
    }

    const positions = new Float64Array(pointCount * 3);
    const colors    = new Float32Array(pointCount * 4);

    for (let i = 0; i < pointCount; i++) {
      const [lon, lat] = proj4(srcProj, 'EPSG:4326', [xs[i], ys[i]]);
      const alt        = zs[i] * 0.3048 + geoidOffset;
      const [cx, cy, cz] = lonLatAltToCartesian(lon, lat, alt);

      positions[i * 3]     = cx;
      positions[i * 3 + 1] = cy;
      positions[i * 3 + 2] = cz;

      colors[i * 4]     = rs[i] / 65535;
      colors[i * 4 + 1] = gs[i] / 65535;
      colors[i * 4 + 2] = bs[i] / 65535;
      colors[i * 4 + 3] = 1.0;
    }

    // Transferable: 버퍼 복사 없이 메인 스레드로 이동
    self.postMessage(
      { id, positions, colors, pointCount },
      [positions.buffer, colors.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
