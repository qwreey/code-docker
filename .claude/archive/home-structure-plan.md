# 홈 디렉터리(/code) 정리 + user-init 실행 시점 계획 (구현 완료)

**구현 완료.** 아래 "결정 완료" 절에서 이어지는 내용대로 문제 1·2·3을 한
커밋으로 묶어 반영함 — `$UMBRELLA=/code/.local/share/code-docker/` 신설,
`user-init`을 `entrypoint.sh`에서 supervisord 시작 전 동기 호출 +
`set -e`로 이전, `code-server` → `code` supervisord 프로그램 이름 통일.
현재 상태는 루트 `CLAUDE.md`의 "Process model" 절 참고 — 이 문서는 판단
과정 기록용으로 남겨둠.

## 배경

컨테이너 안 `$HOME`(`/code`)에 code-docker 각 서비스가 각자 `.tailscale`,
`.vector`, `.webmanager`, `.caddy-adapter`, `.server`, `.local`, `.installed`
를 흩뿌려두고 있어서 지저분함. 실수로 지울 위험(뭔지 몰라서 "별거 아닌가
보다" 하고 지우는 사람 발생 가능)도 있음. 별개지만 연결된 문제로,
`user-init`(홈 폴더 마이그레이션 담당)이 지금 실행되는 위치/실패 처리 방식이
안전하지 않다는 지적도 나옴 — 새 마이그레이션 로직을 얹기 전에 먼저 고쳐야
할 전제조건.

지금은 dev 브랜치만 있고 main엔 아직 webmanager조차 안 나가서 `.server`
하나뿐인 상태 — 실사용자 영향이 없어서 이런 구조 결정을 내리기 가장 싼
시점이라는 점도 있음.

## 지금 상태 (실태 조사)

`$HOME`(`/code`) 바로 밑에 생기는 것들:

| 경로 | 만드는 곳 | 내용물 | 비고 |
|---|---|---|---|
| `.server` | `code-service.default.sh` (`mkdir -p /code/.server`, `TARGET=/code/.server`로 `code-server-autoinstall/install.sh`·`start.sh` 호출) | code-server-autoinstall 설치본 전체 + code-docker가 얹은 `config.yaml`, `patch/*`(`code-patch.default.sh`), `patch/tailscale/status.json`(`tailscale-status.default.sh`) | 이미 소유권이 섞여있음. **단, `.server`라는 위치 자체는 code-docker가 `TARGET` 환경변수로 넘기는 값일 뿐 — 서브모듈이 강제하지 않음**(아래 "검토한 안" 정정 참고). 반면 그 *안쪽* 구조(`config.yaml`, `patch/`, `user-data/`, `extensions/`, `code-server/`, `bin/`이 `TARGET` 바로 밑 직속이어야 하는 것)는 `code-server-autoinstall/start.sh`·`install.sh`에 하드코딩돼있어 진짜로 강제됨 |
| `.tailscale` | `tailscale-service.default.sh`(`state/`), `tailscale-forward.default.sh`(`config.yaml`) | tailscaled 상태, forwards/publish 설정 | |
| `.vector` | `vector-service.default.sh` | `state/`, `logs/*.jsonl`(webmanager Logs 탭이 직접 읽음) | |
| `.webmanager` | webmanager 백엔드 (`config.go`의 `WEBMANAGER_*_PATH` 기본값들) | 각종 JSON 설정/캐시 파일 | |
| `.caddy-adapter` | `caddy-adapter.default.sh` | `Caddyfile`, `managed/`, `custom/` | |
| `.local` | `entrypoint.sh`(`mkdir -p /code/.local`), mise(`code-runner.default.sh`의 `$HOME/.local/bin/mise`) | supervisord 자체 로그(`supervisord.log`), mise 설치 위치 | code-docker 소유가 아니라 mise 등 서드파티 도구가 원래 쓰는 XDG 관례 경로 |
| `.installed` | `user-init.default.sh` | 첫 부팅 여부 + 버전 마커(`CURR_VERSION=1`) | |

`entrypoint.sh`는 XDG 런타임 디렉토리(`/run/xdg`)와 `/code/.local`만 만들고
바로 `exec supervisord`. `user-init`은 `entrypoint.sh`가 아니라
`code-service.default.sh` 맨 위(`install.sh`보다 먼저)에서 실행됨. 그런데
`supervisord.default.conf`엔 `code-server`, `sshd`, `tailscaled`,
`tailscale-forward`, `tailscale-status`, `webmanager`, `nginx`,
`caddy-adapter` 총 8개 프로그램이 전부 `priority=100`으로 동시에 뜨고, 이
중 `code-server` 하나만 내부적으로 `user-init`을 거쳐감. 나머지 7개는
`user-init` 완료를 전혀 기다리지 않고 각자 자기 상태 디렉토리를
`mkdir -p`함. 게다가 `user-init.default.sh`와 `code-service.default.sh`
둘 다 `set -e`가 없어서, 지금 `user-init`이 실패해도 조용히 다음 단계로
넘어감.

## 문제 1: 홈 디렉터리 정리

### 정정 — `.server`는 서브모듈이 강제하는 위치가 아님

1차 초안에서 "`.server`는 서브모듈의 TARGET이라 위치를 못 옮긴다"고 썼는데
틀림 — `code-server-autoinstall/install.sh`·`start.sh`를 직접 보면
`SPATH`가 `TARGET` 환경변수를 그냥 그대로 받아쓸 뿐(`if [ ! -z "$TARGET" ];
then SPATH="$TARGET"`), 그 값이 `/code/.server`여야 한다는 강제는 어디에도
없음. `TARGET=/code/.server`는 `code-service.default.sh`·
`code-runner.default.sh`가 정한 code-docker 자신의 선택일 뿐이라 다른
경로로 얼마든지 바꿀 수 있음 — 사용자 지적이 맞음.

단, `.server`(=`$TARGET`) *안쪽*의 모양은 다름: `start.sh`가
`--config "$SPATH/config.yaml"`, `$SPATH/patch/*`(윈도우 아이콘 패치 등),
`--user-data-dir="$SPATH/user-data"`, `--extensions-dir="$SPATH/extensions"`
를 전부 `$SPATH` 바로 밑 직속으로 하드코딩해서 찾음 — 이 내부 레이아웃은
진짜로 서브모듈이 강제함. 즉 **바깥 이름(`.server`라는 디렉토리 이름과
위치)은 자유, 안쪽 구조(`config.yaml`/`patch/`/`user-data/`/`extensions/`가
그 디렉토리 바로 밑에 있어야 하는 것)는 고정**이라는 게 정확한 그림.

### 검토한 안

- **(사용자 안 A) 하나의 umbrella 밑에 점(.) 떼고 몰아넣기**: 이제 `.server`
  위치가 자유롭다는 게 확인됐으니 이 안이 그대로 성립함 — `server/`도
  다른 서비스 상태 디렉토리들과 나란히 umbrella 밑에 넣을 수 있음.
- **(사용자 안 B-1) `~/.config/code-docker/...`처럼 XDG `.config` 밑에
  얹기**: Steam처럼 "플랫폼이 설치/데이터/캐시를 전부 자기 이름 밑
  하나로 묶어 관리"하는 실무 관례는 확실히 흔하지만, Steam 자신은 실제로
  `~/.config/Steam`이 아니라 `~/.local/share/Steam`(XDG_DATA_HOME) 밑에
  게임 설치본·셰이더 캐시를 둠 — `.config`는 XDG 스펙상 "작은 텍스트
  설정 파일" 전용이고, 여기 들어갈 것들(vector의 여러 날짜치 JSONL
  로그, code-server 설치본 수백MB, webmanager 캐시, 터미널 PTY 세션
  상태)은 성격상 `.config`의 계약과 안 맞음. "하나의 소유 영역으로 묶는다"는
  방향 자체엔 동의하지만, 그 영역을 `.config` 안에 두는 것보다는 별도
  최상위 디렉토리로 두는 쪽이 Steam이 실제로 하는 것과도, XDG 스펙과도 더
  맞음.
