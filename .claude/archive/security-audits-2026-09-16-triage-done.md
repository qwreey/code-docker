# 2026-09-16 감사 3건 트리아지 (완료)

2026-09-16에 저장소 루트에 `-ignoreme` 접미사로 쌓여 있던 감사 보고서 3건
(`security-audit-ignoreme.md`, `audit-claude-opus5-2026-09-16-ignoreme.md`,
`audit-antigravity-2026-09-16-ignoreme.md`)을 2026-09-28 기준 실제 코드와 대조해
트리아지했다. 셋 다 untracked/gitignore(`~/.config/git/ignore`의 전역
`*-ignoreme*` 패턴)였고, `git log --all`에 이 파일들의 이력이 전혀 없어 순수히
로컬 산출물이었다.

민감정보(비밀키/토큰/실제 운영 호스트명·IP/개인정보) 스캔 결과 **셋 다 없음** —
등장하는 IP는 전부 RFC1918/루프백/클라우드 메타데이터 같은 일반 예시뿐이고, 실명
도메인·프로덕션 호스트명·토큰 패턴(`ghp_`/`sk-ant-`/`AKIA`/`tskey-`)은 0건. 따라서
원문 그대로 아래 경로로 옮겼다(레다크션 없음):

- `.claude/archive/security-audit-2026-09-16.md` (구 `security-audit-ignoreme.md`)
- `.claude/archive/audit-claude-opus5-2026-09-16.md`
- `.claude/archive/audit-antigravity-2026-09-16.md`

옮긴 새 경로는 저장소 `.gitignore`에 걸리는 패턴이 없다(`*-ignoreme*`는 저장소
`.gitignore`가 아니라 사용자 전역 gitignore에 있던 패턴이라, 접미사를 뗀 순간
더 이상 적용되지 않는다 — `git check-ignore -v`로 재확인함).

이 트리아지 작업 자체는 코드를 하나도 고치지 않았다. 열린 항목은
`.claude/archive/security-audit-2026-09-16-open-done.md`에 별도로 정리했다.

## 읽는 법

- 세 보고서가 상당 부분 겹쳐서, 겹치는 내용은 하나의 ID로 합쳤다.
- **FIXED**: 커밋/파일:줄로 확인. **WONTFIX(설계)**: CLAUDE.md 등 기존 문서의
  의도적 트레이드오프로 이미 선언됨. **OPEN**: 지금 코드에서 재현/확인됨(추측
  아님). **UNCLEAR**: 코드만으로 결론 못 냄, 무엇을 보면 되는지 적음.
- 2026-09-07 정적 검토(`.claude/archive/security-review-2026-09-07-done.md`)의
  C1/C2/C3/H1~H4는 2026-09-14 커밋(code-docker `8725c12`, router-docker
  `354cd6d`, dind-authz-docker `b599216`)으로 전부 수정·라이브 검증까지 끝난
  상태다 — 이번 세 보고서도 그 전제를 깔고 새 항목만 냈다(Opus 5 보고서는 명시,
  나머지 둘은 일부 재확인).

## 감사 대상 저장소 스냅샷 (2026-09-28)

| 저장소 | 확인한 커밋 |
|---|---|
| code-docker | `021e697` (main) |
| router-docker | `816b5ac` (dev/router-docker, main) |
| dind-authz-docker | `9ae3e7c` (dev/dind-authz-docker, main) |
| router-docker-client | `01ecc5e` (dev/router-docker-client, main) |
| code-server-autoinstall | `0c0e74e` (dev/code-server-autoinstall, master) |

## 종합 표

