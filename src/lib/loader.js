import * as Cesium from 'cesium';
import { Copc } from 'copc';

// ── PointCloudPrimitive ──────────────────────────────────────
//
// Cesium.Primitive 대신 DrawCommand를 직접 사용하는 경량 래퍼.
//
// GPU 리소스(VertexArray, ShaderProgram)는 첫 번째 update() 호출 시
// 지연 생성된다. (frameState.context 가 필요하기 때문)
//
// pixelSizeRef / classMaskRef 는 CopcDataSource 가 공유하는 객체로,
// 슬라이더·분류 필터 변경 시 해당 값만 업데이트하면 모든 프리미티브에
// 즉시 반영된다 (셰이더 리컴파일·재로드 불필요).
//
class PointCloudPrimitive {
  /**
   * @param {Float32Array} posHigh  ECEF x/y/z 상위 Float32 (n×3)
   * @param {Float32Array} posLow   ECEF x/y/z 하위 Float32 (n×3)
   * @param {Uint8Array}   colU8    RGBA 0-255 (n×4)
   * @param {Uint8Array}   cls      분류값 0-255 (n×1)
   * @param {number}       pointCount
   * @param {Cesium.BoundingSphere} boundingSphere
   * @param {{ value: number }} pixelSizeRef  공유 점 크기 ref
   * @param {{ value: number }} classMaskRef  공유 분류 마스크 ref (비트 N = 클래스 N 표시)
   * @param {{ value: Cesium.Cartesian3 }} upVecRef      공유 상향 벡터 ref
   * @param {{ value: number }} heightOffsetRef 공유 고도 오프셋 ref (m)
   */
  constructor(posHigh, posLow, colU8, cls, pointCount, boundingSphere, pixelSizeRef, classMaskRef, upVecRef, heightOffsetRef) {
    this._posHigh         = posHigh;
    this._posLow          = posLow;
    this._colU8           = colU8;
    this._cls             = cls;
    this._pointCount      = pointCount;
    this._boundingSphere  = boundingSphere;
    this._pixelSizeRef    = pixelSizeRef;
    this._classMaskRef    = classMaskRef;
    this._upVecRef        = upVecRef;
    this._heightOffsetRef = heightOffsetRef;
    this.show             = true;
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
    //   location 3 → classification (Uint8   ×1, 정수값)
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
        {
          index:                 3,
          vertexBuffer:          mkVBuf(this._cls),
          componentsPerAttribute: 1,
          componentDatatype:     Cesium.ComponentDatatype.UNSIGNED_BYTE,
          normalize:             false,
          offsetInBytes:         0,
          strideInBytes:         1,
        },
      ],
    });

    // ── 셰이더 ───────────────────────────────────────────────
    //
    // u_pixelSize: 슬라이더 조작 즉시 반영 (캐시 유지)
    // u_classMask: 비트 N = 클래스 N 표시. -1이면 전체 표시.
    //   cls >= 32인 점은 항상 표시 (ASPRS 예약 클래스).
    //   short-circuit &&: cls < 32 가 false면 우변 비트 연산 실행 안 됨.
    //
    const vs = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float classification;