- **(사용자 안 B-2) 전면 XDG 분산(`~/.config`+`~/.local/share`+
  `~/.local/state`+`~/.cache`로 종류별 분리)**: 리눅스 표준에는 가장
  가깝지만 실효가 작음 — 지금 모든 서비스가 이미 `--config`/`--state=`
  같은 명시적 인자로 자기 경로를 code-docker 스크립트로부터 직접
  받고 있어서(`vector --config`, `tailscaled --state=`, `caddy run
  --config`, webmanager의 `WEBMANAGER_*_PATH` 등) XDG 환경변수 기반
  자동탐색의 이점을 아무도 못 씀. 하위 디렉토리마다 config/data/state/cache
  중 뭔지 판단해야 하는 작업량 대비 정리 효과도 작음.
- ~~(1차 추천, 안 C) 최상위 `/code/.code-docker/` 신설~~: 기각. `/etc/code-docker`와의
  대칭성은 그럴듯해 보였지만, 결국 `$HOME`에 code-docker만 아는 비표준
  독자 닷폴더를 새로 하나 더 만드는 것일 뿐 — 이미 있는 표준 위치를 쓰는
  안 D보다 나을 이유가 없음.
- **(최종 추천, 안 D) `$HOME/.local/share/code-docker/` 신설**: `.local`은
  이미 이 컨테이너 `$HOME`에 존재하고(entrypoint.sh가 만듦), 이미 표준
  XDG 경로 관례로 쓰이는 중(mise가 `$HOME/.local/bin`에 설치됨) — 새
  닷폴더를 발명하는 대신 이미 있는 표준 위치 밑에 `code-docker`라는 이름
  하나만 더 붙이는 것. Steam이 실제로 하는 것(`~/.local/share/Steam`)과
  정확히 같은 패턴이기도 함. 그 밑에 점 없이 `code/`(=새 `TARGET`, 내부
  구조는 위 정정대로 그대로 유지 — 이름은 아래 "문제 3" 참고),
  `tailscale/`, `vector/`, `webmanager/`, `caddy-adapter/`,
  `migration-version`(아래 참고)을 모음.
  `.local` 자체의 나머지 부분(`bin/`, mise 등)은 그대로 — code-docker
  소유가 아니라 서드파티 도구가 원래 쓰는 자리라 손댈 이유 없음.

