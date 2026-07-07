import { Copc } from 'copc';

const URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

async function main() {

  // Step 1: 헤더 + info VLR 읽기 (처음 589바이트만 Range Request)
  console.log('=== Step 1: COPC 파일 초기화 ===');
  const copc = await Copc.create(URL);

  console.log('[ 헤더 ]');
  console.log('  포인트 수:', copc.header.pointCount);
  console.log('  스케일:', copc.header.scale);
  console.log('  오프셋:', copc.header.offset);

  console.log('\n[ COPC Info VLR ]');
  console.log('  Octree 중심:', copc.info.cube.center);
  console.log('  Octree 반지름(halfsize):', copc.info.cube.halfSize);
  console.log('  루트 계층 페이지 offset:', copc.info.rootHierarchyPage.pageByteOffset);
  console.log('  루트 계층 페이지 size:', copc.info.rootHierarchyPage.pageByteSize);

  console.log('\n[ 좌표계 (WKT) ]');
  console.log(' ', copc.wkt?.slice(0, 80) + '...');


  // Step 2: 계층(Hierarchy) 읽기 — 노드 키 맵 획득
  console.log('\n=== Step 2: 계층 페이지 로드 ===');
  const { nodes } = await Copc.loadHierarchyPage(URL, copc.info.rootHierarchyPage);

  const nodeKeys = Object.keys(nodes);
  console.log('  총 노드 수:', nodeKeys.length);
  console.log('  노드 키 예시 (처음 5개):', nodeKeys.slice(0, 5));
  console.log('  루트 노드(0-0-0-0) 정보:', nodes['0-0-0-0']);


  // Step 3: 루트 노드 점 데이터 읽기
  console.log('\n=== Step 3: 루트 노드 점 데이터 로드 ===');
  const rootNode = nodes['0-0-0-0'];
  const view = await Copc.loadPointDataView(URL, copc, rootNode);

  console.log('  루트 노드 점 개수:', view.pointCount);

  // 처음 5개 점 출력
  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const getR = view.getter('Red');
  const getG = view.getter('Green');
  const getB = view.getter('Blue');
  const getIntensity = view.getter('Intensity');
  const getClassification = view.getter('Classification');

  console.log('\n  [ 처음 5개 점 ]');
  for (let i = 0; i < 5; i++) {
    console.log(`  점 ${i}: X=${getX(i).toFixed(2)}, Y=${getY(i).toFixed(2)}, Z=${getZ(i).toFixed(2)}`);
    console.log(`        R=${getR(i)}, G=${getG(i)}, B=${getB(i)}`);
    console.log(`        Intensity=${getIntensity(i)}, Classification=${getClassification(i)}`);
  }

}

main().catch(console.error);
