# 2026-09-16 감사 3건 트리아지 - 열린 항목

2026-09-16에 작성된 감사 보고서 3건(security-audit-ignoreme.md / Claude Opus 5 /
Antigravity, 아카이브: `.claude/archive/security-audit-2026-09-16.md`,
`audit-claude-opus5-2026-09-16.md`, `audit-antigravity-2026-09-16.md`)을 코드
기준으로 재검증한 결과 아직 열려 있는 항목만 모았다. FIXED/WONTFIX 처리된 항목과
근거는 `.claude/archive/security-audits-2026-09-16-triage-done.md`의 표를 참고.

모두 2026-09-28 기준 실제 코드(`dev/router-docker`, `dev/dind-authz-docker`,
`dev/router-docker-client`, `dev/code-server-autoinstall`, code-docker 본체)를
직접 읽어 확인했다. 악용 절차가 아니라 문제의 종류와 위치만 적는다.

## 2026-09-28에 처리한 항목 (이 목록에서 뺐음)

- F02 dind-authz 심볼릭 링크 우회 — 재현 후 수정: dind-authz-docker `v0.1.1`
  (bind source를 EvalSymlinks로 풀어 재검증, 검사↔마운트 사이 레이스는 잔존 — 코드 주석)
- F15 `UsernsMode=host` — dind-authz-docker `v0.1.2`
- F11 webmanager 잠금 전역 버킷 — code-docker `d1f747e` (loopback 바인드 + nginx
  `X-Real-IP` + `authgate.ClientKey`)
- F04 webmanager CSRF — code-docker `21df74b` (`http.CrossOriginProtection`)
- F12/F13/F14 autoinstall — code-server-autoinstall `v0.1.1` (스테이징 후 교체,
  오프라인 기동, `CODE_SERVER_VERSION` 핀), code-docker `602a1ab`
- F19 폰트 CSS 이스케이프, F24 온볼륨 유닛 이름 — code-docker `35b0391`
- F10 — 문서의 clone 명령에 `-b main` (`a5b488a`). **GitHub 기본 브랜치 설정은
  아직 master** — 저장소 설정 변경이 필요(gh 미인증이라 에이전트가 못 함).
- (관련) router 앞문이 형제 격리망에서 열려 있던 문제 — router-docker `v0.1.1`.
  F34는 이것과 범위가 다르다(외부망 최초 구동 레이스).

- 2026-09-29, router-docker `v0.1.2` (code-docker `ROUTER_REF` bump):
  - F34 첫 비밀번호 설정에 컨테이너 로그의 1회용 setup 토큰 요구 (`4a8dbca`)
  - F07 netgate 규칙을 `iptables-restore --noflush`로 원자 교체, F20 v4 고정 차단
    (loopback/link-local/0.0.0.0/8) + RFC1918 block 삭제 PUT 거부 (`11ec7eb`)
  - F17 forwards/tailscale publish에 targetguard 허용목록, dind:2375/2376 전면 거부,
    F35 루프백 판정을 IP 파싱으로 (`63d3d82`)
  - F18 관리용 GET 전부 게이트 뒤로 (`df70c22`)
  - F21 실측(tinyauth v5.1.3는 부모 도메인 쿠키) 후 Caddy/nginx가 대상 홉에서
    `tinyauth-*` 쿠키 제거 (`8be0932`)
  - F22 nginx에 들어가는 env 값 검증 (`ef69358`)
  - F03 빈 `ALLOWED_HOSTS` = 로컬 전용, migrate가 물어봄 (router `981ecfb`, code-docker 같은 날)
- 2026-09-29, code-docker:
  - F16 `.env*`를 600으로(`set_env_var`/ootb 생성 직후/migrate가 기존 배포도 조임),
    migrate 백업은 `<file>.bak.<시각>` 최근 5개(`ootb-lib.sh` `backup_env_file`)
  - F28 code-docker/router에 supervisord 상태 healthcheck (router는 router-docker
    커밋만, 태그+`ROUTER_REF` bump 전까지 배포엔 안 들어감)
  - F31 문서(docs/index.md) + `ootb-config.sh`가 PREFIX 설정 + 기본 볼륨 경로일 때 경고
    (기본 경로는 안 바꿈 - 기존 배포가 빈 볼륨으로 뜸)
  - F26 묶음 전부: router VNC 브리지 32개 상한(`cd2c8a0`), vhostpwa manifest 1 MiB
    (`0679303`), DNS 대소문자 정규화(`d4f657e`), embedTheme 부모 창/출처 검사(`ec07373`) -
    router-docker 커밋만, 태그 전. webmanager 업로드 `[]`, CLAUDE.md makepkg 트레이드오프,
    `.dockerignore` `.env*`/`*.bak*` - code-docker.
  - F23 위젯 팝아웃이 세션을 쥔 문서가 실제로 사라진 `load`에서만 새 탭을 이동

---

## F27 [High] code-docker - CI가 전혀 없음

- **결정(2026-09-29)**: 혼자 main에 바로 커밋하는 흐름이라 push 후에 도는 GitHub Actions는
  막는 게 없다. 대신 `./dev-check.sh`(go test/gofmt/bash -n/compose config, 옵션으로 깨끗한
  worktree에서) + CLAUDE.md Commands에 명시 + `dev-clone.sh`가 까는 pre-push 훅. 등급도
  이 상황에선 Low.

- **저장소/위치**: 루트 및 `dev/router-docker`, `dev/dind-authz-docker`,
  `dev/code-server-autoinstall`, webmanager 어디에도 `.github/workflows` 없음(재확인).
- **문제**: Go 테스트가 37개 이상 있고 지금 돌리면 전부 통과하는데 아무도 자동으로
  돌리지 않는다. 두 번째 메인테이너는 테스트 스위트가 존재한다는 사실 자체를 발견할
  방법이 없다(`README.md`/`CLAUDE.md`의 Commands 절 어디에도 `go test`가 없음).
- **방향**: `go test` 3개 모듈 + `gofmt -l` + `docker compose config` + `bash -n
  script/*.sh config/**/*.sh`를 도는 GitHub Actions 워크플로 하나.

## F25 [Low] code-docker - qwreey-fish SHA 핀 이후에도 fisher/mise.run이 여전히 unpinned root curl\|sh

- **저장소/위치**: `config/user-init/user-init.default.sh` 12-23행 주석이 스스로 인정 —
  SHA+sha256으로 핀된 `qs_setup.fish`가 다시 fisher 설치 스크립트를 `curl | source`하고
  floating 브랜치 플러그인을 `fisher install`, `curl https://mise.run | sh`를 실행.
- **문제**: 전부 미핀, 전부 root, 새 `/code` 볼륨마다 반복. "curl-pipe 문제는 고쳤다"로
  기억이 굳을 위험(qwreey-fish 핀만 보이고 이건 안 보임).
- **방향**: 최소한 이 backlog 항목으로 존재를 남긴다(요청받은 조치). 실제 고정은
  qwreey-fish 핀과 같은 방식(SHA+체크섬)을 fisher/mise.run에도 적용하거나, mise는
  자체 버전 핀 메커니즘이 있으니 그걸 쓰도록 전환.
