# Tailscale forwards/publish 관리 — 완료

**주의**: 이 문서는 webmanager UI 기능 얘기. tailscaled/포워딩 자체의 인프라
설계(userspace networking, 자동 노출 문제 등)는 `.claude/archive/
tailscale-design.md`(레포 루트) — 프로젝트 전체에 걸친 내용이라 webmanager
전용이 아님.

## 업데이트 (2026-08-02, 두 번째 라운드)

쓰기(config PUT, forwards/publish의 POST·DELETE)에 비밀번호 게이트 적용됨,
읽기는 그대로 열림 — 자세히는 `.claude/archive/authgate-plan-done.md`.

## 기능

`/code/.tailscale/config.yaml`의 `forwards`/`publish` 항목 조회/추가/삭제,
전역 설정(`socksAddress`/`retryInterval`) 조회/수정.

## 어떻게 동작하는가

- `internal/tailscale`: `gopkg.in/yaml.v3`로 YAML r/w — 이 라운드에서 추가된
  유일한 새 의존성. 파일 전체를 typed struct로 왕복시키므로 **기존 파일의
  주석은 사라짐**(webmanager가 이 파일을 관리하게 된 이후로 받아들인 트레이드오프).
- 모든 뮤테이션(전역 설정 저장, forward/publish 추가/삭제)은 성공적으로 파일을
  쓴 뒤 `tailscale-forward` supervisord program을 재시작함(`bin/forward-reload`와
  동일 효과) — 기존 `internal/supervisor` 클라이언트 재사용, stop 시
  NOT_RUNNING fault 허용.
- **로그인 플로우(`tailscale up`, 로그인 URL 획득/표시)는 의도적으로 범위 밖**.
  이미 `tailscale-status.default.sh`(2초 간격 폴링) +
  `config/code-patch/tailscale-notify.default.js`(`window.CDDialog` 배너)가
  code-server 화면에서 담당하고 있어서 중복 구현 안 함. webmanager UI에도 상태를
  띄우는 건 TODO로만 남겨둠(`webmanager/plan.md` 참고).

## 겪었던 문제와 해결

- **뮤테이션 부분 실패 시 UI 상태 불일치(`.claude/archive/webmanager-review.md` (레포 루트))**: 디스크 쓰기는 성공했는데
  재시작만 실패하면 프론트가 "실패"로만 보여주고 목록을 안 새로고침해서 실제
  디스크 상태와 어긋날 수 있었음. **고침**: 성공/실패 관계없이 뮤테이션 후 항상
  목록 재조회.

## API

`GET/PUT /api/tailscale/config`, `GET/POST /api/tailscale/forwards`,
`DELETE /api/tailscale/forwards/{name}`, `GET/POST /api/tailscale/publish`,
`DELETE /api/tailscale/publish/{name}` (`mode`는 `tcp`/`tls-terminated-tcp`).

## 프론트

`src/components/Tailscale/` — `GlobalSettings`/`Forwards`/`Publish` 서브섹션,
로그인 상태는 code-server 배너를 보라는 안내 문구만 표시. 뮤테이션 후 "저장됨
(tailscale-forward 재시작됨)" 트랜지언트 알림.

## 업데이트 (2026-08-05): 서브탭 분리 — 구현 완료

페이지가 너무 길어지고, "아래 상태 카드는 조회 전용입니다 — forwards/publish
설정을 관리하려면 이어지는 섹션을 사용하세요" 같은 안내 문구로 스크롤을
유도하기보다 Task Manager의 성능/프로세스 서브탭과 같은 패턴으로 나누는 게
낫다는 실사용 피드백 반영(`Tailscale/Tailscale.tsx`, `Tailscale.css`).
우측 상단에 탭 버튼 2개:

- **기본 설정**: `Status`(로그인/피어 상태) + `GlobalSettings`(전역 설정,
  앞으로 늘어날 전역 설정도 여기로) — "신원/설정" 성격.
- **포워드 / 퍼블리시**: `Forwards` + `Publish` — "트래픽 방향" 성격.

두 그룹의 성격이 충분히 달라서(하나는 상태 조회+전역 설정, 다른 하나는 개별
항목 CRUD) 나누는 이점이 있다는 판단. sshd 자동 노출 경고 배너는 두 탭 모두에
해당하는 내용이라 탭 밖(공통 영역)에 그대로 둠.

`npm run build`/`npm run lint` 클린. 브라우저로 직접 확인은 안 함.
