# 프로젝트별 Git 상태 패널 — 구현 완료

`gitconfig-plan-done.md`(같은 폴더)가 다루는 "전역 git 설정"(user/email, 커밋
사이닝, SSH 호스트, HTTPS credential, git-lfs, `.gitconfig` 원본 편집)과는
완전히 별개 기능 — 이건 **프로젝트 하나의 실제 git 저장소 상태**(브랜치/변경
사항/커밋 로그/diff)를 읽어 보여주는 패널이다. 이 문서가 그동안 없었던 게
이번 정리의 발견 사항 — 신규 기능인데 별도 설계 문서 없이 한 라운드로
구현됐다.

## 기능

- staged/changed/untracked/behind/ahead/diverged/stashed/conflicts 요약
- 커밋 로그(커서 페이지네이션)
- 커밋별 diff, 미변경(unstaged)/스테이지(staged) diff — 직접 만든 +/- 라인
  색칠, 새 의존성 없음
- 리모트/브랜치/태그 조회

**읽기 전용만 구현** — 스테이징/커밋/push·pull/merge·rebase 도구는 다음
마일스톤으로 보류(착수 안 함, 별도 계획 문서 없음).

## 어떻게 동작하는가 (`internal/projectgit`)

- `git status --porcelain=v1 -b` 파싱 로직은 이 기기의 fish 셸 프롬프트
  헬퍼(`~/.config/fish/functions/quiteline-fish/_qtm_git_info.fish`)의
  분류 규칙을 그대로 이식 — 새로 설계하지 않고 이미 검증된 분류를 재사용.
- 모든 함수가 `path`를 그대로 받되, 호출자(`handlers_projectgit.go`)가
  Projects 캐시(`internal/projects.Scanner.IsKnownPath`)와 정확히 일치하는
  경로인지 먼저 검증한 뒤에만 `git` 셸아웃 — `internal/projects`의
  `DeleteReclaimable`/`DeleteProject`와 동일한 경로 검증 관례.
- 모든 git 호출에 5초 타임아웃(`gitTimeout`) — 로컬 read-only 조회라 여유
  있게 잡음, 예산이 아니라 안전장치.
- `handleProjectGitStatus`는 git 저장소가 아닌 프로젝트를 에러로 취급하지
  않고 `{"isGitRepo": false}`로 응답 — 프론트가 git 패널을 조용히 숨길 수
  있게.
- 모든 엔드포인트는 읽기 전용이라 `gate.RequirePassword` 없음(이 앱의
  reads-open/writes-gated 원칙 그대로, 자세히는
  `archive/authgate-plan-done.md`).

## API

`GET /api/projects/git/status`, `GET /api/projects/git/log`,
`GET /api/projects/git/diff/commit`, `GET /api/projects/git/diff/unstaged`,
`GET /api/projects/git/diff/staged`, `GET /api/projects/git/remotes`,
`GET /api/projects/git/branches`, `GET /api/projects/git/tags` — 전부
`path` 쿼리 파라미터 필수, Projects 캐시의 정확한 경로만 허용. 정확한 스펙은
`webmanager/backend/README.md`가 원본.

## 프론트

`src/components/common/Git/` — `GitStatusPanel`/`GitLogSheet`/
`GitChangesSheet`/`GitRemotesSheet`/`GitBranchesSheet`/`GitTagsSheet`/
`DiffView`. 프로젝트 경로 하나만 받는 형태로 `common/`에 의도적으로 위치 —
Projects 탭 전용이 아니라, 파일 매니저 리워크 등 다른 곳에서도 프로젝트
경로만 넘기면 재사용 가능하게 분리해둔 것.

## 검증 상태

`go build`/`go vet`/`gofmt` + `npm run build`/`npm run lint` 통과 확인.
실제 git 저장소가 있는/없는 프로젝트 양쪽에서 패널을 열어보는 실컨테이너
QA는 아직 — 저장소 소유자가 직접 확인 필요.
