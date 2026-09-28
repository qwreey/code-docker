# code-docker 외부자 감사 보고서

- 작성: Claude Opus 5 (에이전트 6기 병렬 감사 — 셸/인프라, webmanager 백엔드, router/nginx, 프론트엔드/code-patch, 프로젝트 건전성, 그리고 총괄)
- 날짜: 2026-09-16
- 기준 커밋: `main` @ `e5f169f`
- 성격: **읽기 전용**. 파일 수정 없음, 빌드/컨테이너 기동 없음. 예외로 `go test`(3개 모듈)와 `bash -n`만 실행.

## 이 보고서를 어떻게 읽어야 하는가

`.claude/archive/security-review-2026-09-07-done.md`의 C1/C2/C3/H1~H4는 **이미 수정·검증
완료**된 것으로 전제하고, 재보고하지 않았다. 감사 범위에서 그 코드를 건드린 경우
수정이 실제로 들어갔는지만 확인했고(전부 들어가 있었다), 미완성인 경우에만 따로 적었다.

따라서 아래는 **전부 새 항목**이다. 다만 심각도 분포가 지난 리뷰와 다르다: 지난 리뷰의
Critical 3건은 "경계가 한 방에 뚫린다"였지만, 그게 막힌 지금 남은 것들은 대부분
**운영자 권한을 이미 가진 사람이 실수하거나, 인증 없는 사람이 서비스를 망가뜨리는**
성격이다. 유일한 예외가 D1(배포 경로)과 S1(인증 없는 전역 잠금)이다.

각 항목에 **[직접 확인]** / **[에이전트 보고]** 표시를 달았다. "직접 확인"은 내가 해당
파일을 열어 근거 줄을 눈으로 본 것이고, "에이전트 보고"는 서브에이전트가 근거를 제시했으나
내가 재확인하지 않은 것이다.

| # | 심각도 | 요지 |
|---|---|---|
| D1 | **Critical** | `origin/HEAD` → 6주 묵은 `master`. 문서대로 클론하면 router(netgate) 자체가 없고 09-07 수정도 전부 빠진 스택이 조용히 설치됨 |
| S1 | **High** | webmanager authgate 잠금 키가 항상 nginx 주소 → 인증 없는 누구나 5회 실패로 **전원**을 영구 잠금 |
| S2 | **High** | code-server가 런타임에 `releases/latest`를 root로 자동 설치 (핀/체크섬/서명/opt-out 전무) |
| S3 | **High** | `install.sh`가 다운로드 **전에** 기존 설치를 `rm -rf` → 일시적 네트워크 오류로 code-server 소실 |
| P1 | **High** | CI 전무. Go 테스트 37개가 존재하고 전부 통과하는데 아무것도 자동으로 돌리지 않음 |
| P2 | **High** | `code-docker` 본체에 healthcheck 없음 → 내부 전 프로그램이 죽어도 `docker compose ps`는 `Up` |
| P3 | **High** | `pacman -Suy`가 전부 버전 미고정. 문서 어디에도 언급 없음 |
| S4 | Medium | dind-authz가 `UsernsMode`를 파싱하지 않음 → `--userns=host`로 `dind-authz-remap` 계층 무력화 |
| S5 | Medium | `.env*`가 644. argon2id 해시가 world-readable |
| S6 | Medium | netgate forwards / tailscale publish가 `targetguard` 허용목록을 안 거침 → 한 번의 API 호출로 dind 소켓을 tailnet에 노출 가능 |
| S7 | Medium | router의 인증 없는 GET들이 내부 토폴로지·VNC 접속자 IP/UA를 노출 (09-07에 `tailscale/status`를 막은 것과 같은 부류인데 안 막힘) |
| S8 | Medium | `/api/fonts/css`의 `cssEscape`가 백슬래시를 이스케이프하지 않음 → 인증 없이 배포되는 CSS에 주입 |
| S9 | Medium | `ReplaceOutbound`에 최소 안전선 없음 — `PUT /api/netgate/outbound []`로 RFC1918 차단 전체 삭제 (v6에는 있는 고정 차단이 v4에는 없음) |
| S10 | Medium | tinyauth 세션 쿠키가 `ROUTER_VHOST_*` 대상에게 그대로 전달됨 |
| S11 | Medium | `ROUTER_MANAGER_HOSTS`/`TINYAUTH_HOSTS`/`TRUSTED_PROXIES`가 nginx 지시어에 미검증 삽입 |
| P4 | Medium | `example-env`에 깨진 내부 링크 12개 |
| P5 | Medium | 볼륨 기본 경로에 `PREFIX`가 없음 → 같은 디렉터리의 두 인스턴스가 `/code`·호스트키·dind 저장소를 공유 |
| P6 | Medium | CLAUDE.md 53KB 단일 파일, 서브모듈 CLAUDE.md와 수작업 중복 |
| — | Low/Nit | 아래 본문 |

---

# 1. 배포 경로

## D1 (Critical) — 문서대로 설치하면 보안 수정이 하나도 없는 스택이 설치된다 **[직접 확인]**

```
$ git symbolic-ref refs/remotes/origin/HEAD
refs/remotes/origin/master

$ git log -1 --format='%h %ad %s' --date=short origin/master
6effec1 2026-08-02 feat: add wl-copy, xclip and sshd-service config script ...

$ git rev-list --count origin/master..origin/main
378

$ git ls-tree origin/master | grep commit
160000 commit ddbc72e...  code-server-autoinstall      # ← 이것 하나뿐
```

`origin/master`에는 `router`·`code-dind`·`envmigrate` 서브모듈이 **아예 없다**. router
추출 이전 시점이기 때문이다. 그런데 `docs/index.md:8`의 설치 명령은 이렇다:

```sh
git clone --recurse-submodules https://github.com/qwreey/code-docker.git builds/code-docker
```

브랜치 지정이 없다. 즉 문서를 그대로 따른 사람이 받는 것은 2026-08-02 트리이고, 결과는:

- **egress netgate가 통째로 없다** — 사설망 격리, DOCKER-USER 예외, 라우트 심기 전부 부재
- **dind-authz가 없다** — privileged dind 데몬이 아무 정책 없이 노출
- 09-07 리뷰의 C1/C2/C3/H1~H4 수정이 **전부** 없다
- 그리고 `git clone`은 **성공한다**. 아무 경고도 없다

`TODO.md`에 "버저닝이 필요함, master 에는 릴리즈만 넣는다는 이정도까지 못함"이라고 이미
적혀 있는데, 실제 상태는 "릴리즈만 넣는다"가 아니라 **"6주 전에 멈춰 있고 그게 기본
브랜치다"** 이다. 태그 전략 논의와 별개로 지금 당장의 문제다.

