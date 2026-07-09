import * as Cesium from 'cesium';
import type { BoundingSphere, Camera, Scene, CullingVolume } from 'cesium';
import proj4 from 'proj4';

// B-4: distanceToDepth — BFS+SSE LoD로 교체되어 미사용, 삭제

/** VoxelKey(D-X-Y-Z)에서 깊이(D) 추출 */
export function getDepth(key: string): number {
  return parseInt(key.split('-')[0]);
}

/**
 * 노드 키의 8개 자식 키 반환
 * D-X-Y-Z → (D+1)-(2X+dx)-(2Y+dy)-(2Z+dz), dx/dy/dz ∈ {0,1}
 */
export function getChildKeys(key: string): string[] {
  const [d, x, y, z] = key.split('-').map(Number);
  const nd = d + 1, nx = x * 2, ny = y * 2, nz = z * 2;
  return [
    `${nd}-${nx  }-${ny  }-${nz  }`,
    `${nd}-${nx+1}-${ny  }-${nz  }`,
    `${nd}-${nx  }-${ny+1}-${nz  }`,
    `${nd}-${nx+1}-${ny+1}-${nz  }`,
    `${nd}-${nx  }-${ny  }-${nz+1}`,
    `${nd}-${nx+1}-${ny  }-${nz+1}`,
    `${nd}-${nx  }-${ny+1}-${nz+1}`,
    `${nd}-${nx+1}-${ny+1}-${nz+1}`,
  ];
}

/**
 * 노드 BoundingSphere의 화면상 픽셀 크기 (Screen Space Error)
 *
 * SSE = (radius / dist) × (screenHeight / (2 × tan(fovY / 2)))
 *
 * SSE가 클수록 화면에서 크게 보임 → 자식 노드로 세분화가 필요함.
 * SSE > sseThreshold 이면 자식 확장, 이하이면 현재 노드를 리프로 사용.
 */
export function screenSpaceError(sphere: BoundingSphere, camera: Camera, scene: Scene): number {
  const dist = Cesium.Cartesian3.distance(camera.position, sphere.center);
  // 카메라가 구 안에 있으면 항상 확장
  if (dist < sphere.radius) return Infinity;

  const h    = scene.canvas.clientHeight;
  // PerspectiveFrustum은 fovy를 가짐; 없으면 60° 기본값
  const fovY = (camera.frustum as any).fovy ?? Cesium.Math.toRadians(60);
  return (sphere.radius / dist) * (h / (2 * Math.tan(fovY / 2)));
}

/**
 * COPC Octree 노드의 BoundingSphere 계산
 */
export function getNodeBoundingSphere(
  key: string,
  rootCenter: { x: number; y: number; z: number },
  rootHalfSize: number,
  srcProj: string,
  geoidOffset: number,
  zFactor = 0.3048,
  xyFactor = zFactor,
): BoundingSphere {
  const [level, xi, yi, zi] = key.split('-').map(Number);
  const nodeHalfSize = rootHalfSize / Math.pow(2, level);

  const cx = rootCenter.x - rootHalfSize + (2 * xi + 1) * nodeHalfSize;
  const cy = rootCenter.y - rootHalfSize + (2 * yi + 1) * nodeHalfSize;
  const cz = rootCenter.z - rootHalfSize + (2 * zi + 1) * nodeHalfSize;

  const [lon, lat] = proj4(srcProj, 'EPSG:4326', [cx, cy]);
  if (!isFinite(lon) || !isFinite(lat)) {
    throw new Error(
      `getNodeBoundingSphere: proj4 변환 실패 (key=${key}, srcProj=${srcProj}). ` +
      `projDef가 올바른지 확인하세요.`
    );
  }
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, cz * zFactor + geoidOffset);
  const radius = nodeHalfSize * xyFactor * Math.sqrt(3);

  return new Cesium.BoundingSphere(center, radius);
}

/** 현재 카메라의 CullingVolume 반환 */
export function getCullingVolume(camera: Camera): CullingVolume {
  return camera.frustum.computeCullingVolume(
    camera.position,
    camera.direction,
    camera.up
  );
}

/** BoundingSphere가 CullingVolume 안에 있는지 판정 */
export function isInFrustum(sphere: BoundingSphere, cullingVolume: CullingVolume): boolean {
  return cullingVolume.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
}