### 마이그레이션 난이도

각 서비스 스크립트가 자기 상태 디렉토리를 직접 `mkdir -p`하는 구조라, 경로
상수만 바꾸면 코드 변경 자체는 작음. 실사용자가 없는 dev 단계라 "구경로
있으면 옮기고, 없으면 그냥 새로 만든다" 수준으로 충분하지만, 향후 실사용자
대비 차원에서 버전 마킹 기반 마이그레이션 스켈레톤(아래 문제 2에서 다룰
`user-init`의 `CURR_VERSION` 메커니즘) 위에 얹는 걸 추천.

`.vector/logs/*.jsonl`는 애초에 영속을 보장하는 대상이 아님(rotate되는
운영 로그, webmanager의 "vector JSONL 로그 보존 정책" 자체가 아직 TODO —
`webmanager/CLAUDE.md`) — 옮기면서 예전 파일을 이관할 필요 없이 새 경로에서
그냥 새로 쌓기 시작하면 됨. 마이그레이션 로직이 신경 써야 할 건 실제
상태(`tailscale`의 로그인 세션, `webmanager`의 설정/캐시 JSON,
`caddy-adapter`의 `managed/`·`custom/`, `code`(구 `.server`)의 설치본)뿐.

### 버전 마커: `.installed` → `migration-version`

지금 `/code/.installed`는 원래 "첫 부팅 여부"만 나타내는 단순 존재-플래그로
`touch`만 하던 이름이라, 지금처럼 실제 버전 숫자(`CURR_VERSION`)를 담고
여러 마이그레이션(fish 첫 설정 + 이번 디렉토리 이관)을 총괄하는 역할로
커지면 이름이 안 맞음. 새 umbrella 밑
`$HOME/.local/share/code-docker/migration-version`을 새 정본 위치로 확정
(umbrella 바로 밑, 하위 폴더로 더 감싸지 않음).

읽기만 하고 예전 파일을 그대로 남겨두면 안 됨 — 그러면 정리하겠다는
`.installed` 자체가 정리 안 된 채로 영원히 `$HOME`에 남는 모순이 생김.
그래서 **읽는 게 아니라 `mv`로 이관**: `migration-version`이 아직 없고
`/code/.installed`가 있으면(=업그레이드 중인 기존 컨테이너)
`mkdir -p $HOME/.local/share/code-docker && mv /code/.installed
$HOME/.local/share/code-docker/migration-version`으로 파일 자체를 옮기고,
그 위에서 필요하면 버전 숫자를 새 베이스라인으로 덮어씀(이번 마이그레이션
자체도 완료된 걸로 표시해야 하므로). 새 컨테이너는 처음부터
`migration-version`만 생기고 `.installed`는 아예 만들어지지 않음.

## 문제 2: user-init 실행 시점 + 실패 처리

사용자 진단에 전적으로 동의. 위 실태 조사에서 확인했듯:

1. **레이스 컨디션이 실재함** — `user-init`은 8개 supervisord 프로그램 중
   `code-server` 하나에만 종속돼있고 나머지 7개는 기다리지 않음. 새
   디렉토리 이관 로직을 `user-init`에 넣어도, `tailscaled`/`vector`/
   `caddy-adapter`/`webmanager`가 먼저(또는 동시에) 구경로에
   `mkdir -p`해버리면 마이그레이션이 꼬일 수 있음.
