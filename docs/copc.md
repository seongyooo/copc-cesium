가이아쓰리디
COPC 데이터의 CesiumJS 가시화 기술 개발
지정과제
가이아쓰리디 로고
가이아쓰리디
공식 홈페이지
공간정보기술과 지구과학기술 분야의 소프트웨어 전문기업입니다. 위성·지형·도시 데이터를 3D로 시각화하는 디지털트윈 플랫폼 mago3D를 자체 개발해 국방·기상·교통·우주위성 등 다양한 분야에 솔루션을 제공합니다. mago3D Tiler 등 핵심 기술을 오픈소스로 공개하며 개방과 협력의 가치를 실천하고 있습니다.

"무거운 3D 공간 데이터를 복잡한 변환 없이 웹 지도에 바로 띄워라!"

개발 미션

3D 스캐너나 드론으로 촬영한 방대한 '3D 점군 데이터(Point Cloud)'를 웹 브라우저 기반의 3D 지구본(CesiumJS)에 빠르고 부드럽게 띄우는 연결 도구(가시화 라이브러리)를 개발하는 과제입니다.

무엇이 달라지나요?

기존 방식
무거운 3D 데이터를 웹에 올리기 위해, 데이터를 화면에 맞게 잘게 쪼개는 복잡하고 오래 걸리는 사전 변환 작업(타일링)이 필수였습니다.

새로운 목표
유튜브 영상을 스트리밍하듯 필요한 부분만 불러오는 최적화 포맷(COPC)을 활용하여, 별도의 변환 과정 없이 원본 파일 그대로 웹에 즉시 띄울 수 있습니다.

비유하자면?
규격이 다른 해외용 가전제품(COPC 데이터)을 한국용 콘센트(CesiumJS 웹 지도)에 사용할 때, 복잡한 전기 공사를 하는 대신 꽂기만 하면 바로 작동하는 '스마트 돼지코 어댑터'를 발명하는 것과 같습니다!

기술 소개
COPC(Cloud Optimized Point Cloud)는 Point Cloud 데이터를 클라우드 환경에서 효율적으로 저장, 스트리밍, 시각화할 수 있도록 설계된 공개 데이터 포맷
내부 Octree 기반 구조로 정렬되어 저장되며, LoD로 계층화
특정 영역, 필요 해상도의 데이터 청크 요청으로 빠르게 서비스 가능
원본 보관용과 시각화를 위한 이중 생성 없이 단일 파일로 원본 데이터 보관 및 시각화 서비스 가능
COPC 가시화
COPC Typescript 라이브러리 등을 활용한 데이터 로딩
Cesium.JS 상에서 사전 타일링 포맷 변환 없이 가시화 서비스
Potree의 COPC Viewer와 eptium.com의 Viewer 상의 COPC 가시화와 유사한 가시화 서비스
개발과제 예시
Cesium.JS 기반의 COPC 가시화 라이브러리 혹은 플러그인 개발

CoG(Cloud Optimized GeoTIFF) Cesium.JS 가시화 라이브러리인 TIFFImageProvider와 유사한 가시화 라이브러리 개발
참고자료
https://copc.io/ : Cloud Optimized Point Cloud Specification - 1.0
https://copc.io/software.html : COPC 지원 오픈소스 및 상용 Software 현황
https://github.com/connormanning/copc.js : A TypeScript library for reading and parsing COPC data.
https://github.com/potree/potree : Free open-source WebGL based point cloud renderer
https://github.com/hongfaqiu/TIFFImageryProvider : Load GeoTIFF/COG(Cloud optimized GeoTIFF) on Cesium
기술정보 문의처
기술이사 박선동

sdpark@gaia3d.com
수상작 혜택
수상작 선정수

1개 팀

상금

300만원

추가 혜택

선정팀 입사 지원 시 우대

