이미지 1: 과제 선정 사유 및 COPC

기존 방식 (문제점)

원본 LAS/LAZ 는 보관용으로 따로 저장
웹 가시화를 위해 Potree·3D Tiles 로 별도 타일링
동일 데이터를 이중으로 보관 → 저장 비용 2배
원본 갱신 시 타일 전체 재생성 필요
수만 개의 조각 파일로 배포·관리 부담

COPC 방식 (개선)

단일 파일 하나로 원본 보관 + 스트리밍
LAZ 1.4 규격과 완전 호환 (원본 그대로)
필요한 영역·해상도만 부분 요청
정적 스토리지(S3 등)만 있으면 서비스 가능
별도 타일 서버·전처리 파이프라인 불필요

정의
Point Cloud 데이터를 클라우드 환경에서 효율적으로 저장·스트리밍·시각화할 수 있도록 설계된 공개 데이터 포맷

핵심 특징

Octree 기반 정렬 저장 : 파일 내부가 Octree 구조로 정렬되어 저장.
LoD(Level Of Detail)로 계층화 되어 렌더링 최적화
기존 LAZ(LAZ 1.4) 규격과 완전 호환 (원본 그대로)
특정 영역, 필요한 해상도의 데이터 청크(Chunk) 단위 요청 지원

파일 레이아웃

LAS 1.4 Header — 표준 헤더
COPC VLR (info) — 루트 노드 offset/size, 중심 간격
Hierarchy VLR / EVLR — 노드 트리 페이지 (key → offset,size,count)
Point Data Chunks — 노드 단위 LAZ 압축 청크
EVLRs — WKT 좌표계 등

Octree / LoD 계층

Level 0 — 루트 노드 (전체 영역, 성긴 밀도)
Level 1 (8분할, 밀도 ↑)
Level 2 (가시 영역만 선택 요청)
Level n ... (카메라 근접 시 고밀도)
각 노드 = HTTP Range 요청 1건
이미지 2: 기존 COPC 가시화 사례 및 COPC 변환 방법

Potree — github.com/potree/potree
WebGL 기반 오픈소스 포인트클라우드 렌더러.
예시: https://apps.dslab.digitalscholar.rochester.edu/potree/examples/copc.html

Eptium Viewer — eptium.com
COPC 파일 URL 만으로 즉시 웹 가시화.

copc.js — github.com/connormanning/copc.js
COPC 읽기·파싱용 TypeScript 라이브러리.

예제 데이터

USGS 3DEP / OpenTopography — 대용량 공개 LiDAR (https://portal.opentopography.org/dataCatalog)
AWS Open Data — 이미 EPT/COPC 로 공개된 데이터셋(예: https://registry.opendata.aws/canelevation-pointcloud/)
copc.io 예제 파일 — autzen-classified.copc.laz (https://github.com/PDAL/data/blob/main/autzen/autzen-classified.copc.laz)

LAS / LAZ → COPC 변환

$ untwine --files=input.laz \
    --output_dir=out --single_file
$ pdal translate in.las out.copc.laz \
    --writers.copc.forward=all

QGIS 3.26 이상에서도 COPC 내보내기가 가능.

이미지 3: 개발과제 및 유의사항

개발과제

사전 변환 없이 : 3D Tiles 등 별도 타일링 없이 COPC 파일 URL 만으로 가시화
Cesium Native : 다른 Cesium 레이어와 함께 동일 씬에서 자연스럽게 동작
스트리밍 렌더링 : 카메라 이동에 따라 필요한 노드만 점진적으로 로딩
재사용 가능한 형태 : npm 패키지 수준의 API 제공

권장 구조

Data Layer — COPC Reader — VLR/Hierarchy 파싱, HTTP Range 요청, LAZ 디코딩 (Web Worker 에서 수행)
Cache & Scheduler — 노드 캐시, 요청 우선순위 큐, 취소/폐기 정책 (메인 스레드)
Render Layer — Cesium PointPrimitiveCollection / Primitive + 커스텀 셰이더 (GPU 버퍼 업로드)
이미지 4: 고려 사항 및 예상 결과물

고려 사항

파싱과 렌더링 분리 : LAZ 디코딩은 Web Worker 에서. 메인 스레드에서 돌리면 카메라 조작이 되지 않음
LoD·Culling : 기준 레벨 진입. 포인트 버킷 관리. 카메라 이동에 따른 LoD 전환과 Frustum Culling
HTTP Range 요청 : 노드별 offset·length 부분 요청, 인접 요청 병합, 동시 요청 제한과 AbortController 취소. CORS·Accept-Ranges 확인
좌표계 변환 : WKT VLR 의 원본 CRS → ECEF 재투영. 국내는 EPSG:5186 등 중부원점. 포인트별 변환 대신 노드 상대좌표 + ModelMatrix
스타일링 API : RGB / Intensity / Classification / Elevation 색상 코드, 분류 필터. 재다운로드 없이 GPU 속성만 갱신되도록

예상 결과물

기본 : COPC 파일 URL 로드 -> Cesium 씬에 표시
동작 : 카메라 이동에 따른 LoD 전환과 Frustum Culling
성능 : 수 GB 급 데이터에서 끊김 없는 인터랙션, 메모리 상한 관리
활용성 : 간결한 API, 옵션 문서, 가능한 데모 페이지
완성도 : 스타일링 옵션, 좌표계 자동 처리, 오픈소스 라이선스 및 README