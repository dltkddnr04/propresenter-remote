# ProPresenter Remote

Cloudflare Workers의 정적 자산으로 배포하는 간단한 ProPresenter 원격 제어 웹앱입니다.

## 목표

- 브라우저에서 ProPresenter의 원격 기능을 편리하게 사용합니다.
- Cloudflare Workers 정적 자산으로 가볍게 서빙할 수 있도록 구성합니다.
- 별도의 서버 없이 ProPresenter의 원격 API와 통신합니다.

## 현재 상태

현재 Cloudflare Workers 정적 자산으로 서빙할 수 있는 최소 웹앱 골격이 구성되어 있습니다. ProPresenter 원격 제어 화면과 API 연동은 이후 추가할 예정입니다.

## 예상 구성

- 정적 프론트엔드: `public/` 디렉터리의 HTML, CSS, JavaScript
- 호스팅: Cloudflare Workers Static Assets
- 제어 대상: ProPresenter Remote API

## 개발

Node.js와 Wrangler가 필요합니다.

```bash
npm install
npm run dev
```

기본 정적 자산은 `public/`에 추가합니다. `wrangler.toml`은 `/public`을 자산 디렉터리로 사용하고, 클라이언트 라우팅을 위해 SPA 폴백을 활성화합니다.

## 배포

Cloudflare에 로그인한 뒤 다음 명령으로 배포합니다.

```bash
npx wrangler login
npm run deploy
```

## 주의사항

ProPresenter 원격 제어를 사용하려면 ProPresenter에서 원격 제어 기능과 네트워크 접근을 먼저 활성화해야 합니다. 앱을 외부에 공개할 경우 접근 제어와 네트워크 보안을 별도로 구성해야 합니다.