uniform float u_pixelSize;
uniform vec3 u_upVec;
uniform float u_heightOffset;
out vec4 v_color;
flat out float v_cls;
void main() {
  v_color = color;
  v_cls = classification;
  gl_PointSize = u_pixelSize;
  vec3 adjHigh = position3DHigh + u_upVec * u_heightOffset;
  vec4 p = czm_translateRelativeToEye(adjHigh, position3DLow);
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

    const fs = `
in vec4 v_color;
flat in float v_cls;
uniform int u_classMask;
out vec4 fragColor;
void main() {
  int cls = int(v_cls + 0.5);
  if (cls >= 0 && cls < 32 && ((u_classMask >> cls) & 1) == 0) discard;
  fragColor = v_color;
}`;

    // uniformMap 클로저: ref 객체를 캡처하여 매 프레임 최신값 반환
    const pixelSizeRef    = this._pixelSizeRef;
    const classMaskRef    = this._classMaskRef;
    const upVecRef        = this._upVecRef;
    const heightOffsetRef = this._heightOffsetRef;

    const sp = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource:   vs,
      fragmentShaderSource: fs,
      attributeLocations: {
        position3DHigh: 0,
        position3DLow:  1,
        color:          2,
        classification: 3,
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
        depthMask: true,
      }),
      boundingVolume: this._boundingSphere,
      count:          this._pointCount,
      pass:           Cesium.Pass.OPAQUE,
      modelMatrix:    Cesium.Matrix4.IDENTITY,
      uniformMap: {
        u_pixelSize:    () => pixelSizeRef.value,
        u_classMask:    () => classMaskRef.value,
        u_upVec:        () => upVecRef ? upVecRef.value : new Cesium.Cartesian3(0, 0, 1),
        u_heightOffset: () => heightOffsetRef ? heightOffsetRef.value : 0,
      },
    });

    // CPU 사이드 배열 해제 (GPU 업로드 완료)
    this._posHigh = null;
    this._posLow  = null;
    this._colU8   = null;
    this._cls     = null;
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
 * @param {string}     url
 * @param {object}     copc        Copc.create() 반환값
 * @param {object}     nodeInfo    nodes[key]
 * @param {WorkerPool} pool
 * @param {string}     srcProj
 * @param {string}     projDef
 * @param {number}     geoidOffset
 * @param {{ value: number }} pixelSizeRef  공유 점 크기 ref
 * @param {{ value: number }} classMaskRef  공유 분류 마스크 ref
 * @param {number}     [zFactor=0.3048]
 * @param {{ value: Cesium.Cartesian3 }} [upVecRef=null]      공유 상향 벡터 ref
 * @param {{ value: number }}            [heightOffsetRef=null] 공유 고도 오프셋 ref
 * @returns {{ collection, pointCount, lastUsed, seenClasses }}
 */
export async function loadNode(url, copc, nodeInfo, pool, srcProj, projDef, geoidOffset, pixelSizeRef, classMaskRef, zFactor = 0.3048, upVecRef = null, heightOffsetRef = null) {
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

  let getCls;
  try { getCls = view.getter('Classification'); } catch { /* Classification 없음 */ }

  const xs   = new Float64Array(n);
  const ys   = new Float64Array(n);
  const zs   = new Float64Array(n);
  const rs   = new Float32Array(n);
  const gs   = new Float32Array(n);
  const bs   = new Float32Array(n);
  const clsU8      = new Uint8Array(n);
  const seenClasses = new Set();

  for (let i = 0; i < n; i++) {
    xs[i] = getX(i); ys[i] = getY(i); zs[i] = getZ(i);
    if (hasRGB) {
      rs[i] = getR(i); gs[i] = getG(i); bs[i] = getB(i);
    } else if (getI) {
      rs[i] = gs[i] = bs[i] = getI(i);
    } else {
      rs[i] = gs[i] = bs[i] = 65535;
    }
    const c  = getCls ? (getCls(i) & 0xFF) : 0;
    clsU8[i] = c;
    seenClasses.add(c);
  }

  // ── 2. Worker: proj4 변환 + WGS84 Cartesian3 계산 ────────
  const { positions, colors, pointCount } = await pool.run(
    { xs, ys, zs, rs, gs, bs, pointCount: n, srcProj, projDef, geoidOffset, zFactor },
    [xs.buffer, ys.buffer, zs.buffer, rs.buffer, gs.buffer, bs.buffer],
  );

  // ── 3. 색상 배열 (Worker가 이미 Uint8Array로 반환) ────────
  const colU8 = colors; // Uint8Array (n×4)

  // ── 4. ECEF Float64 → Float32 high/low 분리 (RTE) ────────
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
    posHigh, posLow, colU8, clsU8, pointCount, boundingSphere, pixelSizeRef, classMaskRef, upVecRef, heightOffsetRef,
  );

  return { collection: primitive, pointCount, lastUsed: Date.now(), seenClasses };
}
