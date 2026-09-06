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
  - `git-trailer-rewrite-plan-done.md` — 에이전트 커밋의 `Co-Authored-By` trailer를
    사용자가 정한 이름/이메일로 치환하는 전역 git 훅 — 구현 완료(2026-09-04). git
    래퍼가 아니라 훅으로 간 이유, 그리고 원안이 놓쳤던 3가지(에디터 이전에 도는
    `prepare-commit-msg`만으로는 rebase reword를 못 잡는다 / 전역 `core.hooksPath`가
    저장소의 훅을 *전부* 죽인다 / 기본값은 꺼짐이어야 한다)가 실측 근거와 함께
    문서 끝에 정리돼 있음
  - `vnc-connected-clients-plan-done.md` — router VNC 대상에 지금 누가 붙어 있는지
    보고 끊는 기능 — 구현 완료(2026-09-06). 원안이 놓쳤던 두 가지(`reconnect=1`
    때문에 그냥 끊으면 즉시 재접속된다 / router-manager는 유닉스 소켓 뒤라 애초에
    클라이언트 IP를 못 보고 있었다)가 문서 앞머리에 정리돼 있음
  - `webdav-file-share-plan-done.md` — 다른 기기에서 파일 업/다운로드용 WebDAV
    공유 — 구현 완료(2026-09-04). 원안이 틀렸거나 부족했던 5가지(fail-closed를
    라우트 미등록이 아니라 요청별 판단으로 / env는 초기값이 아니라 항목별 고정 /
    argon2id 캐시가 없으면 클라이언트가 요청마다 64 MiB를 태워서 못 씀 /
    `ROUTER_VHOST_*`는 경로 없는 upstream이라 전용 nginx 리스너가 필요했음 /
    심볼릭 링크는 `webdav.Dir`가 안 막음)와, 증상별 디버깅 가이드가 문서 끝에 있음
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
  - `router-vnc-tab-plan-done.md` — router의 VNC 탭(브라우저에 GUI 컨테이너
    화면을 임베드) 아이디어 → 리서치(wayvnc/neatvnc 성능 실태, KasmVNC/
    Guacamole/Selkies 비교) → 경로 B-1 결정 → 구현까지의 전 과정. 문서 앞머리에
    완료 요약이 붙어 있음 — 현재 상태는 `router/CLAUDE.md`의 "VNC" 절과
    `router/docs/vnc.md`. Selkies 전환과 `wayvnc --gpu` 하드웨어 인코딩은 이
    문서 안에 트리거 조건과 함께 백로그로 남아 있음(실사용 중 성능 문제를
    겪으면 그때)

- **`browser-qa-notes.md`** — claude-in-chrome으로 이 스택에 실제로 붙어 QA를 돌릴 때
  필요한 것들(도구 로딩, 접속 URL, 재빌드하면 게이트가 다시 잠긴다는 점, 측정
  스크립트 함정). 한 번 알아내는 데 시간이 꽤 든 것들이라 남겨둠.

- **`qa-checklist.md`** — 에이전트가 구현/배포까지 끝냈지만 사람이 직접 눌러봐야
  아는 항목들의 **누적 체크리스트**. 한 번에 몰아서 확인하려고 배치로 쌓는 곳 —
  확인이 끝나면 지우고 결과를 해당 plan 문서에 반영한다. (기능 단위로 "QA만 남은"
  문서는 webmanager 쪽 `webmanager/.claude/qa-request/`에 따로 있음. 이 파일은
  그것과 달리 여러 기능에 걸친 짧은 확인 항목들을 모으는 용도)

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
  - `repo-restructure-plan.md` — submodule 4개(router/code-dind/envmigrate/
    code-server-autoinstall)를 원격 참조로 바꾸고 개발용 `dev/` 폴더를 두는 계획.
    "Compose가 원격 include를 지원한다", "ARG를 ADD의 source로 쓸 수 있다" 두 전제를
    실측으로 확인해둔 문서 (2026-09-03)
  - `qa-batch-2026-09-03.md` — 사용자 QA 제보 11건의 원인 분석 + 수정 방향.
    `CS_DISABLE_PROXY`가 사라졌다는 전제가 틀렸다는 정정과, 그럼에도 실재하는
    구멍(`remote.autoForwardPorts`)이 여기 있음

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
