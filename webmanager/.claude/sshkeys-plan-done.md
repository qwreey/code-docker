# SSH authorized_keys 관리 — 완료

## 기능

`/code/.ssh/authorized_keys` 목록 조회/추가/삭제, fingerprint/타입/comment 표시.

## 어떻게 동작하는가

- 경로 확정 과정: 컨테이너가 `HOME=/code`, root(uid=0)로 실행되고
  `sshd_config`의 `AuthorizedKeysFile`이 `.ssh/authorized_keys`(상대경로)라서
  실제 경로는 `/code/.ssh/authorized_keys` — 컨테이너에 직접 접속해서 확인함.
  최초 실행 시 `/code/.ssh` 자체가 없어서 최초 키 추가 시 디렉토리(0700)/파일
  (0600) 권한을 맞춰 생성해야 함(sshd가 권한 검사, 안 맞으면 로그인 거부).
- `golang.org/x/crypto/ssh`의 `ssh.ParseAuthorizedKey`/`ssh.FingerprintSHA256`으로
  파싱/fingerprint 계산 — 이 기능을 위한 유일한 서드파티 의존성.
- `id`(URL 경로용 안전한 식별자)는 raw key bytes의 SHA-256 hex — fingerprint
  문자열(`SHA256:...`)과는 별개로, comment 차이는 무시하고 키 재질 자체로 중복 판단.

## API

`GET/POST /api/ssh/keys`, `DELETE /api/ssh/keys/{id}`. 에러는 `{"error":...}` +
4xx(중복은 review.md에서 409로 통일).

## 프론트

`src/components/SshKeys/` — 목록(타입/comment/fingerprint), 삭제(confirm),
붙여넣기 폼(400 검증 에러 인라인 표시).