**수정**: `git remote set-head` / GitHub 저장소 설정에서 default branch를 `main`으로
바꾸거나, 최소한 `docs/index.md:8`에 `--branch main`을 넣는다. 전자를 권한다 —
후자는 `git clone <url>`만 친 사람을 못 구한다.

**곁다리**: `origin/dev`는 2026-08-24에 멈춰 있고, `origin/worktree-*` 브랜치 5개가
2026-08-10~08-29 상태로 남아 있다. 외부자에게 "어느 게 살아있는 브랜치인지" 신호가
전혀 없다.

---

# 2. 보안

## S1 (High) — 인증 없이 누구나 webmanager 비밀번호 게이트를 영구히 잠글 수 있다 **[직접 확인]**

`webmanager/backend/handlers_auth.go:18-24`:

```go
// from the TCP peer address rather than X-Forwarded-For/X-Real-IP — nginx
// doesn't rewrite those on the way in (see the security audit), so an
// attacker could otherwise reset their own lockout just by sending a
// different header value on each request.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	...
}
```

주석이 "the security audit"을 근거로 `RemoteAddr`를 신뢰한다고 명시한다. 그런데 실제
배선이 그 전제와 다르다:

```
$ grep -n 'proxy_set_header' config/nginx/nginx.default.conf
123: proxy_set_header Upgrade $http_upgrade;
124: proxy_set_header Connection "upgrade";
125: proxy_set_header Host $host;
156: proxy_set_header Host $host;
...   # X-Real-IP / X-Forwarded-For 는 파일 전체에 단 한 줄도 없음
```

`nginx-service.default.sh:78`이 `WEBMANAGER_ADDR:-private:81`로 **평문 TCP** 프록시를
하므로, webmanager가 보는 `r.RemoteAddr`는 **모든 클라이언트에 대해 nginx 자신의 주소**다.
즉 `authgate.Gate.recordFailure`(`internal/authgate/gate.go:107-129`)의 버킷이 전역 하나다.

`POST /api/auth/unlock`은 설계상 게이트 밖에 있어야 한다(잠긴 사람이 풀어야 하니까 —
`main.go:360`). 그래서 **컨테이너에 닿을 수 있는 익명 사용자가 틀린 비밀번호 5번**이면
Terminal(루트 셸)·File Manager·Logs·Sessions·dind 제어·mise가 **전원에게** 잠긴다.
지수 백오프 최대 5분이고, 5분에 한 번씩 계속 틀려주면 무기한 유지된다.

`internal/webdavshare/service.go:362-368`의 Basic 인증 백오프에도 같은 버그가 독립적으로 있다.

이건 09-07의 H2(router-manager, 유닉스 소켓 케이스)와 **다른 건**이다. `TODO.md`의
마지막 항목 "webmanager 쪽도 같은지는 아직 확인 안 함"에 대한 답이 "그렇다"이다.

**수정**: webmanager로 가는 모든 `proxy_pass` 블록에 `proxy_set_header X-Real-IP $remote_addr;`
를 넣고(nginx는 이미 conf 56-62줄에서 `TRUSTED_PROXIES` 기반 real_ip를 계산하고 있다),
두 `clientKey()`가 그 헤더를 우선 읽고 없을 때만 `RemoteAddr`로 폴백하게 한다.
정상 토폴로지에서 `WEBMANAGER_ADDR`에 닿는 건 nginx뿐이므로 그 홉의 헤더는 신뢰해도 된다.

## S2 (High) — code-server가 런타임에 `latest`를 root로 자동 설치한다 **[직접 확인]**

`code-server-autoinstall/install.sh:20-42`는 code-service가 뜰 때마다(`last-check`로 1시간
스로틀) 실행되어 GitHub `releases/latest`를 해석하고 그 tarball을 홈 볼륨에 root로 푼다.

- 버전 핀 없음
- 체크섬 없음 (업스트림이 체크섬 파일을 안 준다는 건 지난 리뷰가 지적했음)
- 서명 검증 없음
- **opt-out 환경변수 없음**
- 그리고 이게 **빌드 타임이 아니라 이미 돌고 있는 배포에서** 일어난다

지난 리뷰는 "체크섬 파일이 없어 그대로"라고만 적었는데, 이게 자동·주기적·런타임이라는
점은 다루지 않았다. 공급망 관점 외에도, 패치를 깨는 code-server 릴리스가 나오면
사용자가 아무것도 안 했는데 다음 재시작에서 들어오고 롤백 경로가 없다.

**수정**: `CODE_SERVER_VERSION`(빈 값이면 latest) + `CODE_SERVER_AUTOUPDATE=false` 두
환경변수. 최소한 후자는 있어야 한다.

## S3 (High) — 다운로드 전에 기존 설치를 지운다 **[직접 확인]**

`install.sh:37-38`:

```sh
[ -e "$SPATH/code-server" ] && rm -rf "$SPATH/code-server"
mkdir -p "$SPATH/code-server"
curl -fL .../code-server-$LATEST-linux-amd64.tar.gz | tar -C "$SPATH/code-server" -xz --strip-components=1
if [ "$?" != '0' ]; then
```

`rm -rf`가 다운로드 **앞**에 있다. GitHub이 30초 흔들리는 순간에 재시작이 걸리면
멀쩡히 돌던 code-server가 사라진다. 게다가 `set -o pipefail`이 없어서 40줄의 `$?`는
curl이 아니라 **tar**의 상태다.

**수정**: 임시 디렉터리에 받아서 성공 후 `mv`로 교체. `set -o pipefail` 추가.

## S4 (Medium) — `install.sh`가 아무것도 설치하지 않고 성공을 보고할 수 있다 **[직접 확인]**

`install.sh:21`의 `curl -s`에 `-f`가 없다. HTTP 5xx 에러 페이지도 exit 0이므로 재시도
루프가 성공으로 빠져나온다. 그러면 `location:` 헤더가 없어 `LATEST`가 빈 문자열이 되고,
**신규 설치**에서는 `CURRENT`가 unset이므로:

```sh
[ "x$LATEST" == "x$CURRENT" ]   # → [ "x" == "x" ] → 참
	exit 0
```

아무것도 안 깔고 `exit 0`. 메모리에 적힌 "설치 스크립트에 조용한 건너뛰기 금지" 원칙에
정확히 걸리는 사례다.

