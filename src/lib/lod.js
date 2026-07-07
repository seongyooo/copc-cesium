import * as Cesium from 'cesium';
import proj4 from 'proj4';

/**
 * 카메라 고도(m)를 Octree 깊이로 변환 (로그 스케일)
 * @param {number} height  카메라 고도 (미터)
 * @param {number} maxDepth  데이터의 최대 깊이
 */
export function heightToDepth(height, maxDepth) {
  const HIGH = 8000;
  const LOW  = 150;
  if (height >= HIGH) return 0;
  if (height <= LOW)  return maxDepth;
  const t = Math.log(height / LOW) / Math.log(HIGH / LOW);
  return Math.round((1 - t) * maxDepth);
}

/** VoxelKey(D-X-Y-Z)에서 깊이(D) 추출 */
export function getDepth(key) {
  return parseInt(key.split('-')[0]);
}

/**
 * COPC Octree 노드의 BoundingSphere 계산
 * @param {string} key          VoxelKey (D-X-Y-Z)
 * @param {{x,y,z}} rootCenter  루트 노드 중심 (COPC 좌표계)
 * @param {number} rootHalfSize 루트 노드 절반 크기 (COPC 좌표계)
 * @param {string} srcProj      COPC 데이터의 좌표계 EPSG 코드 (예: 'EPSG:2992')
 * @param {number} geoidOffset  지오이드 보정값 (미터)
 */
export function getNodeBoundingSphere(key, rootCenter, rootHalfSize, srcProj, geoidOffset) {
  const [level, xi, yi, zi] = key.split('-').map(Number);
  const nodeHalfSize = rootHalfSize / Math.pow(2, level);

  const cx = rootCenter.x - rootHalfSize + (2 * xi + 1) * nodeHalfSize;
  const cy = rootCenter.y - rootHalfSize + (2 * yi + 1) * nodeHalfSize;
  const cz = rootCenter.z - rootHalfSize + (2 * zi + 1) * nodeHalfSize;

  const [lon, lat] = proj4(srcProj, 'EPSG:4326', [cx, cy]);
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, cz * 0.3048 + geoidOffset);
  const radius = nodeHalfSize * 0.3048 * Math.sqrt(3);

  return new Cesium.BoundingSphere(center, radius);
}

/** 현재 카메라의 CullingVolume 반환 */
export function getCullingVolume(camera) {
  return camera.frustum.computeCullingVolume(
    camera.position,
    camera.direction,
    camera.up
  );
}

/** BoundingSphere가 CullingVolume 안에 있는지 판정 */
export function isInFrustum(sphere, cullingVolume) {
  return cullingVolume.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
}