2. **실패해도 안 죽음** — `user-init.default.sh`, `code-service.default.sh`
   둘 다 `set -e` 없음. 지금 구조에서 `user-init` 중간에 명령이 실패해도
   스크립트는 계속 진행 → 절반만 마이그레이션된 상태로 나머지 서비스가
   뜨는, 사용자가 우려한 "데이터가 섞이는" 상황이 실제로 가능함.

### 제안

1. `script/user-init.sh` 디스패처 신설 — 다른 서비스들(`code-service.sh`,
   `tailscale-service.sh` 등)과 동일한
   `override 있으면 override, 없으면 default` 패턴. 지금 `user-init`은 이
   표준 패턴을 안 쓰고 `code-service.default.sh` 안에서 직접 override 파일
   존재를 체크하는 임시방편 구조임 — 이번 기회에 정규화.
2. `user-init.default.sh` 최상단에 `set -e` 추가.
3. `entrypoint.sh`에서 `exec supervisord` 전에 `script/user-init.sh`를
   **동기 호출**(exec 아님, 끝나고 다음 줄로 진행해야 하므로). 실패하면
   `entrypoint.sh` 자체의 기존 `set -e`에 의해 컨테이너가 즉시 죽음 →
   docker의 restart policy로 계속 재시도되며 로그에 에러가 남는, 사용자가
   원한 "sleep으로 숨기지 않고 죽는" 동작과 일치.
4. `code-service.default.sh`에서 지금의 `user-init` 호출 블록 제거(1번으로
   대체됨).

### 부작용 체크

- 사용자가 명시한 "userinit은 빨라야 한다" 제약: 지금 로직(fish
  `qs_setup`, 첫 부팅 1회)은 빠르고, 새로 얹을 디렉토리 이관도 조건부
  `mv` 몇 개 수준이라 이 제약을 유지하는 데 문제 없음. 다만 향후 훨씬
  무거운 마이그레이션이 붙게 되면 부팅 지연이 생길 수 있음 — 그때 가서
  "무거운 건 각 서비스 자체의 지연 마이그레이션으로 분리"를 재검토할 문제,
  지금은 해당 없음.
- `entrypoint.sh`의 동기 호출 구간은 아직 vector 파이프라인이 뜨기 전이라
  `user-init`의 출력은 `docker compose logs`에서 라벨 없는 원본으로만
  보임(지금 vector 뜨기 전 짧은 구간도 마찬가지라 새로 생기는 문제는
  아님).

## 문제 3: 네이밍 일관성 — `code-server` → `code`

`config/`의 다른 override 대상들은 전부 `code-service`, `code-env`,
`code-patch`, `code-runner`, `code-config`처럼 `code-` 접두사를 씀
(`code-server-`가 아님). 그런데 supervisord 프로그램 이름과
`.server`(=`TARGET`)만 `code-server`/`.server` 식으로 다른 컨벤션을
씀 — webmanager 쪽도 이미 확장 관리 등에서 "code-server"가 아니라 "code"로
지칭하는 곳이 있어(사용자 지적) 이름이 어긋나 있음. `.server`를
`code-docker/code/`로 옮기는 김에 supervisord 프로그램 이름도
`code-server` → `code`로 맞추는 걸 같이 하는 게 일관성상 낫다고 봄.

실제 코드를 grep해서 확인한 변경 대상(예상대로 작음):

- `Dockerfile:52` — `RUN mkdir -p /var/log/code-server ...` → `/var/log/code`
- `config/supervisord.default.conf` — `[program:code-server]` → `[program:code]`
  (`stdout_logfile=/var/log/%(program_name)s/...`는 `%(program_name)s`
  치환이라 자동으로 따라옴, 손댈 필요 없음)
- `bin/restart` — `supervisorctl restart code-server` → `restart code`
- `webmanager/backend/handlers_restartstatus.go:24` — `p.Name ==
  "code-server"` → `p.Name == "code"` (유일한 하드코딩 비교 지점 —
  webmanager 프론트엔드엔 하드코딩 없음, grep으로 확인)
- `config/vector.default.toml`은 **손댈 필요 없음** — `app_name`을
  로그 경로의 두 번째-마지막 세그먼트(`split!(.file, "/")`)로 자동
  유도하므로 프로그램 이름이 바뀌면 태그도 자동으로 따라감. 주석 하나가
  예시로 `/var/log/code-server/...`를 들고 있는 것만 지나가며 고치면 됨.
