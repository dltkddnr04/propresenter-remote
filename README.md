# ProPresenter Remote

Cloudflare Workers의 정적 자산으로 배포하는 간단한 ProPresenter 원격 제어 웹앱입니다.

## 목표

- 브라우저에서 ProPresenter의 원격 기능을 편리하게 사용합니다.
- Cloudflare Workers 정적 자산으로 가볍게 서빙할 수 있도록 구성합니다.
- 별도의 서버 없이 ProPresenter의 원격 API와 통신합니다.

## 현재 상태

이 저장소는 초기 문서화 단계입니다. 앱 구현과 배포 설정은 이후 추가할 예정입니다.

## 예상 구성

- 정적 프론트엔드: HTML, CSS, JavaScript 또는 선택한 프론트엔드 도구
- 호스팅: Cloudflare Workers Static Assets
- 제어 대상: ProPresenter Remote API

## 개발

앱 구현이 추가되면 이 문서에 로컬 개발, 환경 변수, ProPresenter 연결 설정을 업데이트합니다.

## 배포

Cloudflare Workers 배포 설정이 추가되면 Wrangler 기반 배포 명령과 필요한 설정을 이 문서에 기록합니다.

## 주의사항

ProPresenter 원격 제어를 사용하려면 ProPresenter에서 원격 제어 기능과 네트워크 접근을 먼저 활성화해야 합니다. 앱을 외부에 공개할 경우 접근 제어와 네트워크 보안을 별도로 구성해야 합니다.
