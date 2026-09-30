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
- F10 — 문서의 clone 명령에 `-b main` (`a5b488a`). GitHub 기본 브랜치도
  `main`으로 바뀌어 있음(2026-09-30 `git ls-remote --symref origin HEAD`로 확인).
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
  - F28 code-docker/router에 supervisord 상태 healthcheck (router는 router-docker `v0.1.3`)
  - F31 문서(docs/index.md) + `ootb-config.sh`가 PREFIX 설정 + 기본 볼륨 경로일 때 경고
    (기본 경로는 안 바꿈 - 기존 배포가 빈 볼륨으로 뜸)
  - F26 묶음 전부: router VNC 브리지 32개 상한(`cd2c8a0`), vhostpwa manifest 1 MiB
    (`0679303`), DNS 대소문자 정규화(`d4f657e`), embedTheme 부모 창/출처 검사(`ec07373`) - router-docker `v0.1.3`. webmanager 업로드 `[]`, CLAUDE.md makepkg 트레이드오프,
    `.dockerignore` `.env*`/`*.bak*` - code-docker.
  - F27 대체: `./dev-check.sh`(+`--clean[=rev]`), `dev-clone.sh`가 pre-push 훅 설치,
    CLAUDE.md Commands. router `tinyauthusers/store.go` gofmt도 정리(`27b38cd`)
  - F25 qwreey-fish `c33d083`: fisher/플러그인은 커밋, mise는 릴리스+sha256, mise 도구는
    버전으로 고정, 범프는 그쪽 `scripts/bump-pins.sh`(upstream diff 검토) + `test-setup.sh`.
    code-docker는 `./dev-bump-qwreey-fish.sh`로 옮기고 `--self`로 qwreey-fish 자신도 고정.
  - F23 위젯 팝아웃이 세션을 쥔 문서가 실제로 사라진 `load`에서만 새 탭을 이동

---
