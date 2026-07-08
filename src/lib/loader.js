import * as Cesium from 'cesium';
import { Copc } from 'copc';

// ── PointCloudPrimitive ──────────────────────────────────────
//
// Cesium.Primitive 대신 DrawCommand를 직접 사용하는 경량 래퍼.
//
// Cesium.Primitive 는 내부 geometry pipeline 에서 batchId 속성과
// 관련 셰이더 코드를 자동 주입하는데, 커스텀 포인트 클라우드에서는
// 이 파이프라인이 불필요하고 오류를 유발한다.
//
// 이 클래스는 PrimitiveCollection 이 요구하는 덕 타이핑 인터페이스
// (update / isDestroyed / destroy / show) 만 구현하여 씬에 추가된다.
//
// GPU 리소스(VertexArray, ShaderProgram)는 첫 번째 update() 호출 시
// 지연 생성된다. (frameState.context 가 필요하기 때문)
//
class PointCloudPrimitive {
  /**
   * @param {Float32Array} posHigh  ECEF x/y/z 상위 Float32 (n×3)
   * @param {Float32Array} posLow   ECEF x/y/z 하위 Float32 (n×3)
   * @param {Uint8Array}   colU8    RGBA 0-255 (n×4)
   * @param {number}       pointCount
   * @param {Cesium.BoundingSphere} boundingSphere
   * @param {number}       pixelSize
   */
  constructor(posHigh, posLow, colU8, pointCount, boundingSphere, pixelSize) {
    this._posHigh        = posHigh;
    this._posLow         = posLow;
    this._colU8          = colU8;
    this._pointCount     = pointCount;
    this._boundingSphere = boundingSphere;
    this._pixelSize      = pixelSize;
    this.show            = true;
    this._destroyed      = false;
    this._cmd            = null;    // 지연 생성
    this._va             = null;
    this._sp             = null;
  }

  // PrimitiveCollection 이 매 프레임 호출
  update(frameState) {
    if (!this.show || this._destroyed) return;
    if (!this._cmd) {
      this._initGpu(frameState.context);
    }
    frameState.commandList.push(this._cmd);
  }

  _initGpu(context) {
    const pxSz = this._pixelSize;

    // ── 버텍스 버퍼 생성 ─────────────────────────────────────
    const mkVBuf = (arr) => Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: arr,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });

    // ── 버텍스 배열 (VAO) ────────────────────────────────────
    //   location 0 → position3DHigh (Float32 ×3)
    //   location 1 → position3DLow  (Float32 ×3)
    //   location 2 → color          (Uint8   ×4, normalized)
    const va = new Cesium.VertexArray({
      context,
      attributes: [
        {
          index:                 0,
          vertexBuffer:          mkVBuf(this._posHigh),
          componentsPerAttribute: 3,
          componentDatatype:     Cesium.ComponentDatatype.FLOAT,
          offsetInBytes:         0,
          strideInBytes:         12,
        },
        {
          index:                 1,
          vertexBuffer:          mkVBuf(this._posLow),
          componentsPerAttribute: 3,
          componentDatatype:     Cesium.ComponentDatatype.FLOAT,
          offsetInBytes:         0,
          strideInBytes:         12,
        },
        {
          index:                 2,
          vertexBuffer:          mkVBuf(this._colU8),
          componentsPerAttribute: 4,
          componentDatatype:     Cesium.ComponentDatatype.UNSIGNED_BYTE,
          normalize:             true,
          offsetInBytes:         0,
          strideInBytes:         4,
        },
      ],
    });

    // ── 셰이더 ───────────────────────────────────────────────
    //
    // czm_translateRelativeToEye: 카메라 위치를 빼 eye-space 변환 (RTE).
    // czm_modelViewProjectionRelativeToEye: eye-space → clip-space 행렬.
    // 두 내장 심볼은 ShaderProgram.fromCache 내 ShaderSource 처리 시
    // Cesium 이 자동으로 include 하며, DrawCommand 실행 시 auto-uniform
    // 시스템이 현재 카메라 상태로 자동 설정한다.
    //
    const vs = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
