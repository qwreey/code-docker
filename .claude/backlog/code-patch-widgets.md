# code-patch 위젯 컴포넌트 아이디어 (구현 전, 브레인스토밍)

`window.CDDialog`(`config/code-patch/cd-dialog.default.js`)를 만들면서 확인한 패턴 - 상태를 `/code/.server/patch/<feature>/status.json` 같은 파일에 기록해두고, 브라우저 패치가 그걸 폴링해서 그려주는 방식 - 을 다른 곳에도 재사용할 수 있을지 아이디어만 정리한 문서. 구현 순서나 착수 여부는 아직 정하지 않음.

## 이미 있는 것

- **`window.CDDialog`**: `banner(id, opts)`(키로 갱신되는 고정 카드), `hide(id)`, `toast(opts)`(자동 소멸), `notify(opts)`(권한 있을 때만 OS 알림) - 4개 메서드로 구성된 최소 알림 프리미티브. 스타일은 `.cd-dialog-stack`/`.cd-dialog-card` 클래스, 우측 상단 고정.
- **사용 예시**: `tailscale-notify.default.js` - `tailscale-status.default.sh` 가 2초마다 쓰는 `status.json` 을 폴링해서 로그인 필요/완료 상태를 `CDDialog` 로 표시.

이 구조(백엔드 supervisord 프로그램이 `status.json` 을 씀 → `code-patch/*.default.js` 가 폴링 → `CDDialog` 로 렌더링)를 "상태 기반 위젯" 의 표준 패턴으로 삼아도 될 것 같음.

## 공통 기반 컴포넌트 후보

구체적 위젯들이 대부분 이 위에서 조합될 수 있을 것 같은 것들. `CDDialog` 와 같은 파일(`cd-dialog.default.js`)에 추가하거나, 필요해지면 `cd-widgets.default.js` 정도로 분리.

- **`CDBadge`**: 상태 점(●)/알약 모양 라벨. `ok`/`warn`/`error`/`idle` 같은 kind 로 색만 정함. `CDDialog.banner` 의 title 옆이나 상태줄에 붙일 용도.
- **`CDKeyValue`**: `{label, value}[]` 를 정렬된 표로 그려주는 헬퍼. IP/포트/hostname 같은 정보를 나열할 때(`forwards`/`publish` 항목별 상태 등) 지금처럼 매번 `lines: [...]` 문자열 배열로 뭉개지 않고 라벨-값을 구분해서 보여줄 수 있음.
- **`CDProgress`**: 퍼센트 또는 indeterminate 스피너. code-server 재설치, dind 이미지 pull 등 시간이 걸리는 작업 표시용.
- **`CDConfirm(opts): Promise<boolean>`**: `CDDialog.banner` 를 재사용하되 Yes/No 버튼을 누를 때까지 기다리는 Promise 기반 확인창. 지금 카드들은 전부 "보여주기"만 하고 결과를 스크립트에 돌려주지 않는데, 이건 결과가 필요한 액션(아래 `CDQuickActions` 등)에 필요함.

## 구체적 위젯 아이디어

### CDStatusBar - 상시 상태 표시줄

우측 상단 카드 스택과 별개로, 화면 한쪽에 작은 상시 상태 아이콘 행을 하나 둠 (VS Code 자체 상태 표시줄과 비슷한 느낌이지만 우리가 그리는 별도 오버레이). `tailscaled`, `code-docker-dind`, mise 등 "항상 있는지 없는지가 궁금한" 것들을 아이콘 하나로 보여주고, 클릭하면 `CDDialog.banner` 로 자세한 내용을 펼침. 지금의 tailscale 배너처럼 "문제 있을 때만 툭 튀어나오는" 방식과 달리, 평소엔 조용히 있다가 문제가 생기면 아이콘 색만 바뀌는 쪽이 덜 거슬릴 수 있음.

- 데이터 소스 후보: `tailscale/status.json`(있음), `dind/status.json`(신규 - dind 데몬 reachable 여부를 code-server 쪽에서 주기적으로 `docker info` 해서 기록), mise 쪽은 서버 정보가 필요해서 좀 더 고민 필요.

### CDQuickActions - bin/ 커맨드 GUI 래퍼

