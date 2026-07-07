import * as Cesium from 'cesium';
import { Copc } from 'copc';

/**
 * COPC 노드를 로드하여 Cesium.Primitive를 반환합니다.
 *
 * PointPrimitiveCollection 대신 Primitive + raw 타입 배열을 사용해
 * 점별 JS 객체 생성을 없앱니다.
 *
 *   Before: 10만 점 × JS 객체 ~400 bytes = 40MB/노드
 *   After:  10만 점 × (Float64×3 + Uint8×4) = 2.8MB/노드  (약 14배 절약)
 *
 * 정밀도: Cesium의 position3DHigh/position3DLow 인코딩(RTE)을 사용해
 * 전 지구 규모에서도 sub-mm 정밀도를 유지합니다.
 *
 * @param {string}     url
 * @param {object}     copc        Copc.create() 반환값
 * @param {object}     nodeInfo    nodes[key]
 * @param {WorkerPool} pool
 * @param {string}     srcProj
 * @param {string}     projDef
 * @param {number}     geoidOffset
 * @param {number}     [pixelSize=2]
 */
export async function loadNode(url, copc, nodeInfo, pool, srcProj, projDef, geoidOffset, pixelSize = 2) {
  // ── 1. 메인 스레드: fetch + LAZ 파싱 ──────────────────────
  const view = await Copc.loadPointDataView(url, copc, nodeInfo);
  const n    = view.pointCount;

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');

  let getR, getG, getB;
  try { getR = view.getter('Red');   } catch { /* RGB 없음 */ }
  try { getG = view.getter('Green'); } catch { /* RGB 없음 */ }
  try { getB = view.getter('Blue');  } catch { /* RGB 없음 */ }
  const hasRGB = !!(getR && getG && getB);

  let getI;
  if (!hasRGB) {
    try { getI = view.getter('Intensity'); } catch { /* Intensity도 없음 */ }
  }

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  const rs = new Float32Array(n);
  const gs = new Float32Array(n);
  const bs = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    xs[i] = getX(i); ys[i] = getY(i); zs[i] = getZ(i);
    if (hasRGB) {
      rs[i] = getR(i); gs[i] = getG(i); bs[i] = getB(i);
    } else if (getI) {
      rs[i] = gs[i] = bs[i] = getI(i);
    } else {
      rs[i] = gs[i] = bs[i] = 65535;
    }
  }

  // ── 2. Worker: proj4 변환 + WGS84 Cartesian3 계산 ─────────
  // positions: Float64Array(n×3) — ECEF xyz
  // colors:    Float32Array(n×4) — 0..1 RGBA
  const { positions, colors, pointCount } = await pool.run(
    { xs, ys, zs, rs, gs, bs, pointCount: n, srcProj, projDef, geoidOffset },
    [xs.buffer, ys.buffer, zs.buffer, rs.buffer, gs.buffer, bs.buffer],
  );

  // ── 3. 색상 Uint8 변환 (Float32 대비 4배 메모리 절약) ─────
  const colU8 = new Uint8Array(pointCount * 4);
  for (let i = 0; i < pointCount * 4; i++) {
    colU8[i] = (colors[i] * 255 + 0.5) | 0;
  }

  // ── 4. BoundingSphere 계산 (ECEF Float64) ─────────────────
  let sumX = 0, sumY = 0, sumZ = 0;
  for (let i = 0; i < pointCount; i++) {
    sumX += positions[i * 3];
    sumY += positions[i * 3 + 1];
    sumZ += positions[i * 3 + 2];
  }
  const cx = sumX / pointCount;
  const cy = sumY / pointCount;
  const cz = sumZ / pointCount;

  let rSq = 0;
  for (let i = 0; i < pointCount; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > rSq) rSq = d;
  }
  const boundingSphere = new Cesium.BoundingSphere(
    new Cesium.Cartesian3(cx, cy, cz),
    Math.sqrt(rSq),
  );

  // ── 5. Cesium.Geometry 생성 ────────────────────────────────
  //
  // position: ComponentDatatype.DOUBLE → Cesium 파이프라인이 자동으로
  //   position3DHigh / position3DLow 두 Float32 속성으로 인코딩합니다.
  //   버텍스 셰이더에서 czm_translateRelativeToEye로 카메라 기준 좌표로 변환,
  //   전 지구 규모에서도 sub-mm 정밀도를 유지합니다.
  //
  const geometry = new Cesium.Geometry({
    attributes: new Cesium.GeometryAttributes({
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,          // Float64Array — Cesium이 high/low로 분리
      }),
      color: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
        componentsPerAttribute: 4,
        normalize: true,            // 0-255 → 0.0-1.0 (GPU에서 자동 변환)
        values: colU8,
      }),
    }),
    primitiveType: Cesium.PrimitiveType.POINTS,
    boundingSphere,
  });

  // ── 6. 커스텀 버텍스/프래그먼트 셰이더 ────────────────────
  //
  // czm_translateRelativeToEye: Cesium 내장 함수.
  //   카메라 위치를 빼서 eye-space 좌표로 변환 (RTE 기법).
  // czm_modelViewProjectionRelativeToEye: eye-space → clip-space 행렬.
  //
  const vs = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
out vec4 v_color;
void main() {
  v_color = color;
  gl_PointSize = ${pixelSize.toFixed(1)};
  vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

  const fs = `
in vec4 v_color;
void main() {
  gl_FragColor = v_color;
}`;

  // ── 7. Cesium.Primitive 생성 ────────────────────────────────
  //
  // asynchronous: false — 다음 프레임에 동기적으로 VBO 생성.
  //   (이미 Worker에서 좌표 변환 완료, GPU 업로드만 남은 상태)
  // allowPicking: false — picking 용 배치 ID 속성 추가 안 함.
  // compressVertices: false — 법선/텍스처 압축 스킵 (해당 속성 없음).
  //
  const appearance = new Cesium.Appearance({
    renderState: {
      depthTest: { enabled: true },
      depthMask: false,
    },
    vertexShaderSource: vs,
    fragmentShaderSource: fs,
  });

  const primitive = new Cesium.Primitive({
    geometryInstances:  new Cesium.GeometryInstance({ geometry }),
    appearance,
    asynchronous:       false,
    allowPicking:       false,
    compressVertices:   false,
  });

  return { collection: primitive, pointCount, lastUsed: Date.now() };
}
