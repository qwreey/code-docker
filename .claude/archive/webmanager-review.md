# webmanager 전체 프로젝트 리뷰 (2026-08-02)

> **아카이브됨 (2026-08-03)**: 이 문서가 다루던 라운드는 오래전에 끝났고, 여기서
> 나온 이슈들은 전부 고쳐졌거나 각 기능의 `webmanager/.claude/*-plan-done.md`
> 문서에 흡수됨(예: 프로그램별 메타데이터 아이디어 → `supervisor-plan-done.md`로
> 실제 구현). 더 이상 "살아있는" 진행 중 문서가 아니라 그 근거/이력 기록이라
> `webmanager/`가 아니라 레포 루트 `.claude/archive/`로 옮김(`tailscale-design.md`와
> 같은 성격). 새 작업 시 재발 방지용 참고 자료로만 쓸 것 — 실제 현재 상태는 항상
> 개별 `*-plan-done.md`가 우선.

이번 세션에서 4개 라운드에 걸쳐 여러 subagent가 병렬로 만든 코드 전체를 대상으로,
Go 백엔드/React 프론트엔드/Docker·vector·supervisord 인프라 세 영역에서 각각 별도
리뷰 에이전트를 돌려 찾은 문제들. 심각도가 높은 편이었던 항목은 리뷰 직후 바로
고치고 실제 컨테이너에서 재검증까지 끝냈다 — 아래 "고침" 항목은 전부 `go build`/
`go vet`/`npm run build`/`npm run lint` 통과 + 실제 `docker compose build && up`
컨테이너에서 재현/해결 확인까지 마친 상태.

## 고침 (Critical/High)

### 1. Supervisor 탭 시작/정지/재시작에 확인창이 없었음 — **critical**
다른 모든 destructive 액션(SSH 키 삭제, git credential/host/GPG 키 삭제, tailscale
forward/publish 삭제, 프로세스 kill)은 `window.confirm`이 있는데 여기만 없어서,
**"webmanager" 행에서 정지를 누르면 이 패널 자신을 서빙하는 프로세스가 확인 없이
즉시 죽는** 실수 방지 장치가 전혀 없었음(SSH/터미널 없이는 복구 불가). `sshd` 정지도
마찬가지로 다른 접근 경로를 끊음.
**고침**: 모든 행에 확인창 추가, `webmanager`/`sshd` 정지 시에는 "접근 수단을 잃을 수
있다"는 추가 경고 문구까지 넣음. 실제 confirm 취소 시 API 호출이 안 나가는 것까지
확인.

### 2. git SSH 호스트 추가에서 path traversal + SSH config injection — **critical/high**
`internal/gitconfig/sshhosts.go`의 `AddSSHHost`가 `host` 값을 검증 없이
`filepath.Join(keysDir, host)`에 그대로 써서, `host`에 `../` 등을 넣으면
`ssh-keygen`이 `keysDir` 바깥 임의 경로에 파일을 쓸 수 있었음(webmanager가 root로
동작하므로 사실상 임의 파일 쓰기). 또한 `host`/`hostname`/`user`가 검증 없이
`~/.ssh/config`에 원문 그대로 삽입돼서, 개행 문자를 넣으면 임의 SSH 지시어
(`ProxyCommand` 등)를 주입할 수 있었음. 실제 리뷰에서 두 가지 다 재현 테스트로 확인됨.
**고침**: `host`는 `^[A-Za-z0-9._-]+$`만 허용, `hostname`/`user`는 개행 문자 거부.
실제 컨테이너에서 `../evil` 요청이 `400`으로 거부되고 파일이 전혀 생성되지 않는 것
확인.

### 3. vector가 stderr를 안 봐서 tailscaled 로그인 URL이 `docker compose logs`에서
   사라짐 — **high, 이번 세션에서 생긴 회귀**