관련 저강도: `install.sh:63`의 `CURLSTATE="$?"`는 이름과 달리 curl이 아니라 그 바로 위
`ln -sf`의 상태를 받는다(curl은 20줄 위에 있다). `installed-version` 기록 여부가 엉뚱한
신호에 달려 있고, 65줄의 `exit "$?"`는 그 테스트의 상태로 끝난다.

## S5 (Medium) — dind-authz가 `UsernsMode`를 보지 않는다 **[직접 확인]**

```
$ grep -n 'UsernsMode\|Privileged\|CgroupnsMode' code-dind/dind-authz/policy.go
43: Privileged   bool   `json:"Privileged"`
49: CgroupnsMode string `json:"CgroupnsMode"`
198: if hc.Privileged {
227: if hc.CgroupnsMode == "host" {
# UsernsMode 없음
```

`createBody`에 필드 자체가 없으므로 `evaluate()`가 검사할 수 없다. opt-in 타깃
`dind-authz-remap`은 "플러그인에 버그가 있어도 userns-remap이 진짜 호스트 root는 막아준다"는
심층 방어 계층인데, Docker는 `--userns=host`를 `Privileged`와 **독립적으로** 컨테이너별
opt-out으로 허용한다. 따라서 평범한(비특권) `docker run --userns=host ...`가 기존 검사를
전부 통과하면서 그 계층만 정확히 무력화한다. `policy_test.go`에도 해당 필드/테스트가 없다.

**수정**: `HostConfig`에 `UsernsMode string` 추가 후 빈 값이 아니면 거부.

## S6 (Medium) — `.env*`가 644다 **[직접 확인]**

```
$ stat -c '%a %n' .env .env.webmanager .env.router
644 .env
644 .env.webmanager
644 .env.router
```

`WEBMANAGER_AUTH_PASSWORD_HASH`, `ROUTER_MANAGER_AUTH_PASSWORD_HASH`,
`WEBMANAGER_WEBDAV_PASSWORD_HASH`(argon2id)를 담은 파일이 world-readable이다.
`ootb.sh`/`ootb-config.sh`/`ootb-lib.sh`의 `set_env_var` 어디에도 `chmod`가 없다.
호스트의 다른 로컬 계정, 백업 잡, 이 디렉터리를 bind-mount하는 다른 컨테이너가 읽어서
오프라인 크래킹을 시도할 수 있다.

**[에이전트 보고, 미확인]** 관련해서 `migrate-continue.sh`가 env 백업을 `>>`로 **덧붙인다**.
`migrate.sh`를 돌릴 때마다 같은 `.bak` 파일에 그 시점의 비밀 해시를 포함한 전체 사본이
한 벌씩 쌓이고, 잘리지도 로테이트되지도 않는다. S6의 권한 문제와 곱해진다.

**수정**: 생성 직후 `chmod 600`(`.bak` 포함), 백업은 `>` 또는 타임스탬프 이름.

## S7 (Medium) — netgate forwards / tailscale publish가 `targetguard`를 안 거친다 **[직접 확인]**

```
$ grep -n 'targetguard' backend/internal/{netgate,tailscale,devproxy,approutes}/*.go
tailscale/config.go:73:  if targetguard.SelfHosts[strings.ToLower(host)] {   # 자기 자신만 거부
devproxy/devproxy.go:175: return targetguard.Validate(target, allowedTargetHosts, ...)
approutes/...                                                                # 허용목록 적용
# netgate/*.go → 0건
```

netgate의 `validateHost`(`internal/netgate/config.go:52-57`)는 문자셋 정규식뿐이다.
tailscale은 `SelfHosts` 거부목록만 보고 허용목록은 안 본다.

결과적으로:

- `POST /api/netgate/forwards {"targetHost":"router","targetPort":81}` → 호스트 대면
  DNAT이 router 자신의 관리 포트로 꽂힌다. targetguard가 존재하는 이유인 self-SSRF 부류.
- tailscale publish를 `target_host: dind`로 만들면 **인증도 TLS도 없는 dind Docker
  소켓이 tailnet 전체에 노출**된다. 그 소켓이 `code-docker-internal`에 갇혀 있다는 것이
  루트 CLAUDE.md가 명시한 신뢰 근거인데, 그걸 한 줄 API 호출로 무효화할 수 있다.

두 경로 모두 09-07의 C2 수정 덕에 **인증된 운영자만** 호출할 수 있으므로 원격 공격은
아니다. 하지만 "운영자가 한 번 실수하면 호스트 루트"이고, 그걸 막으라고 만든 허용목록이
바로 옆 모듈에 이미 있다. 일관성 문제가 아니라 안전장치 누락이다.

**수정**: 두 필드 모두 `targetguard.Validate`/`WithExtraHosts`를 통과시킨다.

## S8 (Medium) — router의 인증 없는 GET이 내부 토폴로지와 접속자 PII를 흘린다 **[직접 확인]**

09-07 수정은 `GET /api/tailscale/status`를 **"운영자의 사설 네트워크를 서술한다"**는
이유로 게이트 뒤로 옮겼다. 그런데 같은 부류가 그대로 열려 있다 (`router/backend/main.go`):

```
143: GET /api/dev-proxy/exposes          → 등록된 모든 내부 서비스의 host:port
149: GET /api/app-routes/apps            → 같음
173: GET /api/vnc/targets/{name}/clients → 현재 보고 있는 사람들의 실제 IP + User-Agent
181,188,190: GET /api/dns/...            → 블록리스트, 커스텀 호스트, 리졸버 설정
197,199,202: GET /api/netgate/...        → 방화벽 규칙, 포워드(내부 호스트+포트), 대역폭
```

특히 `/api/vnc/targets/{name}/clients`는 인프라 정보가 아니라 **사람의 PII**다.

**수정**: "reads stay open" 원칙을 재검토해서, `tailscale/status`를 막은 기준을 만족하지
못하는 것들을 게이트 뒤로 옮긴다. VNC 접속자 목록은 무조건.

## S9 (Medium) — 폰트 CSS 주입 **[직접 확인]**

`webmanager/backend/internal/fonts/fonts.go:240-243`:

```go
func cssEscape(s string) string {
	return strings.ReplaceAll(s, "'", "\\'")
}
```

작은따옴표만 바꾸고 **백슬래시 자체는 이스케이프하지 않는다**. 234줄의 템플릿은
`font-family: '%s';` 이므로, 홀수 개의 백슬래시로 끝나는 `family` 값은 템플릿 자신의
닫는 따옴표를 이스케이프해 버리고, CSS 문자열이 뒤따르는 `src: url(...)` 텍스트로
계속 흘러간다.