`restart`, `forward-reload` 같은 `bin/` 커맨드는 지금 터미널에 직접 타이핑해야 함. 우측 상단 어딘가에 작은 버튼 몇 개(재시작, forward 재적용 등)를 두고 누르면 실행되게 하고 싶은데, **브라우저 JS 는 서버 명령을 직접 실행할 수 없다는 게 문제** - 이건 지금 이 문서가 다루는 "그리기" 영역을 벗어나서, 실행을 맡아줄 작은 로컬 HTTP 엔드포인트가 하나 필요함 (예: `webmanager` 가 이미 만들어지고 있으니 그쪽에 붙이는 게 제일 자연스러워 보임 - 이 위젯은 webmanager 의 존재를 전제로 하는 아이디어임, 별도 서버 없이는 보류).
- `CDConfirm` 으로 "정말 재시작?" 확인 후 실행, 실행 중엔 `CDProgress`, 끝나면 `CDDialog.toast` 로 결과 표시 - 하는 조합이 자연스러울 것 같음.

### CDUpdateNotice - code-server/도구 업데이트 알림

`code-server-autoinstall/install.sh` 가 이미 새 버전 체크(rate-limited)를 하고 있으니, 체크 결과를 status.json 스타일로 하나 남겨두면 "새 code-server 버전이 있습니다, `restart` 로 반영하세요" 정도의 배너를 띄울 수 있음. mise 쪽도 `mise outdated` 같은 걸 주기적으로 돌려서 비슷하게 알려줄 수 있을 듯 (다만 이건 유저 도구 버전이라 "그냥 알려주기만" 하는 게 나을지, 아니면 아예 안 건드리는 게 나을지는 취향 문제라 별도 판단 필요).

### CDForwardsPanel - tailscale forwards/publish 항목별 상태

지금 `tailscale/status.json` 은 로그인 상태만 담고 있는데, `forwards`/`publish` 항목별로 (몇 명 붙어있는지, 마지막 연결이 언제였는지 등) `tailscale-status.default.sh` 가 좀 더 기록해주면, `config.yaml` 의 각 항목을 `CDKeyValue` 로 나열하는 패널을 만들 수 있음. "adb forward 살아있나?" 같은 걸 확인하려고 터미널 열 필요 없이 code-server 화면에서 바로 보임.

### CDResourceMeter - 디스크/도커 리소스

`/code` 디스크 사용량, `code-docker-dind` 에 쌓인 이미지/컨테이너 개수 같은 걸 주기적으로 기록해서 작은 미터로 보여주는 아이디어. 개인 프로젝트 특성상 급한 건 아니지만, dind 볼륨이 계속 쌓이는 걸 까먹고 안 지우다가 디스크가 꽉 차는 상황을 미리 알려줄 수 있음.

## 데이터 소스 확장 아이디어

지금은 `tailscale-status.default.sh` 하나가 `tailscale/status.json` 하나를 씀. 위 아이디어들을 실제로 만들려면 비슷한 "상태 기록자" supervisord 프로그램이 기능별로 하나씩 더 필요해질 수 있음 (`tailscale-status.default.sh` 를 만들 때 그랬듯, 폴링 대상 프로그램과 상태 기록 책임을 분리하는 편이 나음 - `tailscale-forward`/`tailscale-status` 분리했던 이유와 동일). 각 상태 파일은 `/code/.server/patch/<feature>/status.json` 형태로 두면 패치 스크립트 쪽에서 fetch 경로가 일관됨.

## 우선순위 (제안)

1. **`CDConfirm`** - 다른 여러 아이디어(특히 `CDQuickActions`)의 전제 조건이라 먼저 있으면 좋음. 순수 프론트엔드 컴포넌트라 서버 쪽 변경이 전혀 필요 없어서 착수 비용이 제일 낮음.
2. **`CDBadge`/`CDKeyValue`** - 역시 순수 프론트엔드, 지금 tailscale 배너의 `lines: [...]` 를 정리하는 데도 바로 쓸 수 있음.
3. **`CDStatusBar`** - dind 상태 기록만 추가하면(`docker info` 주기적 확인) 바로 시도해볼 수 있는 다음 단계.
4. **`CDQuickActions`/`CDUpdateNotice`/`CDForwardsPanel`/`CDResourceMeter`** - webmanager 진행 상황이나 각 기능의 실제 필요성에 따라 후순위.
