import * as Cesium from 'cesium';
import { Copc } from 'copc';
import type { Hierarchy } from 'copc';
import type { Ref, NodeCacheEntry, Renderable } from '../types.js';
import { WorkerPool } from './WorkerPool.js';

// C1: Cesium 내부 API는 공개 타입이 없으므로 사용하는 API만 최소 선언
interface CesiumInternal {
  Buffer: { createVertexBuffer(opts: { context: unknown; typedArray: ArrayBufferView; usage: unknown }): unknown };
  BufferUsage: { STATIC_DRAW: unknown };
  VertexArray: new (opts: { context: unknown; attributes: unknown[] }) => { destroy(): void };
  ShaderProgram: { fromCache(opts: { context: unknown; vertexShaderSource: string; fragmentShaderSource: string; attributeLocations: Record<string, number> }): { destroy(): void } };
  DrawCommand: new (opts: Record<string, unknown>) => unknown;
  RenderState: { fromCache(opts: Record<string, unknown>): unknown };
  Pass: { OPAQUE: unknown };
}
const CesiumAny = Cesium as unknown as CesiumInternal;

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
class PointCloudPrimitive implements Renderable {
  private _posHigh: Float32Array | null;
  private _posLow:  Float32Array | null;
  private _colU8:   Uint8Array   | null;
  private _cls:     Uint8Array   | null;
  private _pointCount: number;
  private _boundingSphere: Cesium.BoundingSphere;
  private _pixelSizeRef: Ref<number>;
  private _classMaskRef: Ref<number>;
  private _upVecRef: Ref<Cesium.Cartesian3> | null;
  private _heightOffsetRef: Ref<number> | null;
  public show: boolean;
  private _destroyed: boolean;
  private _cmd: any;
  private _va:  any;
  private _sp:  any;

  constructor(
    posHigh: Float32Array,
    posLow: Float32Array,
    colU8: Uint8Array,
    cls: Uint8Array,
    pointCount: number,
    boundingSphere: Cesium.BoundingSphere,
    pixelSizeRef: Ref<number>,
    classMaskRef: Ref<number>,
    upVecRef: Ref<Cesium.Cartesian3> | null,
    heightOffsetRef: Ref<number> | null,
  ) {
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
    this._destroyed       = false;
    this._cmd             = null;
    this._va              = null;
    this._sp              = null;
  }

  // PrimitiveCollection 이 매 프레임 호출
  update(frameState: any): void {
    if (!this.show || this._destroyed) return;
    if (!this._cmd) {
      // GPU 자원 생성 실패(컨텍스트 손실, VRAM 부족 등)가 여기서 그대로
      // throw되면 Cesium의 프레임 루프(Scene.render → PrimitiveCollection.update)
      // 전체를 중단시킬 수 있으므로, 이 노드 하나만 렌더링 스킵 처리하고 격리한다.
      try {
        this._initGpu(frameState.context);
      } catch (err) {
        console.error('[PointCloudPrimitive] GPU 초기화 실패, 이 노드는 렌더링에서 제외됩니다:', err);
        this._destroyed = true;
        return;
      }
    }
    frameState.commandList.push(this._cmd);
  }