`/api/fonts/css`는 설계상 **인증 없이** code-server 페이지와 webmanager `index.html`을
여는 모든 방문자에게 제공된다. 다만 `family`를 심으려면 폰트 업로드 게이트 비밀번호가
필요하므로, 영향은 공유 origin에 대한 저장형 CSS 주입(디페이싱, `:has()`/속성 선택자
기반 상태 프로빙)이지 RCE가 아니다.

(내가 추가 확인: `f.Format`은 `FormatForExt(ext)`의 고정 매핑에서 오므로 주입 불가.)

**수정**: `strings.NewReplacer("\\", "\\\\", "'", "\\'")` — 순서 중요.

## S10 (Medium) — netgate 아웃바운드 교체에 최소 안전선이 없다 **[에이전트 보고, 부분 확인]**

`router/backend/internal/netgate/config.go`의 `ReplaceOutbound`가 전체 목록 교체인데
하한선이 없어서 `PUT /api/netgate/outbound []`가 RFC1918/link-local/loopback 차단을
통째로 지운다. IPv6 경로(`firewall.default.sh`의 `apply_rules_v6`)는 고정 차단 세트를
config 내용과 무관하게 **무조건** 적용하는데, IPv4에는 그 backstop이 없다.

즉 CLAUDE.md가 말하는 "hard boundary"가 v4에서는 코드가 아니라 관례로만 존재한다.
C2 수정 이후 인증된 운영자만 호출 가능하므로 원격 공격은 아니지만, netgate의 존재
이유가 "안에 있는 코드를 못 믿는다"인 만큼 한 번의 잘못된 PUT이 그 전제를 지우는 건
설계 결함에 가깝다.

**수정**: v6가 하는 것처럼 v4 고정 차단 세트를 코드에 박거나, RFC1918 블록을 없애거나
허용 규칙 아래로 내리는 교체를 거부한다.

## S11 (Medium) — tinyauth 세션 쿠키가 vhost 대상에게 전달된다 **[직접 확인 — 맵 내용]**

`router/config/nginx/nginx.default.conf:145-156`의 3단 쿠키 제거 맵은
`router_manager_unlock` **하나만** 벗긴다. 두 nginx 파일 전체에서 tinyauth 쿠키 이름을
벗기는 코드는 0건이다.

`router/CLAUDE.md`에 따르면 tinyauth는 `auth.subdomainsenabled`(업스트림 기본값)로
동작해 쿠키가 부모 도메인 전체에 스코프된다. `ROUTER_VHOST_*` 대상은 같은 부모 도메인
아래에 있고, vhost는 애초에 "코드 서버와 origin을 공유시키면 안 되는 앱"을 위해 만든
기능이다 — 즉 신뢰가 낮은 백엔드다. 그 백엔드가 살아있는 tinyauth 세션 쿠키를
원본 헤더 그대로 받는다.

**주의**: 실제 악용 가능 여부는 tinyauth 쿠키의 도메인 스코프에 달려 있고, 나는 vendored
tinyauth 바이너리의 실제 `Set-Cookie` 도메인까지는 확인하지 않았다. 스코프가 호스트
단위라면 영향 없음. **실기로 `Set-Cookie` 한 줄만 확인하면 결론난다.**

**수정**: 스코프가 부모 도메인이라면 `/exports/`·`/app/`·모든 vhost 블록에서
tinyauth 쿠키도 `router_manager_unlock`과 동일하게 벗긴다.

## S12 (Medium) — 환경변수가 nginx 지시어에 미검증 삽입된다 **[에이전트 보고, 미확인]**

같은 파일 안에서 방어 수준이 갈린다. `ROUTER_VHOST_*` 호스트는
(`router/config/nginx/nginx-service.default.sh:397-408`) `^[A-Za-z0-9_.*-]+$`로 검증하는데,
바로 위의 것들은 안 한다:

- `ROUTER_MANAGER_HOSTS` / `TINYAUTH_HOSTS` (`:185-196`, `:276-285`) → `server_name`에
  **검증 0**. `;`나 `}`가 들어가면 지시어/블록 밖으로 나간다
- `ALLOWED_HOSTS` / `ALLOWED_EXPORT_HOSTS` (main `:23-39`, router `:23-49`) →
  `map`의 `"$host" 1;`에 들어가는데 `"` 검사 없음
- `TRUSTED_PROXIES` (main `:56-70`, router `:61-70`) → `set_real_ip_from $proxy;`에
  **따옴표 없이** 삽입. `;` 하나면 임의 지시어 주입
- `ROUTER_INTERNAL_SUBNET` (router `:108-127`) → `deny ${internal_subnet};`에 따옴표 없이

전부 운영자만 쓰는 `.env` 값이라 실질 긴급도는 낮다. 하지만 코드베이스가 이 부류에
검증이 필요하다는 걸 이미 알고(vhost 쪽) 여기만 빠뜨린 것이므로, 공용
`validate_nginx_token()` 하나로 통일하는 게 맞다.

## S13 (Medium) — 위젯 팝아웃의 세션 해제 경합 **[직접 확인]**

`config/code/code-patch/webmanager-launcher.default.js:207-223`:

```js
frame.addEventListener("load", go);       // ← 리스너를 먼저 단다
setTimeout(go, 2000);
try {
    frame.contentWindow.location.replace(released);   // ← 그 다음 이동시킨다
}
```

`go()`가 기다리는 것은 "방금 내가 시킨 `location.replace(released)`의 완료"인데, 실제로는
**아무 `load` 이벤트**에나 반응한다. 클릭 시점에 iframe이 이미 다른 내비게이션 중이었다면
(사용자가 방금 세션을 바꿨거나, 느린 회선이라 이전 이동의 `load`가 아직 안 왔거나) 그
무관한 `load`가 즉시 `go()`를 터뜨려서, **아직 세션을 놓지 않은 상태로** 새 탭이
`?session=`이 붙은 URL을 연다 — 이 커밋(`d191619`)이 고치려던 "두 클라이언트가 PTY
크기를 두고 싸우는" 버그가 그대로 재현된다. 2000ms 폴백도 해제 완료와 무관하게 발사된다.

**수정**: `load`에서 `frame.contentWindow.location.href === released`인지 확인하거나,
해제된 페이지가 준비 완료를 `postMessage`로 알리게 한다.

**[에이전트 보고]** 같은 파일의 `go()` 안 `tab.location.replace(url)`은 사용자가 팝아웃
탭을 먼저 닫았으면 던지는데 아무도 잡지 않는다. 파일의 나머지 방어적 스타일과 어긋난다.