out vec4 v_color;
void main() {
  v_color = color;
  gl_PointSize = ${pxSz.toFixed(1)};
  vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

    const fs = `
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}`;

    // attributeLocations 로 VAO index 와 셰이더 attribute 위치를 명시 매핑
    const sp = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource:   vs,
      fragmentShaderSource: fs,
      attributeLocations: {
        position3DHigh: 0,
        position3DLow:  1,
        color:          2,
      },
    });

    // ── DrawCommand ──────────────────────────────────────────
    this._va  = va;
    this._sp  = sp;
    this._cmd = new Cesium.DrawCommand({
      vertexArray:    va,
      primitiveType:  Cesium.PrimitiveType.POINTS,
      shaderProgram:  sp,
      renderState:    Cesium.RenderState.fromCache({
        depthTest: { enabled: true },
        depthMask: false,
      }),
      boundingVolume: this._boundingSphere,
      count:          this._pointCount,
      pass:           Cesium.Pass.OPAQUE,
      modelMatrix:    Cesium.Matrix4.IDENTITY,
    });

    // CPU 사이드 배열 해제 (GPU 업로드 완료)
    this._posHigh = null;
    this._posLow  = null;
    this._colU8   = null;
  }

  isDestroyed() { return this._destroyed; }

  destroy() {
    if (!this._destroyed) {
      if (this._va) this._va.destroy();
      if (this._sp) this._sp.destroy();
      this._destroyed = true;
    }
    return Cesium.destroyObject(this);
  }
}

// ── loadNode ─────────────────────────────────────────────────
/**
 * COPC 노드를 로드하여 PointCloudPrimitive를 반환합니다.
 *
 * 메모리:
 *   Before (PointPrimitiveCollection): 10만 점 × ~400 B = 40 MB/노드
 *   After  (DrawCommand + typed arrays): 10만 점 × 28 B  = 2.8 MB/노드  (약 14배 절약)
 *
 * 정밀도: ECEF Float64 좌표를 high/low Float32 페어로 분리(RTE)하여
 *         전 지구 규모에서도 sub-mm 정밀도를 유지합니다.
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
export async function loadNode(url, copc, nodeInfo, pool, srcProj, projDef, geoidOffset, pixelSize = 2, zFactor = 0.3048) {
  // ── 1. fetch + LAZ 파싱 ───────────────────────────────────
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

  // ── 2. Worker: proj4 변환 + WGS84 Cartesian3 계산 ────────
  const { positions, colors, pointCount } = await pool.run(
    { xs, ys, zs, rs, gs, bs, pointCount: n, srcProj, projDef, geoidOffset, zFactor },
    [xs.buffer, ys.buffer, zs.buffer, rs.buffer, gs.buffer, bs.buffer],
  );

  // ── 3. 색상 배열 (C-4: Worker가 이미 Uint8Array로 반환) ───
  // worker.js에서 직접 0-255 Uint8Array로 변환하므로 변환 루프 불필요.
  // 비트 심도(8/16-bit) 자동 판별도 Worker에서 수행.
  const colU8 = colors; // Uint8Array (n×4)

  // ── 4. ECEF Float64 → Float32 high/low 분리 (RTE) ────────
  //
  // 카메라가 ECEF 원점(지구 중심)에서 수백만 m 떨어진 곳에 있으므로
  // Float32 단독으로는 정밀도 부족 (~0.5m 오차).
  // high = nearestFloat32(v),  low = v - high
  // GPU 에서 czm_translateRelativeToEye(high, low) 로 카메라 기준 변환.
  //
  const posHigh = new Float32Array(pointCount * 3);
  const posLow  = new Float32Array(pointCount * 3);
  for (let i = 0; i < pointCount * 3; i++) {
    const v    = positions[i];
    const hi   = Math.fround(v);
    posHigh[i] = hi;
    posLow[i]  = v - hi;
  }

  // ── 5. BoundingSphere (ECEF, Float64 평균/최대거리) ──────
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
    const dx = positions[i * 3]     - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const d  = dx * dx + dy * dy + dz * dz;
    if (d > rSq) rSq = d;
  }
  const boundingSphere = new Cesium.BoundingSphere(
    new Cesium.Cartesian3(cx, cy, cz),
    Math.sqrt(rSq),
  );

  // ── 6. PointCloudPrimitive 생성 ──────────────────────────
  const primitive = new PointCloudPrimitive(
    posHigh, posLow, colU8, pointCount, boundingSphere, pixelSize,
  );

  return { collection: primitive, pointCount, lastUsed: Date.now() };
}
