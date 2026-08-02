# Git 설정 관리 — 완료

## 기능

- `~/.gitconfig`의 user.name/email 조회/수정
- 커밋 사이닝: SSH 또는 GPG 방식 선택, GPG 키 자체 생성/조회/삭제
- 호스트별 SSH 키(ed25519 자동 생성) — `~/.ssh/config` Host 블록 관리
- HTTPS credential store(`~/.git-credentials`, 평문 저장 — UI에 경고 문구)
- **(2026-08-02 추가)** `git lfs install` 실행 버튼(`internal/gitconfig/lfs.go`,
  `git-lfs` PATH 미존재 시 "이미지 리빌드 필요" 안내) + `.gitconfig` 원본 편집
  (`internal/gitconfig/raw.go` — 저장 전 임시파일에 써서 `git config -f <tmp> -l`
  로 문법 검증 후 `os.Rename`으로 원자적 교체, 검증 실패 시 원본 파일 안 건드림).
  프론트는 새 `src/components/common/{CodeEditor,LazyCodeEditor,
  ExpandableEditor}.tsx`(CodeMirror 6, 지연 로딩 청크 분리) 재사용 —
  `GitConfig.tsx`에 `GitLFS.tsx`/`RawConfigEditor.tsx` 추가. `config/build.default.sh`
  에 `git-lfs` pacman 패키지 추가.
- **(2026-08-02 두 번째 라운드 추가)** `~/.ssh/known_hosts` 조회/추가(raw 라인
  붙여넣기)/삭제(`internal/gitconfig/knownhosts.go`, 기존 SSH 키 기능과 동일한
  fingerprint 계산 재사용) — `GitConfig.tsx`에 `KnownHosts.tsx` 추가.
  **비밀번호 게이트**: 이 문서에 나온 모든 쓰기(user/signing/ssh-hosts/
  credentials/lfs-install/raw-편집/gpg-keys/known-hosts의 POST·PUT·DELETE)에
  적용됨, 읽기는 그대로 열림 — 자세히는 `.claude/authgate-plan-done.md`.

## 어떻게 동작하는가 (`internal/gitconfig`)

- `user.go`: `getConfig`/`setConfig` 헬퍼가 `git config --file <path> ...`를
  shell-out — 값이 빈 문자열이면 unset(git exit code 1/5는 "키 없음"이지 에러
  아님, 실제 git 동작 확인하고 처리). 다른 하위 파일들이 이 헬퍼를 재사용.
- `sshhosts.go`: `ssh-keygen -t ed25519 -N ""`로 호스트별 키 생성, `~/.ssh/config`에
  `Host` 블록 append/제거.
- `signing.go`: `gpg.format`/`user.signingkey`/`commit.gpgsign` 조합으로 모드
  (`none`/`ssh`/`gpg`) 판단·설정.
- `sshsigning.go`: 서명 전용 SSH 키(`SSH_SIGNING_KEY_PATH`, 기본
  `/code/.ssh/signing_key`) 생성 — 재생성 시 기존 파일 먼저 제거(재생성이 항상
  성공하도록).
- `gpg.go`: `gpg --list-secret-keys --with-colons` 파싱, `--quick-generate-key`로
  생성(패스프레이즈 없음), `--export`/삭제. **keyId는 40자리 hex fingerprint를
  정식 식별자로 씀** — 짧은 16자리 키 ID로는 `--delete-secret-and-public-key`가
  배치 모드에서 거부됨을 실제로 확인하고 fingerprint로 통일함.
- `credentials.go`: `net/url.URL{User: url.UserPassword(...), Host: host}`로
  안전하게 직렬화(개행/특수문자 자동 percent-encode) — credential.helper를
  `store --file=...`로 자동 설정.

## 겪었던 문제와 해결 (review.md)

- **SSH 호스트 추가에서 path traversal + SSH config injection (critical)**:
  `host` 값 검증 없이 `filepath.Join(keysDir, host)`에 써서 `../`로 keysDir 밖에
  파일 생성 가능했고, `~/.ssh/config`에도 원문 그대로 삽입돼 개행으로 임의
  `ProxyCommand` 등 주입 가능했음. **고침**: `host`는 `^[A-Za-z0-9._-]+$`만 허용,
  `hostname`/`user`는 개행 거부.
- **GPG keyId 플래그 인젝션**: 검증 없는 keyId가 `exec.Command`에 bare argument로
  들어가서 `--homedir=...` 같은 값이 `gpg`에 플래그로 파싱됨. **고침**: 40자리
  hex 정규식 검증 후에만 `exec.Command` 실행.
- **SSH 호스트 추가 부분 실패 시 고아 키 파일**: `ssh-keygen` 성공 후 config
  append가 실패하면 API로 못 찾는 키 파일이 남았음. **고침**: config append 실패
  시 방금 만든 키 파일 정리.
- **GPG 서명 키 선택 시 "아직 저장 안 됨" 경고가 SSH 플로우에만 있었음** — GPG
  쪽에도 동일 경고 추가.

## API

`GET/PUT /api/git/config`, `GET/POST /api/git/ssh-hosts`,
`DELETE /api/git/ssh-hosts/{host}`, `GET/POST /api/git/credentials`,
`DELETE /api/git/credentials/{host}`, `GET/PUT /api/git/signing`,
`POST /api/git/signing/ssh-key`, `GET/POST /api/git/gpg-keys`,
`GET /api/git/gpg-keys/{keyId}/public`, `DELETE /api/git/gpg-keys/{keyId}`
(gpg 미설치 시 `501`). 정확한 스펙은 `webmanager/backend/README.md`가 원본.

## 프론트

`src/components/GitConfig/` — `GitUserForm`/`SshHosts`/`HttpsCredentials`/
`CommitSigning`/`GpgKeys` 서브섹션. 새 키/크레덴셜 생성 시 공개키를 복사 가능한
블록으로 보여줌.