## S14 (Low) — 온볼륨 supervisord 유닛의 프로그램 이름이 검증되지 않는다 **[에이전트 보고, 미확인]**

`script/entrypoint.sh`가 `/code/.local/share/code-docker/supervisord/`(홈 볼륨, 호스트에서
쓰기 가능)의 `.conf`에서 `[program:...]` 이름을 뽑아 root로 `mkdir -p "/var/log/$program"`
한다. `[program:../../etc/foo]` 같은 헤더는 `/var/log` 밖으로 나간다.

심각도가 Low인 이유는 CLAUDE.md가 이미 "그 디렉터리에 쓸 수 있으면 컨테이너 내 root"라고
명시하고 있어서 새 권한을 주지 않기 때문이다. 그래도 `case "$program" in */*|.*) continue;; esac`
한 줄은 공짜다.

## S15 (Low) — 여전히 핀되지 않은 `curl | sh` 체인 **[에이전트 보고, 미확인]**

09-07의 H4 수정(qwreey-fish를 SHA+sha256으로 핀)은 정확히 들어갔다고 확인됐다. 다만
**그 핀된 스크립트가 다시** fisher 설치 스크립트를 `curl | source`하고, floating 브랜치
플러그인 몇 개를 `fisher install`하고, `curl https://mise.run | sh`를 한다 — 전부 미핀,
전부 root, 새 `/code` 볼륨마다. 스크립트 주석이 스스로 "이번 수정 범위 밖"이라고
적어뒀는데, CLAUDE.md에서 참조되는 `.claude/backlog/*.md` 어디에도 없다. **"curl-pipe
문제는 고쳤다"로 기억이 굳을 위험**이 있으니 backlog 항목 하나가 필요하다.

## S16 (Low) — 기타 **[에이전트 보고]**

- `handleVncSocket`(`router/backend/handlers_vnc.go:353-447`)에 동시 브리지 수 제한이
  없다. 인증된 호출자가 fd/고루틴을 무제한 소모 가능
- `vhostpwa.Patch()`(`internal/vhostpwa/vhostpwa.go:153-166`)가 원격 manifest를
  `MaxBytesReader` 없이 JSON 디코드한다. 침해된 vhost 업스트림이 무한 바디를 흘릴 수 있음
- DNS 커스텀 호스트/블록리스트 dedup이 대소문자 구분(`customhosts.go:74-83`,
  `blocklist.go:132-143`). `Example.com`과 `example.com`이 별개로 저장되어 의도한 차단이
  조용히 무력화될 수 있음
- `router/frontend/src/embedTheme.ts:49-57`의 수신측에 `event.origin` 검사 없음
  (영향은 `data-theme` 토글뿐이라 실질 무해하나, 부모→자식 방향은 검사하므로 비대칭)
- `script/install-yay.sh` + `Dockerfile:47-52`가 `makepkg` 사용자와
  `/etc/sudoers.d/makepkg`(`NOPASSWD:ALL`)를 **최종 이미지에** 영구히 남긴다. 의도적일
  가능성이 높지만(yay는 root로 못 돈다) CLAUDE.md의 "의도적 트레이드오프" 목록에 없다
- `.dockerignore`가 `.env*`/`*.bak`를 제외하지 않는다. 지금은 `COPY`되지 않지만 백스톱이 없음
- `handlers_files.go:233`의 `var results []files.UploadResult`가 빈 업로드에서
  `{"results": null}`을 반환 — 이 프로젝트의 재발 버그 부류

---

# 3. 프로젝트 건전성

## P1 (High) — CI가 존재하지 않는다 **[직접 확인]**

```
$ ls .github/workflows        → 없음 (4개 서브모듈 전부 동일, node_modules 내부 제외)
$ find . -name '*_test.go' | wc -l  → 37
$ (webmanager/backend) go test ./...  → 전부 ok
$ (router/backend)     go test ./...  → 11개 패키지 전부 ok
$ (code-dind/dind-authz) go test ./... → ok
```

**테스트는 있고, 지금 돌려보니 전부 통과한다. 다만 아무도 자동으로 돌리지 않는다.**
`Makefile`도 없고, `go test`는 `README.md`·`CLAUDE.md`의 "Commands" 절·`docs/*.md`
어디에도 안 나온다 — 오직 `.claude/` 기획 문서 안에만 있다. 두 번째 메인테이너는
**테스트 스위트가 존재한다는 사실 자체를 발견할 방법이 없다.**

이 프로젝트는 스스로 "변화가 에이전트로 가속되어 빨라짐"(TODO.md)이라고 적어뒀다.
검증 수단이 "빌드해서 손으로 눌러본다"뿐인 상태에서 커밋 속도만 올라가는 건 위험한 조합이다.

**수정(비용 대비 효과 최대)**: `go test` 3개 모듈 + `gofmt -l` + `docker compose config` +
`bash -n script/*.sh config/**/*.sh` 를 도는 GitHub Actions 하나. 반나절이면 된다.
최소한 `CLAUDE.md`의 "Commands"에 `go test` 세 줄만이라도 적는다.

## P2 (High) — 본체에 healthcheck가 없다 **[직접 확인]**

```
$ grep -n 'healthcheck' docker-compose.yml
315:    healthcheck:      # ← code-docker-dind 하나뿐
```

`code-docker`, `code-docker-router`, `code-docker-netinit-docker`에 없다. code-server,
webmanager, nginx, sshd, dns-local이 supervisord 안에서 **전부 죽어도**
`docker compose ps`는 `code-docker`를 `Up`으로 보여준다. 새벽 3시에 운영자가 가장 먼저
보는 화면에 고장 신호가 안 뜬다는 뜻이다.

역설적으로 dind는 09-07 즈음 정확히 이 이유로 healthcheck를 얻었다 — "Up인데 라우트가
없는 상태"를 보이게 하려고. 같은 논리가 본체에 아직 적용되지 않았다.

**수정**: `code-docker`에 `supervisorctl status`가 전 프로그램 RUNNING인지 보는
healthcheck. 이 감사에서 가장 비용 대비 효과가 큰 운영 수정이다.

**곁다리**: `bin/restart`는 `setsid supervisorctl restart code &` 한 줄이라 성공/실패
신호가 전혀 없고, 출력은 곧 끊길 터미널로 간다. 재시작이 실패해도 조용하다.

## P3 (High) — OS 패키지가 전부 버전 미고정 **[직접 확인]**

`config/build/build.default.sh:3`:

