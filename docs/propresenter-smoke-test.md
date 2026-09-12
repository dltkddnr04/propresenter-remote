# ProPresenter 연동 smoke test

테스트 전 ProPresenter Network API를 켜고, 브라우저와 ProPresenter가 같은 LAN에 있는지 확인한다. Controller와 `/remote`를 같은 연결 정보로 연다.

1. 같은 presentation을 playlist에 두 번 추가하고 각각 다른 arrangement를 선택한다. 두 playlist item의 이름과 arrangement가 구분되어 보이는지 확인한다.
2. ProPresenter 본체에서 현재 cue를 직접 변경한다. Controller와 Remote의 current cue, presentation, slide 번호가 같은 polling 결과를 가리키는지 확인한다.
3. Remote에서 Next와 Previous를 한 번씩 누른다. 한 번의 입력마다 한 번만 실행되고, 실제 ProPresenter 상태가 화면에 반영되는지 확인한다.
4. active arrangement 내부의 cue를 Controller에서 선택한다. 선택한 arrangement의 cue 순서로 이동하는지 확인한다.
5. `presentation → media → presentation` playlist를 만들고 Next를 누른다. 앱이 다음 presentation을 미리 추측하지 않고 ProPresenter의 실제 media/item 상태를 따라가는지 확인한다.
6. 비활성 arrangement의 개별 cue를 누른다. 버튼이 disabled이고 `이 재생목록 항목을 먼저 활성화해야 개별 슬라이드를 실행할 수 있습니다.` 안내가 보이며 잘못된 generic presentation trigger가 실행되지 않는지 확인한다.
7. 명령 endpoint를 일시적으로 실패시키거나 잘못된 cue를 실행한다. command error가 보이더라도 연결 상태는 정상 polling이 계속되는 한 `연결됨`으로 유지되는지 확인한다.
8. 빠르게 여러 cue를 변경하거나 본체와 Remote를 번갈아 조작한다. 이전 polling 응답으로 최신 화면이 되돌아가지 않는지 확인한다.
9. Remote의 텍스트, 미리보기, 자동 모드를 각각 확인한다. 텍스트 모드는 current/next text, 미리보기와 자동의 이미지 화면은 current만 표시해야 한다.
10. Remote의 그룹 버튼을 누른다. 현재 presentation에 존재하는 그룹만 표시되고 해당 그룹의 첫 cue로 이동하는지 확인한다.
11. Controller에서 현재 슬라이드 따라가기를 켠다. 현재 카드가 workspace의 위쪽 약 3분의 1 지점으로 이동하고, 수동 스크롤 시 추적이 해제되는지 확인한다.
12. 연결 정보 버튼을 눌러 IP와 포트를 변경한다. 연결 모달의 오류가 session command 오류와 섞이지 않고, 새 연결에서 두 화면이 같은 상태를 표시하는지 확인한다.
13. Controller에서 다른 playlist/library presentation을 탐색한 뒤 `현재 슬라이드 따라가기`를 누른다. 실제 active playlist item으로 즉시 복귀하고, 현재 카드가 그 cue로 스크롤되는지 확인한다.
14. Library presentation을 직접 실행한다. Controller의 선택 표시와 Remote의 current/next text, 미리보기, 그룹이 실제 active presentation과 일치하는지 확인한다.
15. 같은 이름의 그룹을 두 개 만든 뒤 각 그룹을 Remote에서 누른다. 이름이 아닌 ProPresenter group index로 각각의 올바른 첫 cue가 실행되는지 확인한다.
16. Clear 또는 slide layer를 끈 상태와 media/video input/prop을 함께 켠 상태를 각각 확인한다. slide layer가 꺼진 경우 Remote가 이전 presentation slide를 출력처럼 보이지 않으며, 합성 출력인 경우에는 이를 표시하는지 확인한다.
17. Remote의 Next/Previous를 빠르게 연속 입력한다. 각 입력이 순서대로 ProPresenter에 전달되고, command HTTP 성공 직후가 아니라 실제 canonical state 갱신 후에 두 화면이 같은 cue를 표시하는지 확인한다.