| ID | 요지 | 출처 | 상태 | 근거 |
|---|---|---|---|---|
| F01 | 기본 배포가 `0.0.0.0:80`+`auth: none`+webmanager 게이트 off로 무인증 노출 | A-SEC01, C-SEC08 | WONTFIX(설계), 부분 개선 | CLAUDE.md "Security-relevant, intentional trade-offs"(`auth: none`, 게이트 off-by-default 명시). `ootb.sh`가 이제 webmanager/router-manager 비밀번호를 둘 다 물어봄(router는 기본 y) — 감사 시점 대비 개선 |
| F02 | dind-authz 바인드 마운트 검증이 심볼릭 링크 미해석 | A-SEC02, C-SEC01 | **OPEN (Critical)** | `dev/dind-authz-docker/dind-authz/policy.go:319-331` `bindSourceAllowed`, `path.Clean`만 사용, `EvalSymlinks` 없음 - 재확인 |
| F03 | 빈 `ALLOWED_HOSTS` + WS Origin==Host 검사만으로 DNS 리바인딩 방어 불충분 | A-SEC03, C-SEC07 | OPEN (Medium) | `config/nginx/nginx-service.default.sh:24-39`(기본 빈값), `webmanager/backend/handlers_terminal.go:89,388`·`router-docker/backend/handlers_vnc.go:403`의 `websocket.Accept(w,r,nil)` 그대로 |
| F04 | webmanager 상태변경 API에 CSRF/Origin 방어 없음 | A-SEC04 | **OPEN (High)** | `webmanager/backend/*.go` 전체 grep, `Sec-Fetch-Site`/`CSRF`/`X-Requested-With` 0건 |
| F05 | `TRUSTED_PROXIES` 설정 시 nginx `deny` 규칙이 realip 모듈에 의해 우회 가능 | A-SEC05 | OPEN (Medium, 운영자 설정 의존) | `config/nginx/nginx-service.default.sh`의 `real_ip_header`/`set_real_ip_from` 구조 자체는 변경 없음. 실제 영향은 `TRUSTED_PROXIES`에 과도하게 넓은 대역을 등록해야 발동 |
| F06 | webmanager 파일 매니저가 `.ssh`/`.git-credentials`/`.claude.json` 등을 그대로 서빙 | A-SEC06 | WONTFIX(설계) | CLAUDE.md의 webmanager 절 - 파일 루트가 곧 `/code`(홈)이고, 보호는 opt-in authgate + 바깥 forward-auth 몫이라고 명시 |
| F07 | netgate 방화벽 30초 주기 `iptables -F` 재적용이 원자적이지 않음 | A-SEC07, C-SEC02 | **OPEN (Medium)** | `dev/router-docker/config/netgate/firewall.default.sh`의 `ensure_chain`/`apply_rules` 구조 그대로 |
| F08 | 원격 GitHub `#main` 플로팅 브랜치 + unpinned 스크립트 빌드 | A-SEC08, C-SEC05 | **부분 FIXED** | `docker-compose.yml`/`Dockerfile` 확인 결과 `router-docker`(v0.1.1)·`dind-authz-docker`(v0.1.0)·`code-server-autoinstall`(v0.1.0)는 태그 고정으로 전환됨(커밋 `78201fc`, 2026-09-2x 리팩터). **`router-docker-client`(netshare/dns-local/netinit-docker)만 여전히 `#main` 플로팅** - 가장 고권한(도커 소켓+SYS_ADMIN+NET_ADMIN+호스트 netns) 소비자라 잔여 위험은 남음. backlog에는 F08로 별도 기재하지 않고 이 표에만 남김(고권한 쪽은 F09 WONTFIX 설계 범위 안에서 이미 문서화됨) |
| F09 | netinit-docker의 과도한 호스트 권한(docker.sock+SYS_ADMIN+NET_ADMIN+host netns) | A-SEC09 | WONTFIX(설계) | CLAUDE.md "docker-compose 토폴로지" 절 - ":ro 마운트는 완화가 아니다", "cap이 넓히는 건 blast radius이지 trust ceiling이 아니다"라고 명시적으로 트레이드오프 서술 |
| F10 | `origin/HEAD`가 6주(이제 8주+, 커밋 400개+) 묵은 `master`를 가리켜 문서대로 클론하면 router/dind-authz/09-07 수정이 전부 빠진 스택이 설치됨 | B-D1 | **OPEN (Critical)** | `git symbolic-ref refs/remotes/origin/HEAD` → 여전히 `refs/remotes/origin/master`(2026-08-02 커밋). `docs/index.md:8`의 clone 명령에 `--branch` 없음 - 둘 다 재확인 |
| F11 | webmanager authgate 잠금 버킷이 전역 하나(nginx가 실제 IP를 안 넘김) → 인증 없는 전원 영구 잠금 가능 | B-S1 | **OPEN (High)** | `webmanager/backend/handlers_auth.go:15-21` `clientKey`가 `r.RemoteAddr` 그대로, nginx의 webmanager `proxy_pass` 블록 어디에도 `X-Real-IP` 세팅 없음 - 재확인. router의 동일 문제(09-07 H2)는 이미 고쳐짐(`rateLimitKey`가 X-Real-IP 사용). `.claude/archive/authgate-client-ip-blind-spot-done.md`(2026-09-06)가 이 비대칭을 이미 추적 중이었고, "webmanager도 같은지 확인 필요"라는 미해결 질문의 답이 이번에 "그렇다"로 확정됨 |
| F12 | code-server가 런타임에 `releases/latest`를 버전 핀/체크섬/opt-out 없이 root로 자동 설치 | B-S2 | **OPEN (High)** | `dev/code-server-autoinstall/install.sh` - `CODE_SERVER_VERSION`/autoupdate 끄는 옵션 없음, 재확인 |
| F13 | install.sh가 다운로드 **전에** 기존 설치를 삭제 | B-S3 | **OPEN (High)** | `install.sh:37-40` - `rm -rf`가 `curl -fL` 앞에 그대로 있음(다운로드 curl 자체는 `-fL`로 개선돼 있음) |
| F14 | install.sh 버전 확인 curl에 `-f` 없어 5xx도 성공 취급, 신규 설치에서 아무것도 안 깔고 exit 0 가능 | B-S4(본문 표기) | OPEN (Medium) | `install.sh:21` `curl -s`(플래그 `-f` 없음), 31행의 `[ "x$LATEST" == "x$CURRENT" ]` 로직 그대로 |
| F15 | dind-authz가 `UsernsMode`를 검사하지 않고 `/containers/{id}/exec`도 정책 대상 밖 | B-S5(본문), C-SEC10 | **OPEN (Medium)**, exec 부분은 UNCLEAR | `dind-authz/policy.go`의 `createBody.HostConfig`에 `UsernsMode` 필드 자체 없음, `decide()`가 create/volumes-create만 다룸 - 재확인. exec의 `Privileged` 필드가 실제 도커 버전에서 권한을 상승시키는지는 미검증 |
| F16 | `.env*`가 644(world-readable 비밀 해시) + migrate 백업이 무한정 append | B-S6(본문) | **OPEN (Medium)** | `.env`/`.env.router`/`.env.webmanager` 전부 644 확인, `migrate-continue.sh:165`의 `cat ... >> ... .bak` 확인 |
| F17 | netgate forwards/tailscale publish가 targetguard 허용목록을 안 거침(self-SSRF, dind 소켓 tailnet 노출) | B-S7(본문) | **OPEN (Medium)** | `netgate/config.go`의 `validateHost`는 문자셋뿐, `tailscale/config.go:73`은 `SelfHosts`만 검사 - 재확인. 09-07 이후 두 API 다 비밀번호 게이트 뒤라 원격 공격은 아님 |
| F18 | router의 인증 없는 GET들이 내부 토폴로지/VNC 접속자 PII를 노출 | B-S7/S8(본문) | **OPEN (Medium)** | `router-docker/backend/main.go`의 `/api/dev-proxy/exposes`, `/api/app-routes/apps`, `/api/vnc/targets/{name}/clients`, `/api/dns/*`, `/api/netgate/*` GET들이 여전히 `gate.RequirePassword` 없음(라우트 목록 재확인). `tailscale/status`만 09-07에 게이트됨 |
| F19 | 폰트 CSS 주입(`cssEscape`가 백슬래시 미이스케이프) | B-S8/S9(본문) | **OPEN (Medium)** | `webmanager/backend/internal/fonts/fonts.go:242-244` 그대로 |
| F20 | netgate `ReplaceOutbound`에 IPv4 최소 차단선 없음(`PUT [] `로 RFC1918 차단 전체 삭제 가능) | B-S9/S10(본문) | **OPEN (Medium)** | `netgate/config.go:228` `ReplaceOutbound` - CIDR 형식 검사만, 하한선 로직 없음. v6는 `firewall.default.sh`에 고정 차단이 있음 |
| F21 | tinyauth 세션 쿠키가 vhost/exports/app 대상에 그대로 전달됨 | B-S10/S11(본문) | **OPEN (코드), UNCLEAR (실제 악용)** | `nginx.default.conf`의 쿠키 제거 맵이 `router_manager_unlock`만 처리(재확인, tinyauth 쿠키 스트립 코드 0건). 실제 영향은 vendored tinyauth의 `Set-Cookie: Domain` 스코프에 달림 - 미확인 |
| F22 | 일부 env var가 nginx 지시어에 검증 없이 삽입(`ROUTER_MANAGER_HOSTS`/`TINYAUTH_HOSTS`/`ALLOWED_HOSTS`/`TRUSTED_PROXIES`/`ROUTER_INTERNAL_SUBNET`) | B-S11/S12(본문) | OPEN (Low) | `nginx-service.default.sh`의 해당 루프들이 `xargs` 트림만 하고 문자셋 검사 없음(`ROUTER_VHOST_*`는 검증함) - 재확인. 운영자 전용 입력이라 실질 긴급도 낮음 |
| F23 | webmanager-launcher.default.js 위젯 팝아웃의 `load` 이벤트 경합으로 세션 해제 전 새 탭이 열림 | B-S12/S13(본문) | **OPEN (Medium, 기능 버그)** | `config/code/code-patch/webmanager-launcher.default.js:207-223` 코드 동일 |
| F24 | 온볼륨 supervisord 유닛의 `[program:...]` 이름이 검증 없이 `/var/log/$program`에 쓰임 | B-S13/S14(본문) | OPEN (Low) | `script/entrypoint.sh:113-116` - 경로 traversal 가드 없음. CLAUDE.md가 이미 "그 볼륨에 쓸 수 있으면 컨테이너 내 root"라 새 권한은 아님 |
| F25 | qwreey-fish SHA 핀 이후에도 fisher/mise.run이 여전히 unpinned root curl\|sh | B-S14/S15(본문) | OPEN (Low) | `config/user-init/user-init.default.sh` 주석이 스스로 인정, 09-07 H4 수정 범위 밖으로 명시돼 있었음 |
| F26 | 기타 소소한 결함 모음(VNC 동시 연결 제한, vhostpwa MaxBytesReader, DNS dedup 대소문자, embedTheme origin 검사, makepkg sudoers 문서화 누락, .dockerignore .env 제외 누락, files nil slice→null) | B-S15/S16(본문) | OPEN (Low, 클러스터) | 각각 재확인 완료 - backlog 참고 |
| F27 | CI가 전혀 없음(테스트 37개+는 있고 통과하지만 자동 실행 안 됨) | B-P1 | **OPEN (High)** | `.github/workflows` 전 저장소에 없음 - 재확인 |
| F28 | code-docker/router 본체에 healthcheck 없음(dind만 있음) | B-P2 | **OPEN (High)** | `docker-compose.yml`에 `healthcheck:` 1곳(dind)뿐 - 재확인 |
| F29 | pacman -Suy가 전부 버전 미고정, 문서에도 언급 없음 | B-P3 | OPEN (Medium, 문서화 누락에 가까움) | `config/build/build.default.sh:3` 그대로. floating `#main`은 CLAUDE.md가 길게 다루는데 이쪽은 언급 없음 |
| F30 | `example-env`의 내부 문서 링크 12곳이 깨져 있음 | B-P4 | **부분 FIXED** | 커밋 `cee9884`("link router docs by URL instead of through the submodule path")로 일부는 전체 GitHub URL로 교체됨(예: `egress-netgate.md`). 다만 `docs/dev-proxy.md`/`docs/tailscale.md` 식의 모호한 참조와 `.claude/backlog/netinit-docker-plan.md`(실제로는 `.claude/archive/netinit-docker-plan-done.md`로 아카이브됨) 참조는 여전히 남아 있음 |
| F31 | 볼륨 기본 경로에 `PREFIX`가 없어 다중 인스턴스가 `/code`·SSH 호스트키·dind 저장소를 공유 | B-P5 | **OPEN (Medium)** | `docker-compose.yml`의 `HOME_VOLUME`/`SSHD_VOLUME`/`DIND_VOLUME`/`DIND_AUTHZ_VOLUME`/`ROUTER_VOLUME` 기본값에 `${PREFIX}` 없음 - 재확인 |
| F32 | CLAUDE.md가 53KB 단일 파일(지금은 59,958바이트로 더 커짐), 서브모듈 CLAUDE.md와 수작업 중복 | B-P6 | OPEN (Low, 계속 커지는 중) | `wc -c CLAUDE.md` = 59958 |
| F33 | 기타 프로젝트 건전성 낮은 우선순위 항목(버스 팩터, `.claude` 문서 파편화, `NETFILTER_FIX_*` 폐기 유예 만료, `TODO.md`의 죽은 링크, `data/` root 소유권 미문서화, docs 전량 한국어, 미문서화 env var들, `set -e` 예외 1곳, 패키지 메이저 버전 이례적 상승) | B-P7 | OPEN (Low, 클러스터) | 개별 backlog 항목화하지 않고 이 표에만 남김 - 전부 문서/유지보수성 이슈로 보안 임팩트 없음 |
| F34 | `/api/auth/setup`이 비게이트라, 외부 인터넷 이용자가 최초 구동 시 소유자보다 먼저 router-manager 비밀번호를 선점할 수 있는 창이 있음 | C-SEC03 | **OPEN (High, 창 좁음)** | `router-docker/backend/handlers_auth.go`의 `handleAuthSetup`이 설계상 게이트 밖. 09-07 리뷰 C2(커밋 `354cd6d`)는 **내부 네트워크발** 접근만 막았고, 2026-09-28 `816b5ac`(front-door guard)도 외부 정상 인터페이스는 그대로 허용 - 둘 다 이 시나리오를 막지 않음을 직접 코드로 확인. `ootb.sh`의 기본 `y` 프롬프트로 창은 좁아졌으나 남아 있음 |
| F35 | `targetguard.SelfHosts`가 루프백을 정확 문자열로만 비교(127.0.0.2/0.0.0.0/다형성 표기 우회 가능) | C-SEC04 | OPEN (Low-Medium, 옵트인 조건부) | `targetguard.go`의 `SelfHosts` 맵 정확 매치 확인. 실제 도달하려면 `*_ALLOW_EXTERNAL_TARGETS=true`(문서화된 "디버그 전용" 옵션)가 필요해 기본 배포에선 도달 불가 |
| F36 | 동일 origin의 관리자 쿠키(`router_manager_unlock` 등)가 신뢰 낮은 App Route/vhost 콘텐츠의 same-origin JS fetch에는 여전히 노출됨 | C-SEC06 | WONTFIX(설계 인지됨), 완화 수단 opt-in | `nginx.default.conf` 자신의 주석이 "이건 백엔드가 원시 헤더를 읽는 경로만 막지, 같은 origin에서 도는 스크립트의 same-origin fetch는 막지 않는다"고 명시. 실제 완화 수단(`ROUTER_MANAGER_HOSTS`/`ROUTER_VHOST_*`로 origin 분리)이 이미 구현/문서화되어 있으나 기본값은 아님 |
| F37 | 리소스 제한(CPU/메모리) 기본값이 0(무제한) | C-SEC09 | WONTFIX(설계, 이미 env로 열려 있음) | 메모리 노트("CPU/mem resource limits added 2026-08-10") - env-configurable이고 "0" sentinel이 의도된 무제한 기본값. `docker-compose.yml`의 `deploy.resources.limits` 확인 |

