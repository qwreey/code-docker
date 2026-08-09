# .claude/ 지식 구조 (레포 전체용 — webmanager 전용은 `webmanager/.claude/`)

이 폴더는 이 레포에서 작업하는 (사람이든 에이전트든) 누군가가 컨텍스트를 필요한 만큼만
읽을 수 있도록, 문서를 "지금 당장 필요한 것"과 "필요할 때만 찾아보는 것"으로 나눠둔
곳이다. 매번 전부 읽을 필요는 없다 — 아래 안내를 보고 지금 하려는 작업에 맞는 것만
열어보면 된다.

**webmanager만을 위한 계획/설계 문서는 여기가 아니라 `webmanager/.claude/`에 따로
있다** — webmanager 관련 작업은 그쪽 인덱스(`webmanager/.claude/README.md`)를 볼 것.
여기(레포 루트 `.claude/`)는 webmanager에 국한되지 않는, 레포 전체에 걸친 것만 담는다.

## 구조

- **`archive/`** — 이미 실행/구현이 끝났거나(또는 애초에 참고용 조사 기록), "왜
  이렇게 결정했는지" 전체 논증 과정이 궁금할 때만 열어보는 문서. 현재 상태 파악에는
  필요 없음.
  - `webmanager-review.md` — (`webmanager/review.md`를 옮김) webmanager 전체
    코드베이스에 대한 보안/버그 리뷰 라운드 기록 — 나온 이슈는 전부 고쳐졌거나
    각 기능의 `webmanager/.claude/*-plan-done.md`에 흡수됨. webmanager 전용
    내용이지만, "완료돼서 더 이상 안 바뀌는" archive 성격상 다른 webmanager
    문서들과 달리 여기(레포 루트 archive)에 둠.
  - `home-structure-plan.md` — `$HOME`(`/code`)에 흩어져 있던 `.tailscale`,
    `.vector`, `.webmanager`, `.server` 등을 `$HOME/.local/share/code-docker/`
    단일 umbrella로 정리 + `user-init` 실행 위치/`set -e` 이전 +
    `code-server` → `code` 네이밍 통일까지 구현 완료 — 현재 상태는 루트
    `CLAUDE.md`, 판단 과정은 이 문서
  - `caddy-nginx-integration-plan.md` — Dev Proxy(내부 Caddy)를 별도 포트
    대신 in-container nginx의 `/exports/` 프리픽스를 통해서도 도달 가능하게
    만든 설계 — 구현 완료, 지금은 `docs/dev-proxy.md`의 "바깥 리버스 프록시
    연결하기" 절이 최신 사용자 문서
  - `router-nginx-docs-todo-done.md` — `router/.claude/router-nginx-hardening-plan.md`
    구현이 끝난 뒤 stale해진 문서(docs/router.md, docs/dev-proxy.md, 루트
    `CLAUDE.md`, `webmanager/CLAUDE.md` 등)를 정리한 체크리스트 — 전부 완료(2026-08-10)
  - `router-frontend-decouple-plan-done.md` — webmanager에서
    `@code-docker/router-frontend` 의존 제거 조사 기록. 문서 자체의 원래
    결론("지금은 못 뗀다")과 달리 실제로는 2026-08-08 데카플링에서 바로
    실행되어 완료됨 — 최신 설계는 `router/CLAUDE.md`/`webmanager/CLAUDE.md`
    참고

- **`backlog/`** — 아직 착수하지 않은 브레인스토밍/아이디어(webmanager에 국한되지
  않는 것). `archive/`와 달리 "완료된 것"이 아니라 "언젠가 할 수도 있는 것" — 실제로
  작업을 시작할 때 참고
  - `code-patch-widgets.md` — `window.CDDialog` 기반 브라우저 위젯 아이디어 (상태
    표시줄, 확인창, 리소스 미터 등 code-server 패치 쪽)
  - `pastebin-integration.md` — 외부 pastebin 연동 아이디어 (초기 메모 수준)
  - `agent-fleet-audit-plan.md` — 병렬 Claude Code 에이전트 컨테이너를
    제한된 git 계정으로 격리하면서 뭘 시도했는지 기록을 남기는 방법 조사
    (세션 트랜스크립트/훅/OTel 등, 착수 전 질문 다수)
  - `readme-revamp-plan.md` — README.md 재단장(뱃지, 소개 문단 다듬기)
    아이디어 — 문서 콘텐츠 자체를 `docs/`로 옮기는 작업(2026-08-05)은 이미
    끝났고, 이건 그 다음 단계

- **webmanager 전용 계획/설계**: `webmanager/.claude/` — 완료된 기능은
  `*-plan-done.md`, 아직 안 한 건 `*-plan.md`. 인덱스는 그 폴더의 `README.md`.

- **router 전용 계획/설계**: `router/.claude/` — `functional-router-plan.md`(전체
  비전/결정 사항), `router-dns-plan.md`(DNS 포워딩 + 블록리스트 설계),
  `archive/tailscale-design.md`(code-docker 안에서 tailscale을 돌리던 시절의 원본
  설계, 참고용). 인덱스는 `router/plan.md`.

- **살아있는 문서(이 폴더 밖)**: 각 서브프로젝트 폴더에 그대로 둠, 항상 최신 상태 유지
  - `webmanager/plan.md`, `webmanager/CLAUDE.md`, `webmanager/ideas.md`,
    `webmanager/.claude/question.md`, `webmanager/backend|frontend/README.md`
  - 루트 `CLAUDE.md` — 레포 전체 아키텍처, 항상 최신

## 새 지식을 추가할 때

- webmanager에만 해당하는 것 → `webmanager/.claude/` (완료 여부에 따라 `-plan-done.md`
  / `-plan.md`)
- 레포 전체에 걸치는, 아직 안 끝난 작업의 설계/아이디어 → 여기 `backlog/`
- 레포 전체에 걸치는, 라운드/논의가 끝나서 "현재 상태" 문서로 흡수됐지만 판단 과정
  자체는 남겨두고 싶은 것 → 여기 `archive/` (흡수한 "현재 상태" 문서 쪽에 반드시
  archive 경로를 가리키는 포인터를 남길 것 — 안 그러면 나중에 아무도 못 찾음)
- 지금 당장 유효한 스펙/상태 → 해당 서브프로젝트 폴더의 `plan.md`/`README.md` 등에
  직접 (여기로 옮기지 말 것 — 자주 갱신되는 문서는 코드 옆에 있어야 최신성이 유지됨)