모든 program의 stdout이 `/dev/fd/1`에서 실제 파일로 바뀌면서, vector는 stdout만
tail하도록 만들어져 있었음. 근데 `tailscaled`는 로그인 URL을 포함한 진단 메시지
전부를 stderr로만 씀 — 즉 README가 "최초 실행 시 `docker compose logs -f`로
로그인 URL을 확인하라"고 안내하는 그 워크플로우가 이번 세션 변경으로 조용히
깨져 있었음. code-server의 진단 메시지 일부도 마찬가지로 stderr에만 있어서 같은
문제.
**고침**: `config/vector.default.toml`의 `sources.app_logs.include`에
`/var/log/*/stderr.log*`도 추가. 실제 컨테이너 재빌드 후 `docker compose logs`에
`[tailscaled] To authenticate, visit: https://login.tailscale.com/a/...`가 다시
나오는 것 확인.

### 4. 포트 81(webmanager)의 tailnet 자동 노출이 README ACL 안내에 빠져있었음 — **high**
`ss -tlnp`로 확인 결과 webmanager도 22/80과 동일하게 `0.0.0.0`에 바인드되어 있어서
tailscaled의 자동 포워딩(어떤 `tailscale serve` 규칙도 없이 같은 포트로 자동 연결)에
그대로 걸림 — 근데 README의 ACL 예시(`"ip": ["tcp:22", "tcp:80"]`)와 경고 문구는
webmanager가 생기기 전에 쓰여서 이 서비스를 언급하지 않음. webmanager는 자체 로그인이
없고 SSH 키/git credential을 다루므로 code-server보다 더 민감한데 더 넓게 노출돼
있었던 셈.
**고침**: README의 경고 문구 + ACL 예시에 `tcp:81` 추가.

## 고침 (Medium)

### 5. GPG keyId를 통한 gpg 플래그 인젝션
`keyId`가 `exec.Command`에 검증 없이 bare argument로 들어가서, `--homedir=/some/path`
같은 값이 `gpg`에게 플래그로 파싱됨(실제로 재현: 새 GnuPG homedir이 생성됨).
**고침**: `keyId`는 40자리 hex(실제 fingerprint 형식)만 허용하도록 검증 추가, 컨테이너
에서 `--homedir=...` 요청이 `400`으로 거부되는 것 확인.

### 6. 로그 한 줄이 1MB 넘으면 그날 로그 전체가 502
`internal/logstore`가 `bufio.Scanner`(1MB 토큰 제한)를 쓰는데, 스캔 에러를 그대로
전파해서 오버사이즈 라인 하나 때문에 그날치 로그 전체 조회가 실패했음.
**고침**: 스캔 에러를 fatal로 취급하지 않고, 에러 이전까지 스캔된 엔트리는 그대로
반환하도록 수정(에러 이후 라인은 복구 불가지만, 전체 요청 실패보다는 훨씬 나은
열화).

### 7. 타임존 자정 경계에서 로그 날짜 파일이 어긋날 수 있었음
백엔드가 `time.Now()`(로컬 타임존)로 오늘/어제 파일명을 계산하는데, vector의 파일
경로 템플릿은 UTC 기준 — 컨테이너에 `TZ`를 설정하면(지금은 미설정이라 안 드러남)
자정 근처 몇 시간 동안 서로 다른 날짜 파일을 봐서 최근 로그가 조용히 누락될 수 있었음.
**고침**: 양쪽 다 UTC 기준으로 통일(`time.Now().UTC()`).

### 8. SSH 호스트 키 생성 중 부분 실패 시 고아 키 파일
`ssh-keygen`은 성공했는데 `~/.ssh/config` append가 실패하면, API로는 찾거나 지울 수
없는 키 파일이 남아서 같은 host로 재시도해도 계속 실패하는 상태가 됐음.
**고침**: config append 실패 시 방금 생성한 키 파일을 정리(`sshsigning.go`의 기존
패턴과 동일하게).

