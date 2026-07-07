import * as Cesium from 'cesium';
import { Copc } from 'copc';

/**
 * COPC 노드를 로드하여 PointPrimitiveCollection을 반환합니다.
 *
 * 역할 분리:
 *   메인 스레드 - Copc.loadPointDataView() (fetch + LAZ 파싱) → raw 배열 추출
 *   Worker      - proj4 변환 + WGS84 Cartesian3 계산
 *   메인 스레드 - PointPrimitiveCollection 생성 (WebGL 필요)
 *
 * @param {string}     url
 * @param {object}     copc        Copc.create() 반환값
 * @param {object}     nodeInfo    nodes[key]
 * @param {WorkerPool} pool        WorkerPool 인스턴스
 * @param {string}     srcProj     COPC 데이터의 좌표계 EPSG 코드
 * @param {string}     projDef     srcProj의 proj4 정의 문자열
 * @param {number}     geoidOffset 지오이드 보정값 (미터)
 * @param {number}     [pixelSize=2]
 */
export async function loadNode(url, copc, nodeInfo, pool, srcProj, projDef, geoidOffset, pixelSize = 2) {
  // 메인 스레드: fetch + LAZ 파싱 (copc.js / laz-perf.wasm)
  const view  = await Copc.loadPointDataView(url, copc, nodeInfo);
  const n     = view.pointCount;

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');

  // raw 배열 추출 후 Worker로 전송 (Transferable)
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  const rs = new Float32Array(n);
  const gs = new Float32Array(n);
  const bs = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    xs[i] = getX(i);  ys[i] = getY(i);  zs[i] = getZ(i);
    rs[i] = getR(i);  gs[i] = getG(i);  bs[i] = getB(i);
  }

  // Worker: proj4 변환 + WGS84 계산
  const { positions, colors, pointCount } = await pool.run(
    { xs, ys, zs, rs, gs, bs, pointCount: n, srcProj, projDef, geoidOffset },
    [xs.buffer, ys.buffer, zs.buffer, rs.buffer, gs.buffer, bs.buffer],
  );

  // 메인 스레드: Cesium primitive 생성 (WebGL 컨텍스트 필요)
  // rAF 청크로 나눠 추가해 메인 스레드 블로킹 방지.
  // scratch 객체 재사용으로 GC 압박 최소화 (collection.add 내부에서 값 복사).
  const collection    = new Cesium.PointPrimitiveCollection();
  const scratchPos    = new Cesium.Cartesian3();
  const scratchColor  = new Cesium.Color();
  const CHUNK         = 3000;

  for (let start = 0; start < pointCount; start += CHUNK) {
    const end = Math.min(start + CHUNK, pointCount);
    for (let i = start; i < end; i++) {
      scratchPos.x        = positions[i * 3];
      scratchPos.y        = positions[i * 3 + 1];
      scratchPos.z        = positions[i * 3 + 2];
      scratchColor.red    = colors[i * 4];
      scratchColor.green  = colors[i * 4 + 1];
      scratchColor.blue   = colors[i * 4 + 2];
      scratchColor.alpha  = 1.0;
      collection.add({ position: scratchPos, pixelSize, color: scratchColor });
    }
    // 마지막 청크가 아니면 다음 프레임으로 양보
    if (end < pointCount) {
      await new Promise(r => requestAnimationFrame(r));
    }
  }

  return { collection, pointCount, lastUsed: Date.now() };
}