```sh
pacman -Suy docker-compose docker-buildx gdb less supervisor openssh vim git git-lfs \
  base-devel cmake bash fish unzip zip yq gnupg vector nginx iproute2 dnsmasq --noconfirm
```

롤링 릴리스 저장소에 대해 핀이 하나도 없다. 오늘 빌드와 다음 달 빌드가 nginx·supervisor·
git의 **메이저 버전**부터 다를 수 있고, 락파일도 핀 메커니즘도 없다.

흥미롭게도 CLAUDE.md는 floating `#main` remote-git 참조의 위험은 (실제 사고 사례까지 들어)
길게 설명하는데, **이쪽은 한 줄도 언급하지 않는다.** 더 크고 더 조용한 위험인데 그렇다.
`script/install-yay.sh:20-24`의 AUR `yay-bin`도 `origin/master`를 fetch+reset한다.

(반면 JS/Go 쪽은 문제없다: `Dockerfile:27`이 `npm ci`를 쓰고 루트 `package-lock.json`이
workspace를 덮으며, Go는 `go.sum`이 정상이고 서브모듈은 정확한 SHA로 핀되어 있다.
**떠다니는 건 OS 패키지 계층과 remote-git `#main` 둘뿐이다.**)

## P4 (Medium) — `example-env`에 깨진 내부 링크 12개 **[직접 확인]**

모든 사용자가 `.env`로 복사해 위에서 아래로 읽는 파일이다.

router 추출 때 `docs/`로 옮겨간 것을 옛 경로로 가리킴 (8곳):
```
example-env:203,205  docs/dev-proxy.md        → 실제: router/docs/dev-proxy.md
example-env:223,276,282,285  docs/tailscale.md → 실제: router/docs/tailscale.md
example-env:348,375  docs/egress-netgate.md   → 실제: router/docs/egress-netgate.md
```
아카이브된 기획 문서를 backlog 경로로 가리킴 (4곳):
```
example-env:61,350,402  .claude/backlog/netinit-docker-plan.md   → 없음
example-env:348         .claude/backlog/egress-netgate-plan.md   → 없음
```
추가로 `docs/tips/roblox-studio.md:70`이 `config/netgate/firewall.default.sh`를 가리키는데
실제로는 `router/config/netgate/firewall.default.sh`다.

별개 문제: `example-env`가 애초에 사용자에게 `.claude/`·`router/.claude/` 내부 에이전트
기획 문서를 읽으라고 안내한다(총 11곳). 그건 사용자 대상 문서가 아니다.

(참고: `docs/*.md`들은 router 문서를 **전체 GitHub URL**로 올바르게 가리킨다. 문제는
`example-env`만이다.)

## P5 (Medium) — 볼륨 기본 경로에 `PREFIX`가 없다 **[직접 확인]**

```
docker-compose.yml:214  "${HOME_VOLUME:-./data/code}:/code"
:215  "${SSHD_VOLUME:-./data/sshd}:/etc/ssh"
:338  "${DIND_VOLUME:-./data/dind}:/var/lib/docker"
:351  "${DIND_AUTHZ_VOLUME:-./data/dind-authz}:/etc/dind-authz.d"
:539  "${ROUTER_VOLUME:-./data/router}:/var/lib/code-docker-router"
```

`PREFIX`는 컨테이너 이름과 네트워크 이름에는 붙지만 이 경로들에는 안 붙는다.
`docs/index.md`의 "여러 code-docker 인스턴스 사용" 절은 `container_name`/네트워크 충돌과
`ROUTER_HTTP_PORT` 충돌만 경고하고 볼륨은 언급하지 않는다.

즉 문서를 따라 한 디렉터리에서 `PREFIX`만 바꿔 두 인스턴스를 띄우면, 컨테이너 정체성은
완전히 분리되는데 **`/code`, SSH 호스트키, dind 저장소, dind-authz 정책, router 상태를
조용히 공유하고 서로 망가뜨린다.** 분리가 된 것처럼 보이는 게 더 나쁘다.

**수정**: 기본값을 `./data/${PREFIX}code` 식으로 바꾸거나, 최소한 "인스턴스마다 별도
디렉터리가 필요하다"를 문서에 명시한다.

## P6 (Medium) — CLAUDE.md 52,994바이트 **[직접 확인]**

`##` 레벨 섹션이 네 개(What this is / Commands / Architecture / Documentation)뿐이고,
router·webmanager·netshare·dind·code-patch·git-hooks가 **전부 하나의 `## Architecture`
안에 산문 단락으로** 들어 있다. 사실 하나를 찾으려면 사실상 전부 읽어야 한다.
netshare 단락 하나가 ~600단어이고 그 안에 `af86213` 사고 전말이 통째로 들어 있다.

두 가지 구조적 문제:

1. **서브모듈 CLAUDE.md와 수작업 중복.** `router/CLAUDE.md`·`webmanager/CLAUDE.md`·
   `code-dind/CLAUDE.md`가 다 있고 "자세한 건 거길 보라"고 하면서도, 루트가 같은 내용을
   상당한 깊이로 다시 서술한다(webmanager 절이 탭 ~15개를 나열한다). 저쪽이 바뀌면
   이쪽이 조용히 낡는 구조다.
2. **참조 문서와 엔지니어링 일지가 섞여 있다.** "This happened for real twice on
   2026-08-25", "verified both ways 2026-08-25" 같은 날짜별 사고 서사는 가치가 크지만,
   그건 이미 존재하는 `.claude/archive/*-done.md`의 역할이다. 매 세션 로드되는 참조
   문서에 인라인으로 있을 이유가 없다.

**참고로 정확도 자체는 높다.** 서브에이전트가 구체적 주장 10개를 코드와 대조했고 8개가
정확했다 (`entrypoint.sh:101`의 mkdir, `user-init.default.sh:116`, `code-patch.default.sh:33`,
`settings.default.json:16`, `start.sh:135`, `hook-dispatch`의 `--absolute-git-dir`,
`bin/restart`, `vector.default.toml:20` 전부 실제와 일치). 문제는 정확도가 아니라
**부피와 이중 관리**다.

## P7 (Medium~Low) — 그 외 **[에이전트 보고 + 일부 직접 확인]**

- **버스 팩터**: 서브모듈 4개 + 서브트리 1개(webmanager) + floating remote-git 1개,
  전부 같은 저자. 저장소 경계를 넘는 계약(`ROUTER_HOSTNAME` ↔ 별칭, `netinit.gateway`
  라벨 ↔ router compose가 만드는 컨테이너 이름)이 **산문으로만** 유지된다.
  타입 체크도 테스트도 경계를 넘지 않는다. CLAUDE.md가 기록한 `af86213` 사고가 바로 이
  부류이고, floating ref는 아직 그대로다 — 방어책은 "netshare 바꾸면 `--no-cache`로
  다시 빌드"라는 구전 지식뿐이다.