## 다음 단계

- 열린 항목(F02~F35 중 OPEN 표시)의 상세·심각도·수정 방향은
  `.claude/archive/security-audit-2026-09-16-open-done.md` 참고.
- UNCLEAR로 남긴 두 가지(F15의 exec 권한상승 여부, F21의 tinyauth 쿠키 Domain
  스코프)는 실행 중인 인스턴스에서 한 번만 확인하면 결론난다 - 다음에 손댈 때
  같이 확인할 것.
- F08(router-docker-client 잔여 floating `#main`)과 F29(pacman 미고정 미문서화)는
  즉시 코드 수정이 필요한 항목이라기보다 "문서화/의사결정" 항목에 가까워
  backlog에 개별 항목으로 만들지 않고 이 표에만 남겼다 - 나중에 논의 필요하면
  이 문서를 근거로 쓸 것.

## 후속 (2026-09-28)

같은 날 F02·F04·F10(문서 부분)·F11·F12/F13/F14·F15·F19·F24를 수정했다 — 커밋과
버전은 `.claude/archive/security-audit-2026-09-16-open-done.md` 상단 목록 참고. F02와
F11은 수정 전에 테스트 스택에서 직접 재현해 확인했다. 위 표의 상태 열은 트리아지
시점(수정 전) 기준이다.
