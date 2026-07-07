import * as Cesium from 'cesium';
import { Copc } from 'copc';
import proj4 from 'proj4';

/**
 * COPC 노드를 로드하여 PointPrimitiveCollection 반환
 * (scene에 추가하지 않음 — 호출자가 직접 추가)
 *
 * @param {string} url
 * @param {object} copc         Copc.create() 반환값
 * @param {object} nodeInfo     nodes[key]
 * @param {string} srcProj      COPC 데이터의 좌표계 EPSG 코드 (예: 'EPSG:2992')
 * @param {number} geoidOffset  지오이드 보정값 (미터)
 * @param {number} pixelSize    점 크기 (픽셀, 기본값 2)
 * @returns {{ collection, pointCount, lastUsed }}
 */
export async function loadNode(url, copc, nodeInfo, srcProj, geoidOffset, pixelSize = 2) {
  const view = await Copc.loadPointDataView(url, copc, nodeInfo);

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');

  const collection = new Cesium.PointPrimitiveCollection();

  for (let i = 0; i < view.pointCount; i++) {
    const [lon, lat] = proj4(srcProj, 'EPSG:4326', [getX(i), getY(i)]);
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, getZ(i) * 0.3048 + geoidOffset),
      pixelSize,
      color: new Cesium.Color(getR(i) / 65535, getG(i) / 65535, getB(i) / 65535, 1.0),
    });
  }

  return { collection, pointCount: view.pointCount, lastUsed: Date.now() };
}