- **`.claude/` 문서가 사실상 두 번째 문서 시스템**: 3개 트리에 걸쳐 64개 안팎의
  archive/backlog/research 마크다운. `docs/`를 훑는 사람에게는 보이지 않고 인덱스도 없다.
- `NETFILTER_FIX_*` 폐기 유예 "one cycle"이 2026-08-25부터 3주+ 지났다. 끝낼지 결정할 시점.
- `TODO.md`가 레포 루트의 `expose.md`를 가리키는데 그 파일은 없다
  (`webmanager/.claude/archive/expose-plan-done.md`로 아카이브됨).
- `data/`가 워킹 트리에서 root 소유(`data/dind`는 `drwx--x---`)라 호스트 쪽에서
  들여다보려는 기여자가 sudo 없이 막힌다. 문서에 한 줄 없음.
- `docs/`가 100% 한국어다. 개인 프로젝트로서 당연한 선택이지만, "두 번째 메인테이너"
  이야기를 할 거라면 명시적으로 인정하고 가는 편이 낫다.
- `example-env`에 있으나 어떤 `docs/*.md`에서도 언급되지 않는 변수:
  `CADDY_ADAPTER_PORT`, `DEFAULT_UPSTREAM`, `ENABLE_IPV6`, `NETINIT_DOCKER_CONTEXT`,
  `PWA_DISPLAY_MODE`, `ROUTER_ENV_TEMPLATE_PATH`, `ROUTER_INTERNAL_SUBNET`.
  이 중 `DEFAULT_UPSTREAM`은 router의 catch-all 업스트림을 바꾸는 실제 동작 스위치다.
- `config/build/build.default.sh`만 `*.default.sh` 중 유일하게 `set -e`가 없다.
  지금은 문장이 하나뿐이라 무해하지만 관례에서 벗어난 유일한 예외다.
- `@xterm/xterm ^6.0.0`, `lucide-react ^1.28.0`은 각각 역사적으로 5.x / 0.x 계열이던
  패키지치고 이례적으로 이른 메이저다. 의도한 stable로 해석되는지 한 번 확인할 가치가 있다
  (xterm 메이저 재작성이면 `Terminal.tsx`가 이름으로 의존하는 내부
  `evaluateKeyboardEvent`/`_handleSingleClick` 등이 통째로 바뀐다).

---

# 4. 확인했고 문제 없던 것

후행 에이전트가 다시 파지 않도록 적는다.

**09-07 수정이 실제로 완전히 들어갔음을 재확인한 것**
- `internal/files/path.go`의 심볼릭 링크 탈출 수정 — 조상 경로 순회가 모든 깊이의
  탈출 링크를 거부하고, dangling 링크로의 쓰기도 거부하며, `mutate.go`의 `Move`/`Copy`가
  목적지 마지막 구성요소를 재해석한다. **잔여 구멍 없음**
- `dind-entrypoint.sh`의 `set -eu` vs 허용된 실패 버그 — 모든 호출 지점에 `|| true`가
  빠짐없이 적용됨
- dind-authz의 swarm/plugin 엔드포인트 계열 거부 + 파싱 실패 시 fail-closed, bind-mount
  `path.Clean` 검사, `local` 드라이버 `device=` 검사 — 전부 테스트 커버리지 포함
- router-manager 관리 API의 fail-closed 게이트 — 모든 변경 라우트가 `RequirePassword`
- WebDAV `Content-Disposition`/`nosniff` 강제, clone URL 스킴 허용목록

**새로 확인했고 깨끗한 것**
- sshd 기본값: 이 레포는 `PermitRootLogin`/`PasswordAuthentication`을 전혀 건드리지
  않고, Arch 기본 `sshd_config`는 해당 항목이 전부 주석 처리되어 있으며
  `99-archlinux.conf`는 `KbdInteractiveAuthentication no`/`UsePAM yes`/`PrintMotd no`만
  설정한다. 따라서 컴파일 기본값 `PermitRootLogin prohibit-password`(공개키만) 적용.
  root 비밀번호를 설정하는 코드가 없고, 22번 포트는 기본 미노출, 기본 `authorized_keys`를
  심는 스크립트도 없다. **기본값 안전**
- dind `daemon.json`: 레포 어디에도 존재하지 않는다. `dockerd`는 CLI 플래그로만 기동되고
  `builder.entitlements.security-insecure`를 켜는 곳이 없다
- `ootb-lib.sh`의 매니페스트: 실제로 `. "$_lm_manifest"`로 source되는 임의 셸 실행이
  맞지만 인라인 주석이 "사용자가 고른 레포를 어차피 빌드한다"로 명시한 의도적 트레이드오프고,
  하류의 `set_env_var`는 `sed`가 아니라 `awk -v`를 써서 해시 값의 정규식 재해석을 피한다.
  **별도 eval/exec 문맥으로 새는 필드 없음**
- `internal/supervisor`에 `exec.Command`가 **0건** — 전부 유닉스 소켓 XML-RPC.
  `stringParam`이 `xml.EscapeText`를 적용하고 모든 `StartProcess`/`StopProcess` 호출자가
  하드코딩 리터럴을 쓴다
- `tinyauthusers/store.go`: 이름 문자셋 검증, 해시 `shellQuote` 후 bash source, 원자적
  쓰기, 0600/0700 권한, 손상/누락 시 fail-closed(500, 조용한 빈 쓰기 없음)
- OSC 52 리플레이 필터(`internal/termsession/oscfilter.go`): 상태 기계가 정확하고,
  링 버퍼 **진입 전** 바이트에 적용되며, 청크 경계 분할을 테스트가 덮고, 입력 슬라이스를
  변형하지 않는다. `Terminal` 컴포넌트당 xterm 인스턴스가 하나뿐이라 백그라운드 세션이
  몰래 클립보드를 탈취할 수 없음
- webmanager `main.go` 전체 라우트 감사: 9월 추가분(WebDAV 설정, AI trailer, 대화형
  로그인) 포함해 **게이트 없는 쓰기 라우트 0건**
- `sshkeys`/`knownhosts`/`sshhosts`: SSH config·authorized_keys 줄에 닿는 모든 필드가
  `\r`/`\n` 검사를 거친다. 지시어 주입 경로 없음