### 9. `/api/system/resources`가 "값을 못 읽음"과 "실제로 0"을 구분 못 함
cgroup/statfs 읽기가 실패하면 해당 섹션이 그냥 0으로 채워져서, 프론트가 이걸 진짜
0으로 오인해 보여줄 수 있었음.
**고침**: `memory`/`cpu`/`disk` 각각에 `available: bool` 필드 추가(하위 호환,
추가적 변경), 프론트도 `available: false`일 때 "확인 불가"로 표시하도록 수정. 실제
컨테이너에서 `{"memory":{...,"available":true},...}` 형태로 응답되는 것 확인.

## 고침 (Low/Cosmetic)

- **"이미 존재함" 충돌이 라운드마다 400/409로 제각각** → `409`로 통일(supervisor의
  `ALREADY_STARTED`/`NOT_RUNNING` 매핑과 일치시킴). 컨테이너에서 실제 중복 요청이
  `409`을 반환하는 것 확인.
- **요청 바디 크기 제한 없음** → 1MiB cap 추가(defense-in-depth, 실사용 요청은
  전부 이보다 훨씬 작음).
- **`procinfo.Sampler`가 gopsutil 스캔 전체 구간 동안 mutex를 쥐고 있었고 `defer`도
  없었음** → 락 범위를 맵 읽기/쓰기로만 좁히고 `defer` 추가, `go test -race`로 동시
  호출 20개 무경합 확인.
- **GPG 서명 키 선택 시 "아직 저장 안 됨" 경고가 SSH 플로우에만 있고 GPG 플로우엔
  없었음** → 동일 문구 추가.
- **로그 뷰어에서 빈 줄(`message: ""`)이 그냥 빈 셀로 보여서 깨진 것처럼 보임** →
  "(빈 줄)" 플레이스홀더로 표시.
- **tailscale forward/publish 뮤테이션이 부분 실패(디스크 쓰기는 성공, 재시작만
  실패)하면 화면 상태가 실제 디스크 상태와 어긋날 수 있었음** → 성공/실패 관계없이
  뮤테이션 후 항상 목록을 다시 불러오도록 수정.
- **Dockerfile `EXPOSE`가 81을 안 담고 있었음** → 추가.
- **webmanager 바이너리가 strip 안 돼서 11MB** → `-ldflags="-s -w"` 추가.

## 검증해봤지만 버그가 아니었던 것들 (재조사 방지용 기록)

- git credentials의 `host` 필드: `net/url.URL`이 개행/공백을 percent-encode해서
  안전함 — 실제로 개행이 든 host/token으로 테스트해서 확인.
- tailscale forward/publish의 `name` 필드: `yaml.v3` 진짜 시리얼라이저를 쓰므로
  YAML 구조 인젝션 불가능 — 개행 포함 값으로 라운드트립 테스트해서 확인.
- 타입 드리프트: 이미 잡았던 로그 타임스탬프 건 외에 백엔드 struct ↔ 프론트 타입
  전수 대조에서 추가로 발견된 것 없음.
- 폴링 누수: `Supervisor`/`Processes`/`SystemSummary`/`Logs` 전부 탭 전환 시
  `useEffect` cleanup이 정상적으로 폴링을 멈춤 (Supervisor의 확인창 부재를 제외하면
  다른 destructive 액션들은 전부 confirm+중복클릭 방지 정상).
- vector 자체: `supervisorctl status`로 RUNNING 유지, 체크포인트 파일 생성 확인,
  콘솔/JSONL 두 sink 모두 정상 분리 동작.
- Dockerfile 멀티스테이지 빌드: 캐시 무효화 순서 문제 없음, 최종 이미지에
  go/node/npm 안 남음(`.dockerignore`도 정상 동작 확인).
- override 패턴 준수: 새 override 파일들(`vector-service.*.sh`, `vector.*.toml`,
  `webmanager.*.sh`) 전부 기존 디스패처 구조와 동일, `.gitignore`의
  `config/*.override*` 패턴이 실제로 이들을 커버하는 것 `git check-ignore`로 확인.

