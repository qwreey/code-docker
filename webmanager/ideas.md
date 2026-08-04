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
- **환경변수/dotfiles 뷰어**: user-init이 건드리는 fish 설정이나 `.bashrc` 등을 굳이
  터미널 없이 훑어보고 싶을 때
- **direnv `.envrc` allowlist 관리**: `direnv allow` 상태를 UI에서 확인/토글
- **설정 백업/내보내기**: webmanager가 관리하는 파일들(ssh keys, gitconfig, tailscale
  config 등)을 한 번에 export/import — 컨테이너 재생성 시 복원 편의
- **Docker 레지스트리 로그인**: dind 데몬이 쓰는 `~/.docker/config.json` (사설
  레지스트리 로그인 정보) — dind 컴포넌트(`.claude/dind-plan.md`) 작업 시 같이
  고려하면 자연스러움

## code-server 설정(settings.json 등) 편집 UI — 후순위로 내림

익스텐션 추천/설치 부분은 `.claude/archive/extensions-plan-done.md`로 승격/구현 완료돼서
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

<!--
  구 "locale/timezone 설정" 절은 삭제함(2026-08-03) — webmanager UI로 만드는
  대신 그냥 docker-compose.yml 환경변수로 넘기는 쪽으로 확정, TZ가 이미 하던
  방식 그대로(LANG도 추가함, docker-compose.yml의 environment 절 주석 참고).
  webmanager UI 기능으로서는 더 이상 브레인스토밍 대상 아님.
-->

## 사용자 세션 뷰어 — 추후 구현, 실현 가능성부터 확인 필요

`webmanager/.claude/archive/session-viewer-plan.md` 참고 — 착수 전 리서치/실현 가능성
확인이 필요해서 별도 계획 문서로 분리함(여기 브레인스토밍 목록에는 포인터만).

## mise opt-out 플래그 — 검토했으나 보류 (2026-08-03)

Tailscale의 `TAILSCALE_ENABLED`처럼 mise 자체도 옵트아웃 가능하게 만들어보자는
아이디어가 있었으나, 재검토 결과 **구현하지 않기로 함** — 대안이 마땅치 않아서
opt-out 자체의 실익이 낮다고 판단(mise 없이 도구를 설치/관리할 뾰족한 대체 경로가
없고, 여전히 유저가 mise를 안 쓰는 선택 자체는 override 패턴만으로 이미 가능함, 아래
참고). "good to have"를 넘는 우선순위는 아니라고 결론.

- code-docker 자체(스크립트 레벨)는 이미 opt-out 가능한 구조라는 것만 확인해둠 —
  `grep mise -r script`가 아무 것도 안 걸림, 즉 `script/*.sh`는 mise를 하드코딩하지
  않고 전부 override 패턴을 통해 유저가 정의한 `config/*.override.sh`를 존중한다.
  mise를 안 쓰고 싶은 사람은 mise를 호출하는 `default.sh`들(`code-runner.default.sh`
  등)을 override로 갈아끼우기만 하면 됨 — 새로 만들 것 없이 이미 되는 얘기.
- webmanager 쪽만 갭 — Mise 탭과 Claude 탭의 mise 기반 UI(설치/버전확인/업데이트
  버튼)는 mise 존재를 가정하고 만들어짐(`webmanager/.claude/archive/claude-plan-done.md` 참고).
  이번 라운드에서 이 갭을 메우지 않기로 함.
- 혹시 나중에 필요해지면: `WEBMANAGER_MISE_FEATURES=false`류 환경변수 하나로 Mise
  탭 자체와 Claude 탭의 설치/버전확인 UI를 숨기는 정도가 제일 저비용인 방향으로
  보임 — 다만 이것도 설계된 적 없는 순수 아이디어, 착수 전 다시 논의 필요.
