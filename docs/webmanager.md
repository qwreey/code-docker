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

`/code/.ssh/authorized_keys` 목록 조회/추가/삭제

### Git Config

`/code/.gitconfig` 의 user.name/email, 커밋 사이닝(SSH 키 또는 GPG, GPG 키
자체 생성/조회/삭제 포함), 호스트별 SSH 키(ed25519 자동 생성), HTTPS credential store
(`~/.git-credentials`, 평문 저장), `~/.ssh/known_hosts` 관리, `git lfs install` 실행,
`.gitconfig` 원본 직접 편집(저장 전 문법 검증)

### Tailscale

`/code/.tailscale/config.yaml`의 `forwards`/`publish` 항목 조회/추가/삭제
(저장 시 `tailscale-forward` 자동 재시작 — `forward-reload`와 동일 효과). 로그인
상태(URL/`backendState`, 피어 목록)를 읽기 전용으로 보여주고, 아직 로그인 시도가
없는 상태라면 "로그인 시도하기" 버튼으로 `tailscale up`을 온디맨드로 트리거할 수
있습니다 — [tailscale 연결](tailscale.md#최초-로그인과-상태-배너)의 자동 시도가
컨테이너 생애주기 동안 한 번만 일어나도록 바뀐 것과 짝을 이루는 재시도 경로입니다

### Logs

프로그램별 구조화 로그를 앱/레벨/시간 범위(존재하는 로그 기준으로 자동
clamp됨)로 필터링해서 조회, 커서 기반 페이지네이션, 실시간 새로고침(신규 항목 누적)
(아래 [구조화 로그(vector)](#구조화-로그-vector) 참고) — 로그에 시크릿이 노출될 수 있어 이 탭 전체가 비밀번호
게이트 대상입니다(아래 [비밀번호 게이트](#비밀번호-게이트) 참고)

### Task Manager

(구 "Processes") "성능"/"프로세스" 두 서브탭. 성능 탭은 호스트 전체
기준 코어별 CPU 사용률 히트맵, 메모리 구성요소별(캐시/버퍼/사용/여유) 분해(cgroup
제한과 호스트 물리 총량을 나란히), 가능하면 클럭/온도, 최근 10분 히스토리 그래프.
프로세스 탭은 리스트/트리 뷰 전환, 상태 필터, 이름/커맨드 퍼지 검색(일치 부분
강조), 페이지네이션, 리스닝 포트별 점유 프로세스 조회/종료(SIGTERM/SIGKILL) —
`btop`을 안 열어도 다 됩니다

### Claude Code

설치 여부 감지, 로그인 상태, 사용 통계(총 세션/오늘·이번 주/최장
세션, 월간 히트맵, 주간 그래프, 모델별 토큰 사용량), 설치된 Skills/Plugins 목록

### Code Extensions

[`recommendations.*.yaml`](build-customization.md#recommendationsyaml-추천-목록)이 담은 추천 code-server
익스텐션 목록을 카테고리별로 접었다 펼치며 보고 설치, 이미 설치된 익스텐션 전체
목록(기본 접힘), 추천 목록 표시 여부 토글(기기별 저장)

### Projects

`$HOME/Projects` 아래 프로젝트별 용량, `node_modules`/`target` 등
재생성 가능한 폴더 브레이크다운, 오래된 프로젝트 표시, 최근 편집순 정렬, 프로젝트별
mise 사용 도구 목록(읽기 전용), 설정된 경우 code-server로 바로 열기 (읽기 전용 —
삭제 기능은 아직 없음)

### mise

추천 도구 목록을 카테고리별로 접었다 펼치며(기본 접힘) 보고 설치
(`mise use -g`), 전역으로 설치된 도구 목록/삭제, 환경변수 미리보기(`mise env`) —
전역 도구를 바꾼 뒤 code-server 통합 터미널에 반영하려면 `restart` 명령이 여전히
필요합니다

### Terminal

브라우저에서 바로 여는 쉘(xterm.js + WebSocket) — code-server 자체가
죽었을 때의 최소 복구 수단이자, code-server 세션과 무관하게 dev 서버를 잠깐 띄워두는
용도. 이름 붙은 영속 세션을 여러 개 열어두고 탭으로 전환할 수 있고(이름 변경도
가능), 유휴 상태로 일정 시간 방치되면 자동 정리됩니다(고정한 세션은 예외). 모바일에서도
쓸 수 있게 Esc/Ctrl/Alt/Shift/Tab/방향키 온스크린 버튼(커스터마이징 가능)과 색상
테마(프리셋 10개 + 사용자 정의) 지원

### Files

`/code` 아래(설정으로 넓힐 수 있음) 파일시스템을 code-server가 지금 열어둔
프로젝트 폴더에 국한되지 않고 브라우징 — 업로드/다운로드/삭제/이동/복사/이름변경/폴더
생성/멀티선택, 텍스트 파일은 바로 편집(CodeMirror), 권한/생성·수정 시각 정보 패널

### Docker/dind 관리

[Docker in Docker](tips/dind.md) 안의 컨테이너/이미지 목록과 로그 조회, 시작/정지/삭제(전부
확인 다이얼로그 필수, 삭제는 비밀번호 게이트 대상)

---

git-lfs 는 `config/build.default.sh`에 포함되어 기본으로 설치됩니다(패키지 설치만 —
저장소별 `git lfs install`은 위 Git Config 탭에서 직접 실행).

## 비밀번호 게이트

> **주의: webmanager는 자체 비밀번호 게이트를 지원합니다(선택 사항, 기본은 꺼짐).**
> `WEBMANAGER_AUTH_PASSWORD_HASH` 환경변수에 argon2id로 해시한 비밀번호를 설정하면
> `/api/auth/unlock`으로 풀기 전까진 접근할 수 없는 라우트가 생깁니다(해제하면 10분간
> 다시 안 물어봄). **해시는 컨테이너가 이미 떠 있는 상태에서 아래 명령으로 직접
> 생성합니다**(비밀번호를 두 번 입력받아 오타를 확인하고, 화면엔 안 보이며, 결과로
> `$argon2id$...`로 시작하는 해시 한 줄만 출력됨 — 이 값을 그대로 `.env.webmanager`
> 파일([`webmanager.*.sh`](build-customization.md#webmanagersh-webmanager-실행) 참고,
> 없으면 저장소 루트의 `example-env.webmanager`를 복사해서 만드세요)의
> `WEBMANAGER_AUTH_PASSWORD_HASH`에 붙여넣고 `docker compose up -d`로
> 다시 올리면 적용됩니다, `restart`로는 새 환경변수가 안 먹습니다):
>
> ```sh
> docker compose exec code-docker /etc/code-docker/webmanager/webmanager --hash-password
> ```
>
> 원칙은 **조회(읽기)는 그대로 열어두고, 변경(쓰기)만 게이트** —
> Supervisor의 start/stop/restart, Git Config/Tailscale의 모든 추가·수정·삭제, SSH
> Keys 추가·삭제 등이 여기 해당합니다. 예외로 **Terminal, 파일 탭, Logs, Supervisor의
> 프로그램별 로그 조회는 조회까지 통째로 게이트**됩니다(각각 root 쉘/임의 파일
> 접근/로그 속 시크릿 노출 위험 때문). 값은 반드시 환경변수로만 주입해야 하며(설정
> 파일에 저장하면 컨테이너 안에서 프로세스를 재시작해 우회할 수 있어 일부러 지원하지
> 않습니다), `/etc/environment`에도 같은 이름의 변수가 있으면 조작 가능성으로 보고
> 게이트가 무시됩니다. 설정하지 않으면 이 게이트는 기본적으로 열려 있으므로(다른
> 탭과 동일하게 리버스 프록시 인증에만 의존), 컨테이너 밖에 노출한다면 반드시 설정을
> 권장합니다 — 특히 Terminal(브라우저에서 곧바로 root 쉘)과 파일 탭(임의 파일시스템
> read/write/delete)은 webmanager 안에서 가장 강한 권한을 가진 기능입니다.

## 구조화 로그 (vector)

각 supervisord program의 표준출력은 이제 `/var/log/<프로그램명>/stdout.log` 로 실제 파일에
회전(rotate)되어 남으며, [vector](https://vector.dev)가 이 파일들을 tail 하여
`[프로그램명] ...` 형태로 라벨링해서 컨테이너 stdout으로 다시 흘려보냅니다 — 따라서
`docker compose logs` 로도 이제 어느 program의 로그인지 구분됩니다([`vector.*.toml`](build-customization.md#vectortoml-vector-로그-파이프라인-설정)
참고). webmanager의 로그 뷰어(Logs 페이지)도 vector가 함께 쓰는 구조화 로그
(`/code/.vector/logs/*.jsonl`)를 읽어 실제 데이터를 보여줍니다(이전엔 목업 데이터였습니다).

## 보안: 자체 로그인 없음

> **주의: webmanager 는 자체 로그인 화면이 없습니다.** code-server 와 같은 80번 포트,
> `/manager` 경로를 공유하므로 앞단 리버스 프록시의 forward-auth 하나가 둘 다 보호합니다
> — 프록시 설정 없이 80번 포트를 그대로 인터넷에 노출하면 안 됩니다 (README의
> [보안 (로그인)](../README.md#보안-로그인) 절과 동일한 방식으로 프록시를
> 구성하세요). SSH 키/git credential 파일을 직접 다루는 기능이라 code-server 의
> `auth: none` 보다 더 신중한 접근 통제가 필요합니다. **특히 Terminal(브라우저에서
> 곧바로 root 쉘)과 파일(임의 파일시스템 read/write/delete) 탭은 webmanager 안에서
> 가장 강한 권한을 가진 기능**이라 위 [비밀번호 게이트](#비밀번호-게이트)에 설명된 자체
> 비밀번호 게이트(`WEBMANAGER_AUTH_PASSWORD_HASH`, 기본은 꺼짐)를 함께 설정하는 걸
> 강력히 권장합니다.
