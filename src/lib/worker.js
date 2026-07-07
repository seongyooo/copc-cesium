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

let _projReady = false;

self.onmessage = ({ data }) => {
  const { id, xs, ys, zs, rs, gs, bs, pointCount, srcProj, projDef, geoidOffset } = data;

  try {
    // proj4 정의 최초 1회 등록
    if (!_projReady && srcProj !== 'EPSG:4326' && projDef) {
      proj4.defs(srcProj, projDef);
      _projReady = true;
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
