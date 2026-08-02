# webmanager 아이디어 (미확정 브레인스토밍)

개발 환경을 세팅할 때 반복적으로 손이 가는 것들 중, webmanager UI로 옮기면 편할 것
같은 후보들. **여기 있는 건 아직 계획 문서(`webmanager/.claude/*-plan.md`)로 승격
되지 않은, 순수 브레인스토밍만** — 실제로 설계/착수 단계에 들어간 건 개별 계획
문서로 옮겨지고 여기서는 빠짐(예: 컨테이너 리소스 추적, 익스텐션 추천/설치,
Claude Code 탭, Caddy dev-proxy는 전부 `webmanager/.claude/`로 이동함). 실현
가능성 순으로 정렬, 후순위로 내린 항목은 이유를 남겨둠(지웠다가 나중에 왜 안 했는지
몰라서 다시 논의하는 걸 막기 위함).

## 바로 할 만한 것들 (기존 패턴 재사용, 별도 조사 불필요)

이미 만든 git credentials/ssh keys 관리와 거의 같은 모양(파일 읽고 쓰기, 마스킹, CRUD
폼)이라 새로 조사할 게 없는 것들.

- **패키지 매니저 인증/레지스트리 설정**: `~/.npmrc` (private registry, 토큰),
  `~/.cargo/config.toml`, pip/uv 인덱스 설정 등 — git credentials와 비슷한 패턴.
  이제 `.gitconfig` 원본 편집에 쓰는 공용 `CodeEditor`(`src/components/common/`)가
  있어서, 구조화 폼 없이 "파일 읽고 원자적으로 쓰기 + 저장 전 검증"만 필요하면
  더 가볍게 만들 수 있음(`internal/gitconfig/raw.go`가 그 패턴의 참고 예시).
- **GitHub CLI 연동**: `gh auth login` 토큰 상태 조회/설정 (git credential store와
  겹치는 부분이 있어 통합 여지 있음)
- ~~**known_hosts 관리**~~ — **구현 완료** (2026-08-02, `gitconfig-plan-done.md`
  참고): `~/.ssh/known_hosts` 조회/추가(raw 라인 붙여넣기)/삭제, 쓰기는 비밀번호
  게이트 적용됨.
- **환경변수/dotfiles 뷰어**: user-init이 건드리는 fish 설정이나 `.bashrc` 등을 굳이
  터미널 없이 훑어보고 싶을 때
- **direnv `.envrc` allowlist 관리**: `direnv allow` 상태를 UI에서 확인/토글
- **설정 백업/내보내기**: webmanager가 관리하는 파일들(ssh keys, gitconfig, tailscale
  config 등)을 한 번에 export/import — 컨테이너 재생성 시 복원 편의
- **Docker 레지스트리 로그인**: dind 데몬이 쓰는 `~/.docker/config.json` (사설
  레지스트리 로그인 정보) — dind 컴포넌트(`.claude/dind-plan.md`) 작업 시 같이
  고려하면 자연스러움

## code-server 설정(settings.json 등) 편집 UI — 후순위로 내림

익스텐션 추천/설치 부분은 `.claude/extensions-plan-done.md`로 승격/구현 완료돼서
빠짐 — 여기 남은 건 "settings.json/keybindings.json 자체를 편집하는 UI" 얘기만:

- JSON 파일 하나 텍스트 편집이야 `<textarea>`로도 되지만, 그럴 거면 이미 code-server가
  훨씬 나은 편집 경험(구문 강조, 자동완성, 설정 스키마 검증)을 제공하고 있어서 굳이
  webmanager에서 또 만들 이유가 약함
- **(2026-08-02 업데이트) Monaco 도입 여부는 더 이상 막는 조건이 아님** — git
  raw-config 편집/파일 매니저용으로 이미 가벼운 CodeMirror 6 기반 공용 에디터
  (`src/components/common/CodeEditor.tsx`)가 만들어져서, "에디터 컴포넌트가
  없어서 못 한다"는 이유는 해소됨. 그래도 결론은 그대로 유지 — code-server 자체
  설정 스키마 검증/자동완성까지 흉내내는 건 여전히 무게 대비 효용이 낮아 보이고,
  단순 텍스트 편집이면 code-server 통합 에디터를 쓰는 게 이미 더 나은 경험이라
  webmanager에서 중복으로 만들 이유가 약함(진짜 필요해지면 CodeEditor 재사용은
  가능하니 착수 비용 자체는 낮아진 상태).
- 결론: 여전히 보류 — 다만 "만들려면 얼마나 걸리나"라는 질문의 답은 훨씬
  가벼워졌다는 것만 기록.

## locale/timezone 설정 — 후순위로 내림

컨테이너 로케일/타임존을 재빌드 없이 바꾸고 싶다는 아이디어였는데, 따져보니 깔끔하게
구현하기 까다로움:

- 컨테이너 안에서 바꾼 값이 볼륨 마운트(`./code:/code`) 밖(예: 시스템 전역 `/etc/`)에
  저장되면 컨테이너 재생성 시 날아감 — 홈(`/code`) 안에 저장하면 되긴 하는데, 그러면
  XDG 스펙(`XDG_CONFIG_HOME` 등) 경로 규약을 따라야 함
- 모든 도구가 XDG 스펙을 지키는 것도 아니라서, 결국 `TZ`/`LANG` 같은 환경변수로 넘겨줘야
  하는 케이스가 생기고, 그러려면 "값이 바뀔 때마다 동적으로 다시 읽어서 env로 주입하는"
  세터를 하나 더 만들어야 함
- 쉽게 만들 수는 있는데(어려운 기술 문제는 아님), 여러 계층(파일 저장 위치, XDG 대응
  여부, env 주입 타이밍)이 얽혀서 결과물이 깔끔하지 않을 가능성이 높음 — 다시 설계할
  시간에 다른 항목을 먼저 하는 게 나아 보여서 후순위로 내림
