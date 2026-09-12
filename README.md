# ProPresenter Remote

Cloudflare Workers의 정적 자산으로 배포하거나, ProPresenter가 실행 중인 macOS PC에서 작은 Go reverse proxy와 함께 실행할 수 있는 ProPresenter 원격 제어 웹앱입니다.

## 목표

- 브라우저에서 ProPresenter의 원격 기능을 편리하게 사용합니다.
- Cloudflare Workers 정적 자산으로 가볍게 서빙할 수 있도록 구성합니다.
- macOS PC에서는 Worker의 최신 정적 배포본을 화면으로 전달하고, `/v1` API만 PC 내부 ProPresenter로 전달합니다.

## 현재 상태

ProPresenter의 라이브러리·재생목록과 프레젠테이션을 조회하고, 슬라이드를 원격으로 실행할 수 있는 React SPA입니다. Cloudflare Workers의 정적 자산으로 배포할 수 있도록 Vite production build 결과물인 `dist/`를 사용합니다.

## 기술 구성

- 정적 프론트엔드: React + Vite
- 서버 상태 관리: TanStack Query
- 호스팅: Cloudflare Workers Static Assets
- 제어 대상: ProPresenter Remote API
- 선택적 macOS 로컬 프록시: Go 표준 라이브러리 reverse proxy

주요 화면과 기능:

