# ProPresenter production E2E

이 테스트는 mock이 아니라 production Workers 배포본과 실제 ProPresenter 장비를 사용합니다. Playwright는 Chromium을 내려받지 않고 설치된 Google Chrome stable을 실행합니다. 기본 테스트는 출력 명령을 보내지 않는 읽기 전용 검증입니다.

## 실행

```sh
npm run e2e:readonly
```

기본 대상은 `https://propresenter-remote.alice-data-lab.workers.dev`와 `http://172.30.1.51:1025`입니다. 다음 환경변수로 대상을 바꿀 수 있습니다.

- `PP_E2E_URL`: production URL
- `PP_E2E_API`: ProPresenter HTTP base URL
- `PP_E2E_CHROME_PATH`: Chrome 실행 파일 경로. 미지정 시 Playwright의 `chrome` 채널을 사용합니다.
- `PP_E2E_USER_DATA_DIR`: 사용자가 명시한 별도 Chrome profile 디렉터리. 일반 Chrome profile을 자동으로 열지 않습니다.
- `PP_E2E_HEADLESS=1`: headless 실행. LNA 권한을 처음 허용해야 할 때는 기본 headed 모드를 사용합니다.

Chrome Local Network Access 권한은 보안 기능이므로 테스트가 우회하지 않습니다. 새 profile에서 권한 요청이 표시되면 해당 origin의 접근을 한 번 승인하고 같은 `PP_E2E_USER_DATA_DIR`로 다시 실행하세요. 권한 승인 없이 테스트를 통과시키는 플래그는 사용하지 않습니다.

실패 산출물은 `e2e-artifacts/` 아래에 screenshot, trace/video, JSON 결과와 API/UI 비교 자료로 남습니다.

## 사람 조작 관찰

ProPresenter 본체에서 직접 조작한 결과를 기다리는 테스트는 기본 실행에서 제외됩니다.

```sh
PP_E2E_OBSERVE_TRANSITIONS=1 \
PP_E2E_OBSERVE_SCENARIO='presentation to media to presentation' \
npm run e2e:observe
```

테스트가 실행되는 동안 다음 중 하나를 사람이 수행하고, Controller와 `/remote`가 같은 canonical 상태로 수렴하는지 확인합니다: 슬라이드 변경, 프레젠테이션 경계 이동, playlist와 Library 전환, presentation/media/video input/prop layer 변경, Clear Slide 변경, arrangement 변경. 사람 조작이 없으면 테스트는 명확한 안내와 함께 skip됩니다.

## 출력 변경 테스트

라이브 출력 변경은 기본적으로 실행되지 않습니다. 별도 명령을 명시하고 이중 opt-in을 설정한 경우에만 실행됩니다.

```sh
PP_E2E_LIVE_COMMANDS=1 \
PP_E2E_ALLOW_OUTPUT_CHANGES=1 \
npm run e2e:live
```

이 테스트는 시작/종료 canonical 상태와 실제 trigger 요청 횟수를 기록하지만 원래 출력 상태를 자동 복구하지 않습니다. 예배나 방송 중에는 실행하지 말고, 실행 전후 복구 방법을 운영자가 확보한 경우에만 사용하세요.