- 문서: 루트 `CLAUDE.md`("restart command ... supervisorctl restart
  code-server"), `docs/index.md`, `docs/webmanager.md`,
  `docs/code-server-patch.md`, `webmanager/CLAUDE.md` — 전부 텍스트
  갱신만 필요, 로직 없음.
- `webmanager/.claude/archive/vector-logs-plan-done.md`는 완료된 과거
  기록이라 **건드리지 않음**(archive 문서는 당시 사실을 남기는 용도).

grep 결과 코드 쪽 실질 변경 지점은 4곳(Dockerfile, supervisord.conf,
bin/restart, handlers_restartstatus.go)뿐이라 사용자 예상대로 큰
엔지니어링은 아님. 다만 이번 홈 디렉터리 정리와는 성격이 다른 변경(런타임
디렉토리 이름이 아니라 supervisord 프로세스/API 이름)이라, 같은 PR에
묶을지 별도로 나눌지는 아래 "확인 필요" 참고.

**참고 — `$HOME=/code`와는 별개의 이야기임.** 컨테이너 `$HOME`이 `/code`인
이유는 이 문제 3과 무관한 예전 결정: 터미널 프롬프트/타이핑 공간을 적게
차지하는 짧은 이름을 원했고, "코드 편집 툴"이라는 개념으로 `code`를 택한
것. `/root`가 컨테이너 안에 존재하긴 하지만, 컨테이너 안의 root는 호스트의
superuser가 아니라 그 컨테이너 안에서만 유효한 권한이라 — `authorized_keys`
류를 놓는 관례처럼 "신뢰되는 공간"이라는 통상적 함의를 의도적으로
깨기 위해 `$HOME`을 `/root`가 아닌 `/code`로 비표준으로 잡은 것. 이번
프로그램 이름(`code-server`→`code`) 논의와는 완전히 독립적인 결정이라 같이
묶어 재검토할 이유는 없음. 그리고 `code-docker/code/`가 `.local/share/`
밑에 묻혀서 이용자가 직접 볼 일이 거의 없는 내부 구현 디테일이 된 이상,
`$HOME` 자체의 이름(`/code`)과 그 안 깊숙한 곳의 `code/` 서브폴더가 같은
단어를 쓴다는 것도 실질적으로 문제 될 게 없음(이전처럼 `$HOME` 최상위에
드러나 있던 `.server`였다면 얘기가 달랐겠지만, 지금은 아님).

## 실행 순서 제안 (착수 시)

1. 문제 2(실행 위치 이전 + `set -e`) 먼저 — 문제 1의 안전한 전제조건이기도
   함(레이스 없이 돌아야 디렉토리 이관도 안전).
2. 문제 3(`code-server` → `code` 프로그램 이름 변경) — 문제 1에서 `TARGET`을
   `.../code-docker/code`로 옮기는 것과 이름 결정이 맞물리므로 이 시점에
   같이 확정.
3. 서비스 스크립트별 경로 변경 + `migration-version` 도입(신규 경로 없으면
   레거시 `.installed` 폴백) + 이관 로직(구경로 있으면 `mv`, 없으면 새로
   생성) 추가.
4. 문서 갱신 — 루트 `CLAUDE.md`의 "Process model" 절, `docs/index.md`,
   `docs/webmanager.md`, `docs/code-server-patch.md`,
   `webmanager/CLAUDE.md` 등 홈 디렉터리 구조·`code-server` 프로그램 이름을
   언급하는 곳.

## 결정 완료

- 문제 1·2·3은 **한 커밋(또는 한 PR)으로 묶어서 배포**하기로 확정. 이유:
  중간 지점을 checkout하면(PR/커밋이 나뉜 상태에서) 마이그레이션 로직이
  일부 경로만 아는 반쪽짜리 상태로 실행될 수 있어 오히려 실패 케이스를
  늘림 — 하나로 묶어 배포하는 쪽이 실패 가능성을 줄임. 착수 완료, 아래는
  실제 반영 결과.

## 참고

- 관련 코드: `script/entrypoint.sh`, `config/code-service.default.sh`,
  `config/code-runner.default.sh`, `config/user-init.default.sh`,
  `config/supervisord.default.conf`, `config/vector-service.default.sh`,
  `config/tailscale-service.default.sh`, `config/tailscale-forward.default.sh`,
  `config/caddy-adapter.default.sh`, `webmanager/backend/config.go`,
  `code-server-autoinstall/install.sh`, `code-server-autoinstall/start.sh`
  (`TARGET`/`SPATH` 처리 — `.server` 위치가 강제되지 않는다는 근거),
  `Dockerfile`(`/var/log/code-server` 생성 줄), `bin/restart`,
  `webmanager/backend/handlers_restartstatus.go`,
  `config/vector.default.toml`(문제 3 — 자동 유도라 손댈 필요 없음을 확인한
  근거).