## 확인은 했지만 안 고친 것 (알려진 한계)

- **로그 로테이션(10MB) 실제 트리거 여부** — 설정 자체(`stdout_logfile_maxbytes=10MB`
  파싱 등)는 실제로 맞게 동작하는 것 확인했지만, 실제로 10MB를 채워서 회전이
  일어나는 것까지는 확인 안 됨(읽기 전용 검증 원칙상 실제 로그를 10MB까지 채우는
  건 뮤테이션이라 하지 않음). 낮은 우선순위, 필요시 나중에 검증.
- **`/code/.vector/logs/*.jsonl` 보존기간 정책 없음** — 계속 쌓이기만 함, 기존에
  이미 알려진 갭 (plan.md 참고), 이번에도 그대로 둠.
- **vector 자기 자신의 로그는 Supervisor 패널에서 안 보임** (`[program:vector]`만
  여전히 `/dev/fd/1` 직결) — **의도적으로 그대로 둠**. 사용자 확인: "웹 패널에선
  vector에 대해서 안 보여주는 게 맞다", fd1 유지가 기술적으로 더 가볍다는 판단.

## 사용자 질문에 대한 조사 결과: supervisord 프로그램에 커스텀 메타데이터/라벨을 달 수 있는가? — **구현 완료 (2026-08-02)**

아래 조사 결과 그대로 "webmanager 자체에서 처리"하는 방향으로 실제 구현됨:
`config/supervisor-metadata.default.yaml`(override 패턴) + `internal/supervisor`의
`LoadMetadata`가 `GET /api/supervisor/processes` 응답에 프로그램별
`label`/`note`/`disableStart`/`disableStop`/`disableRestart`/`disableLogs`를
병합 — vector는 `disableLogs: true`로 기본 설정됨(자세히는
`.claude/supervisor-plan-done.md`). 아래는 원 조사 기록(여전히 정확함, 왜 이
방식을 택했는지의 근거로 남겨둠).

**결론: 안 됨 — supervisord 자체에는 자유 형식 메타데이터/라벨 필드가 없음.**

- `[program:x]` 섹션은 정해진 지시어(`command`, `stdout_logfile`, `environment` 등)만
  인식하고, RPC(`supervisor.getAllProcessInfo`)가 돌려주는 필드도 고정돼있음(name,
  group, description/uptime, pid, start/stop/now, state/statename, logfile 경로
  등) — 여기에 우리가 끼워넣은 임의 키-값은 RPC로 조회가 안 됨.
- 그나마 "구조적으로" 활용 가능한 건 `group`(기본은 program 이름과 같지만
  `[group:x]` + `programs=`로 여러 program을 묶어 커스텀 이름을 줄 수 있음) 정도인데,
  이건 진짜 라벨이 아니라 supervisorctl에서 그룹 단위로 start/stop/restart가
  같이 묶이는 실제 동작 변화를 수반함 — "패널에 안 보이게" 표시하는 용도로 억지로
  쓰기엔 부적절함(vector를 "internal" 그룹에 넣는다고 해서 자동으로 숨겨지지도
  않고, 오히려 그룹 재시작 등 의도치 않은 부수효과만 생김).
- **실질적인 결론**: "패널에서 특정 서비스를 숨긴다" 같은 라벨링은 supervisord
  쪽이 아니라 **webmanager 자체에서** 처리하는 게 맞음 — 예를 들어
  `WEBMANAGER_HIDDEN_PROGRAMS=vector` 같은 환경변수나 작은 상수 목록을 백엔드에
  두고 `/api/supervisor/processes` 응답에서 필터링하거나 별도 플래그를
  붙이는 방식. supervisord 쪽 config는 그대로 두고 webmanager 쪽에서만 처리하면
  되므로, 필요해지면 구현 자체는 간단함 — **지금은 구현하지 않음, 필요성이 확인되면
  다음 라운드에서 진행**.
