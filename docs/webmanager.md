# webmanager (관리자 패널)

80번 포트의 code-server 와 같은 origin, `/manager` 경로에 브라우저 관리자 패널이 함께 떠
있습니다 (Go 백엔드 + React 프론트엔드, `webmanager/` 폴더에서 개발됩니다) — 컨테이너 안
nginx가 `/manager`를 webmanager로 라우팅해줍니다(자세한 라우팅 규칙은
[build-customization.md](build-customization.md#nginxconf-단일-origin-라우팅-설정) 참고).
구현된 기능:

### Supervisor

supervisord 프로그램 목록 조회 및 start/stop/restart, 표준출력/표준에러 로그 확인.
프로그램별로 특정 컨트롤을 비활성화(설명 노트와 함께)할 수 있는 메타데이터 지원
([`supervisor-metadata.*.yaml`](build-customization.md#supervisor-metadatayaml-supervisor-탭-메타데이터) 참고 — `vector`는 기본적으로 로그
보기가 꺼져 있습니다), 프로그램의 PID를 루트로 한 자식 프로세스 트리 펼쳐보기

### SSH Keys

컨테이너로 들어오는/나가는 SSH 연결 전반을 다룹니다(git 전용이 아님 — 일반
ssh/scp 접속에도 그대로 적용). `/code/.ssh/authorized_keys` 목록 조회/추가/삭제,
기본 SSH 키(`~/.ssh/id_ed25519` — 별도 `Host` 설정이 없는 서버에 접속할 때 SSH가
자동으로 쓰는 키, 없으면 생성 버튼 노출 + 퍼블릭 키 복사), 호스트별 전용 SSH 키
(`~/.ssh/config`, ed25519 자동 생성), `~/.ssh/known_hosts` 관리, `~/.ssh/config`
원본 직접 편집(`ProxyJump`/`Port`/`Host *` 등 구조화 폼이 못 다루는 설정용, 저장 전
`ssh -G`로 문법 검증) — 이 원본 편집은 내용 자체가 민감할 수 있어 **읽기까지**
비밀번호 잠금이 걸립니다(다른 대부분의 읽기 전용 API와 다른 지점).

### Git Config

`/code/.gitconfig` 의 user.name/email, 커밋 사이닝(SSH 키 또는 GPG, GPG 키
자체 생성/조회/삭제 포함), HTTPS credential store (`~/.git-credentials`, 평문
저장), `git lfs install` 실행, `.gitconfig` 원본 직접 편집(저장 전 문법 검증)

### Dev Proxy

`router` 컨테이너 안 `caddy-adapter`가 관리하는 `.caddy` 항목(expose) 조회/추가/삭제 —
이 탭 자체는 router의 `/router/` 페이지를 iframe으로 그대로 embed한 것입니다
(`ROUTER_MANAGER_HOSTS`가 비어 있으면 기본값인 같은 origin의 `/router/`를, 설정돼
있으면 그 전용 도메인을 cross-origin으로 embed — webmanager는 이제
`@code-docker/router-frontend`를 빌드 의존성으로 갖지 않습니다. 자세한 내용은
[router.md](router.md#보안-공유-origin과-전용-도메인) 참고). 이름(내부
식별자, 파일명 + Caddyfile matcher 토큰으로만 쓰임)과 host(실제로 노출할 전체 도메인,
예: `dev.example.com`이나 `*.staging.example.com`)로 먼저 expose를 만들고, 그 아래에
라우트(매치 path, target `host:port`, strip prefix, 리버스프록시 path, `route`/`handle`
매칭 방식, 라우트별 인증 요구)를 원하는 만큼 추가하는 구조화 폼입니다. 공유 base
도메인은 없으므로 expose마다 완전히 다른 도메인을 쓸 수 있습니다. 목록에는 host, 라우트
수, 인증 요구 여부(전체 라우트가 요구하면 "요구", 일부만이면 "부분", 없으면 "없음")가
표시되고, 행을 펼치면 그 expose의 라우트 목록이 같은 화면 아래에 나타납니다(다이얼로그
아님) — 라우트 추가/편집만 별도 다이얼로그로 열립니다. 저장 시 `caddy adapt`로 검증 후
`caddy reload`로 무중단 반영합니다(검증 실패 시 반영 없이 에러만 표시). 폼이 못 다루는
케이스는 같은 화면에서 `.caddy` 파일 자체를 원본 편집할 수 있습니다(간단한 텍스트 영역 —
webmanager의 다른 곳에서 쓰는 CodeMirror 에디터는 아닙니다). 자세한 내용은
[dev 서버 노출 문서](dev-proxy.md)를 확인하세요.

### App Routes

Dev Proxy와 같은 위치(`router` 컨테이너 안 `caddy-adapter`)에서 관리되는, Host
헤더와 무관한 경로 기반(`/app/<이름>/...`) 리버스 프록시 항목 조회/추가/삭제 —
이 탭도 Dev Proxy와 같은 방식(router의 `/router/` 페이지를 iframe으로 embed)으로
보여줍니다. Dev Proxy와 달리 host 필드가 없고 이름과
target(`host:port`) 두 값만으로 앱 하나를 등록합니다 — 경로 모양이
`/app/<이름>/*` 하나로 고정이라 path/strip prefix/매칭 방식 같은 필드 자체가
없습니다. 최초 부팅 시 `code → code-docker:80` 앱이 자동 생성되고, 지우거나
바꾸면 다시 생성되지 않습니다. 자세한 내용은 [app-routes.md](app-routes.md)를
확인하세요.

### Tailscale

Dev Proxy와 같은 방식(router의 `/router/` 페이지를 iframe으로 embed)으로,
tailscale의 전역 설정(SOCKS 주소/재시도 간격)·forwards·publish 추가/삭제와
로그인 시작/취소, 상태(내 정보/피어 목록) 조회를 이 탭에서 전부 할 수 있습니다.
tailscale 데몬 자체는 router 컨테이너에서 돌고, webmanager는 router-manager API를
호출할 뿐입니다. 자세한 내용은 [router.md](router.md#tailscale)를 확인하세요.

### DNS

Dev Proxy/Tailscale과 같은 방식(router의 `/router/` 페이지를 iframe으로 embed)으로,
router 컨테이너의 dnsmasq가 쓰는 DNS 콘텐츠 블록리스트·MagicDNS 스타일 커스텀
호스트(호스트이름→실제 IP)·리졸버(`auto`: 컨테이너 자체 `/etc/resolv.conf` 사용,
`custom`: 고정 업스트림 목록)를 관리합니다. 블록리스트는 소스별(hosts 형식 파일
하나당 하나)로 커스텀 소스 추가/삭제가 가능하고, 기본 내장 소스(builtin)는 이미지가
갱신될 때 해시 비교로 업데이트 여부(추가/삭제된 호스트 diff 샘플 포함)를 보여주고
반영(pull)하거나 무시(ignore)할 수 있습니다. `dig` 스타일 DNS 조회 도구도 이 탭에
포함되어 있습니다. 자세한 내용은 [router.md](router.md)와
[egress-netgate.md](egress-netgate.md)를 확인하세요.

### Net 관리

Dev Proxy/Tailscale과 같은 방식(iframe embed)으로, netgate의 아웃바운드 CIDR
allow/block 규칙(순서 있는 first-match-wins 목록)과 인바운드 포트포워딩 항목을
조회/추가/삭제/순서변경합니다. 변경 사항은 파일에 저장되는 즉시(별도 재시작 없이)
router의 `netgate-firewall` 프로그램이 30초 주기로 다시 읽어 반영합니다. 자세한
내용은 [egress-netgate.md](egress-netgate.md)를 확인하세요.

### tinyauth

Dev Proxy/Tailscale과 같은 방식(iframe embed)으로, Dev Proxy/App Routes 개별
라우트의 "인증 요구"를 처리하는 tinyauth의 로그인 사용자 목록을 조회/추가/삭제하고
비밀번호를 변경합니다(`TINYAUTH_AUTH_USERS` 환경변수로 인프라 차원에서 고정한
경우 읽기 전용 안내로 대체됩니다). 사용자 추가/삭제/비밀번호 변경 시 router의
`tinyauth` 프로그램이 자동으로 재시작되어 바로 반영됩니다. 자세한 내용은
[router.md](router.md#tinyauth)를 확인하세요.

### Logs

프로그램별 구조화 로그를 앱/레벨/시간 범위(존재하는 로그 기준으로 자동
clamp됨)로 필터링해서 조회, 커서 기반 페이지네이션, 실시간 새로고침(신규 항목 누적)
(아래 [구조화 로그(vector)](#구조화-로그-vector) 참고) — 로그에 시크릿이 노출될 수 있어 이 탭 전체가 비밀번호
게이트 대상입니다([비밀번호 게이트](webmanager-config.md#비밀번호-게이트) 참고)

### Task Manager

(구 "Processes") "성능"/"프로세스" 두 서브탭. 성능 탭은 호스트 전체
기준 코어별 CPU 사용률 히트맵, 메모리 구성요소별(캐시/버퍼/사용/여유) 분해(cgroup
제한과 호스트 물리 총량을 나란히), 가능하면 클럭/온도, 최근 10분 히스토리 그래프.
프로세스 탭은 리스트/트리 뷰 전환, 상태 필터, 이름/커맨드 퍼지 검색(일치 부분
강조), 페이지네이션, 리스닝 포트별 점유 프로세스 조회/종료(SIGTERM/SIGKILL) —
`btop`을 안 열어도 다 됩니다

### Claude Code

설치 여부 감지 및 설치 버튼(mise로 최신 버전 설치), 브라우저 안에서 바로 진행하는
로그인 흐름(`claude auth login`을 백그라운드로 실행해 로그인 URL을 추출하고
사용자가 붙여넣는 코드를 그대로 전달), mise로 관리 중인 버전이 최신인지 확인해서
업데이트하는 버튼과 확인 끄기 옵션(기기 상관없이 서버에 저장), 사용 통계(총 세션/
오늘·이번 주/최장 세션, 월간 히트맵, 주간 그래프, 모델별 토큰 사용량), 설치된
Skills/Plugins 목록, 이 인스턴스에서 진행된 대화 세션 로그 뷰어(`CLAUDE_CONFIG_DIR/projects/*/*.jsonl`의
목록/축약 채팅뷰 — 이 서브탭만 Terminal/Files/Logs와 동급으로 비밀번호 게이트
대상)

### Code Extensions

[`recommendations.*.yaml`](build-customization.md#recommendationsyaml-추천-목록)이 담은 추천 code-server
익스텐션 목록을 카테고리별로 접었다 펼치며 보고 설치, 이미 설치된 익스텐션 전체
목록(기본 접힘, 삭제 가능), 추천 목록 표시 여부 토글(기기별 저장) — 설치/삭제
직후엔 mise 탭과 같은 "지금 재시작" 배너가 뜹니다

### Projects

`$HOME/Projects`(`user-init`이 매 부팅마다 없으면 자동으로 만듭니다) 아래
프로젝트별 용량, `node_modules`/`target` 등
재생성 가능한 폴더 브레이크다운, 오래된 프로젝트 표시, 최근 편집순 정렬, 프로젝트별
mise 사용 도구 목록, code-server로 바로 열기(같은 origin이면 자동으로 알아내고,
`WEBMANAGER_CODE_SERVER_URL`을 설정하면 그 값을 우선함), 재생성 가능한 폴더
단위 삭제(확인 다이얼로그 필수)와 프로젝트 폴더 자체의 완전 삭제(비밀번호 게이트,
프로젝트 이름을 직접 입력해야 하는 확인 다이얼로그), 프로젝트별 git 상태 패널
(staged/changed/untracked/behind/ahead/diverged/stashed/conflicts 요약, 커밋
로그/diff/리모트/브랜치/태그 조회 — 읽기 전용, 게이트 없음)

### mise

추천 도구 목록을 카테고리별로 접었다 펼치며(기본 접힘) 보고 설치
(`mise use -g`), 전역으로 설치된 도구 목록/삭제(설정에서만 제거하고 바이너리는
남겨두는 비활성화/재활성화 토글 포함), 환경변수 미리보기(`mise env`), 도구
검색(`mise registry --json`)과 원격 버전 목록(`mise ls-remote --json`) 조회 후
설치 — 전역 도구를 바꾼 뒤 code-server에 반영하려면 재시작이 필요한데, 설치/삭제
직후 이 탭(과 Code Extensions/Claude Code 탭)에 뜨는 "지금 재시작" 배너로 바로
할 수 있고, 탭을 이동했다 돌아와도 재시작 필요 여부가 계속 표시됩니다

### Terminal

브라우저에서 바로 여는 쉘(xterm.js + WebSocket) — code-server 자체가
죽었을 때의 최소 복구 수단이자, code-server 세션과 무관하게 dev 서버를 잠깐 띄워두는
용도. 이름 붙은 영속 세션을 여러 개 열어두고 탭으로 전환할 수 있고(이름 변경도
가능), 유휴 상태로 일정 시간 방치되면 자동 정리됩니다(고정한 세션은 예외). 항상 열려
있는 홈 탭에서 시작 위치/실행 명령을 저장하는 프로파일을 만들어두고 거기서 새
세션을 바로 시작할 수 있습니다(카드형 목록, 드래그앤드롭 순서 변경). 모바일에서도
쓸 수 있게 Esc/Ctrl/Alt/Shift/Tab/방향키 온스크린 버튼(커스터마이징 가능)과 색상
테마(프리셋 10개 + 사용자 정의) 지원

### Files

`/code` 아래(설정으로 넓힐 수 있음) 파일시스템을 code-server가 지금 열어둔
프로젝트 폴더에 국한되지 않고 브라우징 — 업로드/다운로드/삭제/이동/복사/이름변경/폴더
생성/멀티선택, 텍스트 파일은 바로 편집(CodeMirror), 권한/생성·수정 시각 정보 패널

### Docker/dind 관리

[Docker in Docker](tips/dind.md) 안의 컨테이너/이미지 목록과 로그 조회(비게이트),
시작/정지/삭제(전부 확인 다이얼로그 필수 + 비밀번호 게이트 대상), `docker inspect`
상세 조회(마찬가지로 게이트 — `Config.Env`에 평문 시크릿이 노출될 수 있어 목록/로그
조회와 달리 잠급니다)

### Sessions (열린 세션)

어느 code-server 브라우저 탭이 현재 연결되어 있고 어느 폴더를 열어뒀는지 보여줍니다.
브라우저가 자체 발급한 UUID로 30초마다 heartbeat를 보내는 방식으로 동작하며
(code-server가 `auth: none`이라 별도 인증 토큰을 붙일 수 없어 heartbeat 전송
자체는 게이트하지 않습니다), 목록 조회는 Terminal/Files/Logs와 동급으로 탭
전체가 비밀번호 게이트 대상입니다.

---

git-lfs 는 `config/build/build.default.sh`에 포함되어 기본으로 설치됩니다(패키지 설치만 —
저장소별 `git lfs install`은 위 Git Config 탭에서 직접 실행).

## 비밀번호 게이트

webmanager는 자체 비밀번호 게이트를 지원합니다(선택 사항, 기본은 꺼짐) — 원칙은
**조회(읽기)는 그대로 열어두고, 변경(쓰기)만 게이트**이며, Terminal/파일 탭/Logs/
Sessions/Supervisor의 프로그램별 로그 조회, Claude Code 탭 안의 대화 세션 로그
서브탭은 조회까지 통째로 게이트됩니다. 켜는 방법
(해시 생성, `WEBMANAGER_AUTH_PASSWORD_HASH` 설정)과 전체 동작 방식은
[webmanager-config.md#비밀번호-게이트](webmanager-config.md#비밀번호-게이트)를
확인하세요.

## 구조화 로그 (vector)

각 supervisord program의 표준출력은 이제 `/var/log/<프로그램명>/stdout.log` 로 실제 파일에
회전(rotate)되어 남으며, [vector](https://vector.dev)가 이 파일들을 tail 하여
`[프로그램명] ...` 형태로 라벨링해서 컨테이너 stdout으로 다시 흘려보냅니다 — 따라서
`docker compose logs` 로도 이제 어느 program의 로그인지 구분됩니다([`vector.*.toml`](build-customization.md#vectortoml-vector-로그-파이프라인-설정)
참고). webmanager의 로그 뷰어(Logs 페이지)도 vector가 함께 쓰는 구조화 로그
(`/code/.local/share/code-docker/vector/logs/*.jsonl`)를 읽어 실제 데이터를 보여줍니다(이전엔 목업 데이터였습니다).

## 보안: 자체 로그인 없음

> **주의: webmanager 는 자체 로그인 화면이 없습니다.** code-server 와 같은 80번 포트,
> `/manager` 경로를 공유하므로 앞단 리버스 프록시의 forward-auth 하나가 둘 다 보호합니다
> — 프록시 설정 없이 80번 포트를 그대로 인터넷에 노출하면 안 됩니다 (README의
> [보안 (로그인)](index.md#보안-로그인) 절과 동일한 방식으로 프록시를
> 구성하세요). SSH 키/git credential 파일을 직접 다루는 기능이라 code-server 의
> `auth: none` 보다 더 신중한 접근 통제가 필요합니다. **특히 Terminal(브라우저에서
> 곧바로 root 쉘)과 파일(임의 파일시스템 read/write/delete) 탭은 webmanager 안에서
> 가장 강한 권한을 가진 기능**이라 [webmanager-config.md의 비밀번호
> 게이트](webmanager-config.md#비밀번호-게이트)(`WEBMANAGER_AUTH_PASSWORD_HASH`,
> 기본은 꺼짐)를 함께 설정하는 걸 강력히 권장합니다.
