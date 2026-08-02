# Supervisor 관리 — 완료

## 업데이트 (2026-08-02, 두 번째 라운드)

- **프로그램별 메타데이터**: `config/supervisor-metadata.default.yaml`(override
  패턴) + `internal/supervisor.LoadMetadata`가 `GET /api/supervisor/processes`
  응답에 프로그램별 `label`/`note`/`disableStart`/`disableStop`/
  `disableRestart`/`disableLogs`를 병합. `vector`는 `disableLogs: true` 기본
  설정(자신의 로그를 웹에서 볼 필요 없다는 이유 — Logs 탭이 이미 그 내용을
  보여줌). 프론트는 이 플래그로 버튼을 비활성화 + 이유를 노트로 표시.
- **로그 다이얼로그/바텀시트**: 이전 라운드에 이미 완료(공용 `Sheet` 컴포넌트
  재사용) — 유지.
- **비밀번호 게이트**: start/stop/restart(쓰기)와 프로그램별 로그 조회(읽기)
  전부 게이트됨 — 자세히는 `.claude/authgate-plan-done.md`.

## 기능

supervisord 프로그램 목록 조회, start/stop/restart, 프로그램별 stdout/stderr 로그
조회.

## 어떻게 동작하는가

- `internal/supervisor`: `/run/supervisor.sock`에 대고 hand-rolled XML-RPC 클라이언트
  (표준 라이브러리 `encoding/xml` + `net/http`의 unix-socket `DialContext`, 서드파티
  XML-RPC 의존성 없음). supervisord RPC 문서 기준 필요한 메서드만: `getAllProcessInfo`,
  `startProcess`, `stopProcess`, `readProcessStdoutLog`/`readProcessStderrLog`.
- `GET /api/supervisor/processes`, `POST /api/supervisor/processes/{name}/start|stop|
  restart`, `GET /api/supervisor/processes/{name}/log?stream=stdout|stderr&tail=N`.
- restart는 stop(NOT_RUNNING fault 허용) 후 start. supervisord의 fault code를 HTTP
  상태로 매핑: BAD_NAME→404, ALREADY_STARTED/NOT_RUNNING→409(원래 400이었다가
  review.md에서 통일).
- 로그 조회는 offset 0 + 넉넉한 length로 전체를 읽은 뒤 클라이언트 쪽에서 tail
  슬라이싱(supervisord RPC에 "마지막 N바이트" 개념이 없어서).

## 겪었던 문제와 해결

- **`stdout_logfile=/dev/fd/1`일 때 로그 조회 RPC가 100% 실패함** — seek 불가능한
  파이프라 supervisord의 `readProcessStdoutLog`가 동작 안 함. vector 도입과 함께
  모든 program의 stdout/stderr를 실제 회전 파일로 바꾸면서 해결됨(`vector-logs-
  plan-done.md` 참고). 지금은 정상 동작.
- **프론트 확인창 누락(critical, review.md에서 발견)**: 시작/정지/재시작에 confirm이
  없어서 webmanager 자기 자신이나 sshd를 실수로 정지시키면 복구 수단이 없어지는
  문제였음 — 고침(모든 액션에 confirm, webmanager/sshd 정지는 추가 경고).

## 프론트

`src/components/Supervisor/` — 4초 간격 폴링 테이블, 상태별 색상 배지, 로그 패널
(stdout/stderr 토글).