- `aitrailer.go`가 `Name`/`Email`을 `<>\n\r\x00`에 대해 검증. git hook의
  `--absolute-git-dir` 해석이 자기 재귀를 정확히 피하고 awk 재작성이 멱등
- netgate CIDR/포트 검증(`net.ParseCIDR`/`net.ParseIP`)이 iptables 플래그/셸 주입을
  완전히 차단. 규칙 순서(stateful ACCEPT → forward ACCEPT → CIDR block)가 문서와 일치
- tailscale CLI 호출 전부 argv 기반, 셸 보간 없음
- `targetguard.Validate`/`SelfHosts`가 중괄호/개행/공백을 차단하고 devproxy·approutes의
  모든 Create/Update와 `handleVncSocket`의 연결별 재검사에 적용됨
- `ROUTER_VHOST_*`/PWA의 호스트·업스트림·manifest 경로·아이콘 경로는 문자셋 검증됨
  (S12의 다른 변수들과 대조적)
- router `static.go` 순회 안전 + `Cache-Control` 수정이 webmanager에서 이식될 때 유실되지
  않음. `novncHandler`가 빈 경로/디렉터리 목록 거부
- `vhostpwa`에 독립적 SSRF 없음(업스트림이 서버측 설정 전용), 문자열 결합이 아니라
  `encoding/json` 재마샬
- 프론트엔드: 리뷰한 모든 diff에 `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`Function()`
  없음. `postMessage` 송신 3곳 전부 명시적 target origin(`*` 없음). 9월에 추가된
  localStorage 키 3개는 전부 UI 설정 플래그. 태블릿 키 전달은 사용자 자신의 물리 입력만
  재생하므로 서버 데이터가 합성 이벤트로 흐르지 않음. 이벤트 리스너 정리 누락 없음
- `internal/claudecode`/`claudememory`의 경로 순회 방어가 정규식+접두사 이중 확인이고,
  게이트 없는 memory 라우트도 `IsKnownPath`로 경계지어짐
- 비밀 커밋 이력: `git log --all --diff-filter=A`로 `.env`/`.pem`/`.key`/`id_rsa`/
  `credentials.json` 스캔 → 0건. 토큰 패턴(`ghp_`/`sk-ant-`/`AKIA`/`tskey-`) 스캔 →
  플레이스홀더 1건뿐. `node_modules` 미커밋, `.allow-test` 정상 무시,
  `.gitignore`/`.dockerignore` 드리프트 없음
- `bin/`과 `script/`의 모든 파일에 살아있는 호출 지점이 있다 — 고아 스크립트 없음
- vector 파이프라인은 문서대로 실제로 동작한다 (전 프로그램의 `stdout.log*`/`stderr.log*`
  수집 → 라벨링 → 자기 stdout + JSONL)
- `supervisord.d/*.conf`의 우선순위(vector=1, 나머지 100)가 문서화된 근거와 일치하고,
  vector 자신을 제외한 전 프로그램에 로그 로테이션이 있다
- 범위 내 모든 셸 스크립트가 `bash -n` 통과. 신뢰된 `mise env` 출력에 대한 것 외에
  맨 `eval` 없음. `rm -rf $VAR` 부류의 미인용 파괴 패턴 없음
- `gofmt -l` / `go vet` 클린, Go 테스트 3개 모듈 전부 통과

---

# 5. 미확인 (다음 사람이 짚을 것)

- **S11의 실제 악용 가능 여부** — vendored tinyauth 바이너리가 실제로 내보내는
  `Set-Cookie`의 `Domain` 값. 호스트 단위 스코프면 무해, 부모 도메인이면 유효.
  실기에서 응답 헤더 한 줄이면 결론난다
- `/app/<name>` 경계에 대한 퍼센트 인코딩 순회(`/app/code/%2e%2e/...`) — nginx는
  인코딩된 세그먼트를 그대로 넘기고 `approutes.go`/Caddyfile 템플릿에 재검증이 없다.
  Caddy 자체가 일반적으로 이 부류에 견고하므로 정적 읽기만으로는 판정 불가.
  **실행 중인 인스턴스에 `curl` 한 번**이 필요
- S10/S13/S14/S15/S16 및 P7 중 "에이전트 보고" 표시 항목의 근거 줄 재확인
- `migrate-continue.sh`의 `.bak` 덧붙이기 동작 (내가 직접 보지 않음)

---

# 6. 권장 순서

**즉시 (작고, 영향 큼)**
1. **D1** — 기본 브랜치를 `main`으로. 이건 코드 수정이 아니라 설정 한 줄인데, 지금
   외부인이 이 프로젝트를 설치하면 받는 물건이 무엇인지를 통째로 바꾼다. 이 목록에서
   가장 비용 대비 효과가 크다
2. **S1** — nginx `proxy_set_header X-Real-IP` + 두 `clientKey()`. 수십 줄. 인증 없는
   원격 DoS가 막힌다. 겸사겸사 `TODO.md`의 열린 항목이 닫힌다
3. **P2** — `code-docker`에 healthcheck
4. **S9** — `cssEscape` 한 줄
5. **S6** — `chmod 600`

**곧**
6. **S2/S3/S4** — `code-server-autoinstall`의 설치 로직. 임시 디렉터리 + `curl -f` +
   `pipefail` + 버전 핀/자동 업데이트 opt-out. 서브모듈이므로 저쪽에 커밋 후 bump
7. **P1** — CI 하나. `go test` 3개 + `gofmt -l` + `docker compose config` + `bash -n`
8. **S5** — dind-authz `UsernsMode`. 서브모듈, 테스트 필수
9. **S7/S8** — targetguard 적용, netgate v4 고정 차단
10. **P4** — 깨진 링크 12개 (기계적)

**여유 될 때**
11. S10/S12 — 게이트 재검토, `validate_nginx_token()` 통일
12. P3 — 최소한 CLAUDE.md에 "OS 패키지는 핀되지 않는다"를 명시. remote-git `#main`에
    이미 준 만큼의 정직함을 여기에도
13. P5 — 볼륨 경로에 `PREFIX` 또는 문서 명시
14. P6 — CLAUDE.md 분할. 사고 서사는 `.claude/archive/`로, 참조는 주제별 파일로
15. S13~S16, P7

**문서 동기화 (CLAUDE.md 자체 규칙)**
- S1 → `docs/webmanager-config.md`의 authgate 설명
- S7 → `router/docs/router.md`
- S2 → `docs/code-server-patch.md` 또는 `docs/build-customization.md`
- P5 → `docs/index.md`의 "여러 code-docker 인스턴스 사용"
- S15 → `.claude/backlog/`에 항목 신설
