# ProPresenter Remote

Cloudflare Workers의 정적 자산으로 배포하는 간단한 ProPresenter 원격 제어 웹앱입니다.

## 목표

- 브라우저에서 ProPresenter의 원격 기능을 편리하게 사용합니다.
- Cloudflare Workers 정적 자산으로 가볍게 서빙할 수 있도록 구성합니다.
- 별도의 서버 없이 ProPresenter의 원격 API와 통신합니다.

## 현재 상태

ProPresenter의 라이브러리·재생목록과 프레젠테이션을 조회하고, 슬라이드를 원격으로 실행할 수 있는 React SPA입니다. Cloudflare Workers의 정적 자산으로 배포할 수 있도록 Vite production build 결과물인 `dist/`를 사용합니다.

## 기술 구성

- 정적 프론트엔드: React + Vite
- 서버 상태 관리: TanStack Query
- 호스팅: Cloudflare Workers Static Assets
- 제어 대상: ProPresenter Remote API

주요 화면과 기능:

- 연결 정보 입력: ProPresenter PC의 IPv4 주소와 포트 번호 입력. 포트 기본값은 `1025`입니다.
- 조작 화면: 라이브러리, 재생목록, 프레젠테이션, 슬라이드 표시 및 실행
- 라이브러리 탐색: 라이브러리 전체와 개별 라이브러리를 각각 접고 펼칠 수 있으며, 프레젠테이션을 선택해 슬라이드를 확인할 수 있습니다.
- 현재 상태: 현재 활성 재생목록과 슬라이드를 자동 선택·강조
- 슬라이드 표시: 미리보기 또는 텍스트 모드 선택
- 미리보기 해상도: `64`, `128`, `256`, `512` 선택
- 현재 슬라이드 따라가기: 활성 슬라이드를 화면 중앙으로 부드럽게 이동. 사용자가 직접 스크롤하면 자동으로 일시 해제할 수 있습니다.
- 앱 설정과 연결 정보 변경을 별도 메뉴로 제공

## 개발

Node.js와 npm이 필요합니다.

```bash
npm install
npm run dev
```

개발 서버는 Vite로 실행하며, 프로덕션 번들은 `dist/`에 생성됩니다.

검증 명령:

```bash
npm run typecheck
npm run build
```

`wrangler.toml`은 `dist/`를 정적 자산 디렉터리로 사용하고 SPA 폴백을 활성화합니다.

## 배포

이 저장소는 GitHub 푸시를 Cloudflare Workers 자동 빌드와 연결해 사용하는 것을 전제로 합니다. Cloudflare 대시보드의 빌드 설정은 다음과 같이 지정합니다.

```text
Build command: npm run build
Deploy command: npx wrangler deploy
```

또는 로컬에서 Cloudflare에 로그인한 뒤 다음 명령으로 빌드와 배포를 함께 실행할 수 있습니다.

```bash
npx wrangler login
npm run deploy
```

`npm run deploy`가 먼저 Vite 빌드를 실행한 뒤 `dist/`를 Cloudflare Workers 정적 자산으로 배포합니다.

## ProPresenter API

브라우저가 입력된 ProPresenter PC에 직접 HTTP 요청을 보냅니다.

- `GET /v1/playlists?chunked=false`: 재생목록 조회
- `GET /v1/playlist/{playlist_uuid}?chunked=false`: 재생목록 항목 조회
- `GET /v1/libraries?chunked=false`: 라이브러리 조회
- `GET /v1/library/{library_uuid}?chunked=false`: 라이브러리의 프레젠테이션 조회
- `GET /v1/presentation/{presentation_uuid}?chunked=false`: 그룹과 슬라이드 조회
- `GET /v1/presentation/{presentation_uuid}/thumbnail/{index}?quality={quality}`: 슬라이드 썸네일 조회
- `GET /v1/presentation/{presentation_uuid}/{index}/trigger`: 슬라이드 실행
- `GET /v1/library/{library_uuid}/{presentation_uuid}/{index}/trigger`: 라이브러리 프레젠테이션의 슬라이드 실행
- `GET /v1/playlist/active?chunked=false`: 현재 활성 재생목록 조회
- `GET /v1/presentation/active?chunked=false`: 현재 활성 프레젠테이션 조회
- `GET /v1/presentation/slide_index?chunked=false`: 현재 슬라이드 인덱스 조회
- `GET /v1/trigger/previous`, `GET /v1/trigger/next`: 이전·다음 슬라이드 실행

## 사용 전 확인

1. ProPresenter 설정의 Network 탭에서 API와 원격 제어 기능을 활성화합니다.
2. ProPresenter PC의 방화벽에서 지정된 API 포트의 인바운드 연결을 허용합니다.
3. 조작 기기와 ProPresenter PC가 같은 네트워크에 있는지 확인합니다.
4. Local Network Access 권한을 지원하는 최신 브라우저를 사용합니다. 예: Chrome, Edge, Opera, Firefox.

이 앱은 ProPresenter PC에 직접 요청하므로, 외부에 공개할 경우 접근 제어와 네트워크 보안을 별도로 구성해야 합니다. 브라우저와 ProPresenter 설정에 따라 CORS 또는 Local Network Access 권한 허용이 필요할 수 있습니다.