- 연결 정보 입력: ProPresenter PC의 IPv4 주소와 포트 번호 입력. 포트 기본값은 `1025`입니다.
- 조작 화면: 라이브러리, 재생목록, 프레젠테이션, 슬라이드 표시 및 실행
- 라이브러리 탐색: 라이브러리 전체와 개별 라이브러리를 각각 접고 펼칠 수 있으며, 프레젠테이션을 선택해 슬라이드를 확인할 수 있습니다.
- 현재 상태: 현재 활성 재생목록과 슬라이드를 자동 선택·강조
- 슬라이드 표시: 미리보기 또는 텍스트 모드 선택
- 미리보기 해상도: `64`, `128`, `256`, `512` 선택
- 현재 슬라이드 따라가기: 활성 슬라이드를 화면 상단 3분의 1 지점으로 부드럽게 이동하며, 다른 재생목록이나 프레젠테이션으로 넘어가도 현재 위치를 계속 추적합니다. 사용자가 직접 스크롤하면 자동으로 일시 해제할 수 있습니다.
- 모바일 리모컨: 컨트롤러 상단의 `리모컨` 버튼 또는 `/remote` 경로에서 엽니다. 상단 절반에는 현재·다음 슬라이드를, 하단 절반에는 이전·다음 대형 제어 버튼을 표시합니다.
- 리모컨 화면 모드: 텍스트, 미리보기, 자동 모드를 제공합니다. 자동 모드는 슬라이드 텍스트가 없을 때 미리보기로 전환합니다.
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
npm test
npm run build
```

### OpenAPI 계약 갱신

ProPresenter 연동의 source of truth는 저장소에 고정한 공식 OpenAPI 3.0.2 사본인 [`openapi/propresenter.openapi.json`](openapi/propresenter.openapi.json)입니다. 앱은 실행 중 외부 스펙을 내려받지 않습니다.

```bash
npm run openapi:update    # 공식 swagger.json을 내려받아 JS wrapper를 JSON으로 정규화
npm run openapi:generate  # vendor spec에서 generated declaration 재생성
npm run openapi:check     # vendor spec과 generated declaration 동기화 검사
```

생성 타입은 `src/generated/`에만 두며 직접 수정하지 않습니다. `src/propresenter-client.ts`는 transport client, `src/propresenter.ts`는 공식 응답을 앱의 canonical model로 바꾸는 adapter, `src/propresenter-session.tsx`는 Controller와 `/remote`가 함께 구독하는 session/command layer입니다. 현재 cue의 presentation ID와 cue index는 `/v1/presentation/slide_index`의 한 쌍만 사용하고, 현재·다음 출력 텍스트는 `/v1/status/slide`를 사용합니다.

`wrangler.toml`은 `dist/`를 정적 자산 디렉터리로 사용하고 SPA 폴백을 활성화합니다.

## macOS PC에서 실행

ProPresenter가 실행 중인 macOS PC에서 Go 서버를 실행하면 브라우저가 PC의 `8787` 포트에 접속하고, 서버가 다음처럼 요청을 나눕니다.

```text
브라우저 GET/HEAD /v1 또는 /v1/*  ->  http://127.0.0.1:1025 (ProPresenter)
브라우저 GET/HEAD 그 외 경로       ->  Worker URL (정적 파일 및 SPA 폴백)
```

기본 Worker URL은 `https://propresenter-remote.alice-data-lab.workers.dev/`입니다. Go 바이너리는 업데이트하지 않으며, Worker 배포 파이프라인이 Git의 최신 커밋을 빌드·배포해 최신 정적 파일을 제공하는 책임을 가집니다.

```bash
# 기본 Worker URL로 실행
open -a ".build/ProPresenter Remote.app"

# 다른 Worker로 임시 실행
".build/ProPresenter Remote.app/Contents/MacOS/ProPresenter Remote" \
  -worker-url https://remote.example.workers.dev
```

기본적으로 서버는 `0.0.0.0:8787`에서 수신하고 브라우저에서 `http://127.0.0.1:8787`을 엽니다. 같은 네트워크의 다른 기기에서는 `http://PC주소:8787`로 접속합니다. Worker HTML 응답에 표시되는 쿠키를 통해 프론트엔드가 자동으로 로컬 프록시 모드를 선택하므로, 저장된 연결 설정이 없는 브라우저도 현재 접속한 Mac의 주소와 포트 `1025`를 기본 연결 정보로 표시합니다. 실제 API 전달은 Go가 `127.0.0.1:1025`로 수행합니다.

### macOS 앱 패키징

Go가 설치된 환경에서 저장소 루트에서 실행합니다.

```bash
sh scripts/package-macos.sh
```

스크립트는 Apple Silicon(`arm64`)과 Intel(`x86_64`)을 모두 포함한 Universal 2 앱을 만들고, 최종 `.app` 번들 전체에 ad-hoc 서명을 적용합니다. 결과물은 `.build/ProPresenter Remote.app`이며, Go 바이너리와 최소 `Info.plist`, 코드 서명 메타데이터만 포함합니다. `node_modules/`, `dist/`, `git` 및 Worker 정적 파일은 앱 번들에 포함하지 않습니다. Finder에서 앱을 열면 메뉴 막대에 `PR`이 표시됩니다. `PR`을 클릭하면 휴대폰용 QR 코드와 접속 URL이 열립니다. 같은 Wi-Fi의 휴대폰으로 QR을 스캔하거나 표시된 `http://Mac-IP:8787` 주소를 열면 됩니다. 메뉴에서 브라우저를 열거나 Worker URL을 바꿀 수 있으며, 바꾼 URL은 `~/Library/Application Support/ProPresenter Remote/config.json`에 저장되어 다음 실행부터 사용됩니다.

다른 Mac으로 복사했거나 다운로드한 앱에서 Gatekeeper가 계속 열기를 막는 경우, 신뢰할 수 있는 앱인지 확인한 뒤 Finder에서 앱을 우클릭하고 `열기`를 선택해 실행할 수 있습니다. 그래도 막히면 앱 경로에 맞춰 다음처럼 quarantine 속성을 제거해야 할 수 있습니다.

```bash
xattr -dr com.apple.quarantine "/path/to/ProPresenter Remote.app"
```

이 패키징은 개발·개인 배포를 위한 ad-hoc 서명만 제공하며, Developer ID 서명과 공증(notarization)은 별도 비목표입니다.

사용 가능한 주요 플래그:

| 플래그 | 기본값 | 설명 |
| --- | --- | --- |
| `-worker-url` | 기본 Worker URL | Worker 절대 URL; 환경변수와 저장된 설정보다 우선 |
| `-propresenter-url` | `http://127.0.0.1:1025` | ProPresenter API 절대 URL |
| `-listen` | `0.0.0.0:8787` | Go 서버 수신 주소 |
| `-open` | `true` | 시작 시 macOS 기본 브라우저 열기; 실패해도 서버는 계속 실행 |
| `-read-timeout` | `15s` | HTTP 서버 읽기 타임아웃 |
| `-write-timeout` | `15s` | HTTP 서버 쓰기 타임아웃 |

Worker URL 우선순위는 `-worker-url` > `PROPPRESENTER_WORKER_URL` > 메뉴에서 저장한 URL > 기본 URL입니다. 메뉴에서 바꾼 URL은 실행 중인 서버에는 적용되지 않으므로, 저장 후 메뉴의 `종료`를 누르고 앱을 다시 열면 됩니다.

QR 접속은 PC와 휴대폰이 같은 네트워크에 있고 macOS 방화벽에서 `8787` 인바운드 연결이 허용될 때 동작합니다. ProPresenter의 로컬 API 포트 `1025`는 외부에 직접 노출하지 않는 구성을 권장합니다. 이 Go 서버에는 인증 시스템이 없으므로 신뢰할 수 있는 LAN/VPN에서만 사용하고, Worker 및 네트워크 방화벽·접근 제어 정책을 별도로 구성하세요.

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

macOS 로컬 프록시 모드에서는 브라우저가 동일 출처의 `/v1`로 요청하고 Go 서버가 기본적으로 `http://127.0.0.1:1025`로 전달합니다. Cloudflare Worker를 직접 사용하는 기존 모드에서는 브라우저가 저장된 ProPresenter PC 주소로 직접 요청합니다.

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
3. 직접 연결 모드라면 조작 기기와 ProPresenter PC가 같은 네트워크에 있는지 확인합니다.
4. 직접 연결 모드에서 브라우저가 요청하는 로컬 네트워크 접근 권한을 허용합니다. macOS 로컬 프록시 모드에서는 브라우저가 Go 서버와 동일 출처로 통신하므로 이 권한 확인을 건너뜁니다.

앱은 실행 시 브라우저의 Local Network Access 지원 여부를 자동으로 확인하며, 지원되지 않는 환경에서는 별도의 호환성 안내 화면을 표시합니다.

Cloudflare Worker 직접 연결 모드에서는 외부에 공개할 경우 접근 제어와 네트워크 보안을 별도로 구성해야 합니다. macOS 로컬 프록시 모드 역시 인증 시스템을 제공하지 않으므로 `8787` 포트를 신뢰할 수 있는 네트워크에만 열고, 필요한 경우 방화벽·VPN·Worker 접근 제어를 사용하세요. 브라우저와 ProPresenter 설정에 따라 직접 연결 모드에서는 CORS 또는 Local Network Access 권한 허용이 필요할 수 있습니다.