  private _initGpu(context: unknown): void {
    // ── 버텍스 버퍼 생성 ─────────────────────────────────────
    const mkVBuf = (arr: ArrayBufferView) => CesiumAny.Buffer.createVertexBuffer({
      context,
      typedArray: arr,
      usage: CesiumAny.BufferUsage.STATIC_DRAW,
    });

    // B3: GPU 자원을 단계적으로 생성하고 중간 실패 시 즉시 정리
    let va: ReturnType<CesiumInternal['VertexArray']['prototype']['constructor']> | null = null;
    let sp: ReturnType<typeof CesiumAny.ShaderProgram.fromCache> | null = null;
    try {
      // ── 버텍스 배열 (VAO) ──────────────────────────────────
      //   location 0 → position3DHigh (Float32 ×3)
      //   location 1 → position3DLow  (Float32 ×3)
      //   location 2 → color          (Uint8   ×4, normalized)
      //   location 3 → classification (Uint8   ×1, 정수값)
      va = new CesiumAny.VertexArray({
        context,
        attributes: [
          {
            index:                 0,
            vertexBuffer:          mkVBuf(this._posHigh!),
            componentsPerAttribute: 3,
            componentDatatype:     Cesium.ComponentDatatype.FLOAT,
            offsetInBytes:         0,
            strideInBytes:         12,
          },
          {
            index:                 1,
            vertexBuffer:          mkVBuf(this._posLow!),
            componentsPerAttribute: 3,
            componentDatatype:     Cesium.ComponentDatatype.FLOAT,
            offsetInBytes:         0,
            strideInBytes:         12,
          },
          {
            index:                 2,
            vertexBuffer:          mkVBuf(this._colU8!),
            componentsPerAttribute: 4,
            componentDatatype:     Cesium.ComponentDatatype.UNSIGNED_BYTE,
            normalize:             true,
            offsetInBytes:         0,
            strideInBytes:         4,
          },
          {
            index:                 3,
            vertexBuffer:          mkVBuf(this._cls!),
            componentsPerAttribute: 1,
            componentDatatype:     Cesium.ComponentDatatype.UNSIGNED_BYTE,
            normalize:             false,
            offsetInBytes:         0,
            strideInBytes:         1,
          },
        ],
      });

      // ── 셰이더 ─────────────────────────────────────────────
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

      sp = CesiumAny.ShaderProgram.fromCache({
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

      // ── DrawCommand ────────────────────────────────────────
      this._va  = va;
      this._sp  = sp;
      this._cmd = new CesiumAny.DrawCommand({
        vertexArray:    va,
        primitiveType:  Cesium.PrimitiveType.POINTS,
        shaderProgram:  sp,
        renderState:    CesiumAny.RenderState.fromCache({
          depthTest: { enabled: true },
          depthMask: true,
        }),
        boundingVolume: this._boundingSphere,
        count:          this._pointCount,
        pass:           CesiumAny.Pass.OPAQUE,
        modelMatrix:    Cesium.Matrix4.IDENTITY,
        uniformMap: {
          u_pixelSize:    () => pixelSizeRef.value,
          u_classMask:    () => classMaskRef.value,
          u_upVec:        () => upVecRef ? upVecRef.value : new Cesium.Cartesian3(0, 0, 1),
          u_heightOffset: () => heightOffsetRef ? heightOffsetRef.value : 0,
        },
      });
    } catch (err) {
      // B3: 부분 생성된 GPU 자원 즉시 해제 후 상위로 전파
      try { if (va) va.destroy(); }  catch { /* ignore */ }
      try { if (sp) sp.destroy(); }  catch { /* ignore */ }
      this._destroyed = true;
      throw err;
    }

    // CPU 사이드 배열 해제 (GPU 업로드 완료)
    this._posHigh = null;
    this._posLow  = null;
    this._colU8   = null;
    this._cls     = null;
  }

  isDestroyed(): boolean { return this._destroyed; }

  destroy(): void {
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
 * fetch(HTTP Range) + LAZ 압축 해제 + 속성 추출 + proj4 변환 +
 * WGS84 Cartesian3 계산까지 전부 워커 안에서 수행되고, 메인 스레드는
 * 결과 버퍼로 GPU 프리미티브만 조립한다 (worker.ts 참고).
 */
export async function loadNode(
  url: string,
  copc: Awaited<ReturnType<typeof Copc.create>>,
  nodeInfo: Hierarchy.Node,
  pool: WorkerPool,
  srcProj: string,
  projDef: string | null,
  geoidOffset: number,
  pixelSizeRef: Ref<number>,
  classMaskRef: Ref<number>,
  zFactor = 0.3048,
  upVecRef: Ref<Cesium.Cartesian3> | null = null,
  heightOffsetRef: Ref<number> | null = null,
): Promise<NodeCacheEntry> {
  const { posHigh, posLow, colors, cls, pointCount, sphereCenter, sphereRadius, seenClasses } = await pool.run(
    { url, copc, nodeInfo, srcProj, projDef, geoidOffset, zFactor },
  );

  const boundingSphere = new Cesium.BoundingSphere(
    new Cesium.Cartesian3(sphereCenter[0], sphereCenter[1], sphereCenter[2]),
    sphereRadius,
  );

  const primitive = new PointCloudPrimitive(
    posHigh, posLow, colors, cls, pointCount, boundingSphere, pixelSizeRef, classMaskRef, upVecRef, heightOffsetRef,
  );

  return { collection: primitive, pointCount, lastUsed: Date.now(), seenClasses: new Set(seenClasses) };
}
