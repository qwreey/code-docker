# code-docker 보안 감사 결과

- 감사일: 2026-08-05
- 대상: `/home/yaeji/Projects/code-docker` 전체 (Dockerfile, script/, config/, webmanager/backend, webmanager/frontend)
- 방법: Read 도구로 전체 코드 직접 열람 (서브에이전트/Bash grep 위주 자동화 없이 수동 검토)
- 결론: **악의적 코드(백도어, 데이터 유출, 난독화된 페이로드 등)는 발견되지 않음.** 전체적으로 보안 트레이드오프가 코드 주석에 상세히 문서화되어 있고, 커맨드 인젝션/경로 탈출 방어가 일관되게 잘 되어 있는 수준 높은 코드베이스. 다만 아래 몇 가지 개선 여지가 있는 지점을 발견함.

---

## 1. 발견 사항

### 1.1 [중간] `POST /api/processes/{pid}/signal` 이 password gate 없이 열려 있음 — **해결됨 (2026-08-05)**

- 위치: `webmanager/backend/main.go` (라우트 등록부), `webmanager/backend/handlers_processes.go`의 `handleSignalProcess`
- 내용: webmanager는 "읽기는 열어두고 쓰기(변경 작업)는 `internal/authgate`로 gate 건다"는 원칙을 코드 전반에 걸쳐 일관되게 지키고 있음 (dind start/stop/remove, supervisor start/stop/restart, 파일 관리자, git 설정 쓰기, SSH 키 쓰기, tailscale 변경 등 전부 `gate.RequirePassword`로 감싸져 있고 그 이유가 주석에 명시됨).
- 그런데 임의 PID에 `SIGTERM`/`SIGKILL`을 보낼 수 있는 `POST /api/processes/{pid}/signal`만은 예외적으로 gate 없이 등록되어 있음:
  ```go
  mux.HandleFunc("GET /api/processes", s.handleListSystemProcesses)
  mux.HandleFunc("POST /api/processes/{pid}/signal", s.handleSignalProcess)  // ← gate 없음
  mux.HandleFunc("GET /api/ports", s.handleListPorts)
  ```
- `handleSignalProcess`는 `syscall.Kill(pid, sig)`를 그대로 실행하므로, webmanager에 도달할 수 있는 누구나 컨테이너 안의 임의 프로세스(예: supervisord 자신, sshd, code-server, dind 클라이언트 프로세스 등)에 `SIGKILL`을 보낼 수 있음. 이건 dind의 `stop`/`remove`(gate 있음)나 supervisor의 `restart`(gate 있음)와 비교해도 파급력이 결코 작지 않은 동작인데, 유독 이것만 gate가 빠져 있음 — 코드 전체의 설계 원칙과 어긋나는 누락으로 보임.
- 인증 게이트(`WEBMANAGER_AUTH_PASSWORD_HASH`)를 설정해 둔 사용자라도 이 엔드포인트는 그 보호를 받지 못함.
- **제안**: `mux.Handle("POST /api/processes/{pid}/signal", gate.RequirePassword(http.HandlerFunc(s.handleSignalProcess)))` 로 다른 파괴적 액션들과 동일하게 gate 적용.
- **처리 결과**: 원래 이렇게 뒀던 명시적인 설계 의도는 문서 어디에도 없었음(`archive/processes-plan-done.md`에도 그냥 API 목록으로만 나열돼 있었을 뿐, gate 여부를 논의한 흔적 없음) — 단순 누락으로 판단해 제안대로 gate 적용함.

### 1.2 [낮음] mise / code-server 확장 설치·삭제 엔드포인트도 gate 미적용 — **해결됨 (2026-08-05)**

- 위치: `main.go`의 `/api/mise/tools` (POST/DELETE), `/api/code-extensions` (POST/DELETE)
- `mise install`/`uninstall`은 임의 버전의 툴체인을 다운로드해 실행하는 행위이고, code-server 확장 설치도 임의 VSIX를 code-server 프로세스 컨텍스트에 로드하는 행위라 어느 정도 신뢰 범위 밖 코드 실행에 가까움. 그런데도 password gate가 적용되어 있지 않음(파일 관리자·터미널·dind·git 설정 등 다른 "쓰기" 계열과 다르게).
- 다만 이 부분은 저장소 관례상 "gate 대상은 파일시스템 임의 조작/터미널/도커 API처럼 특히 강력한 것들"로 의도적으로 좁혀놓은 것일 수 있어(문서화된 설계 의도가 명시적이지 않음), 1.1보다 심각도는 낮게 평가함. 인증 게이트를 사용하는 운영자라면 이 두 기능도 gate 대상에 포함할지 검토할 가치가 있음.
- **처리 결과**: `authgate-plan-done.md`를 확인해보니 실제로 "이번 라운드 범위 밖으로 판단해서 게이트 안 함(사용자가 명시적으로 언급 안 한 부분)"이라고 명시돼 있었음 — 보안 설계 의도가 아니라 단순히 그 라운드 스코프에서 빠졌던 것. 안 걸어둘 뚜렷한 이유가 없어서 제안대로 gate 적용함.

### 1.3 [정보] `user-init.default.sh`의 최초 부팅 시 `curl | fish -c "... | source"`

- 위치: `config/user-init.default.sh`
  ```sh
  fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup" < /dev/null
  ```
- GitHub의 `qwreey/qwreey-fish` 리포(레포 소유자 본인 소유)에서 스크립트를 가져와 검증 없이(해시 고정 없이) 바로 실행하는 고전적인 "curl | shell" 패턴. 본인 소유 레포이고 컨테이너는 이미 root 권한으로 동작하므로 실질적 권한 상승은 아니지만, 공급망 관점에서는 해당 GitHub 계정/레포가 탈취되거나 브랜치가 변조될 경우 최초 부팅 시 임의 코드가 실행되는 지점. 무결성 검증(커밋 해시 고정, 체크섬)이 없다는 점만 참고용으로 기록.

### 1.4 [정보] 빌드 시 `makepkg` 사용자에 `NOPASSWD:ALL` sudo 부여

- 위치: `script/install-yay.sh`
  ```sh
  echo "makepkg ALL=(ALL:ALL) NOPASSWD:ALL" > /etc/sudoers.d/makepkg
  ```
- AUR 패키지(yay) 빌드를 위해 표준적으로 쓰이는 패턴이며, 최종 이미지에서 컨테이너는 root로만 운영되고 `makepkg` 사용자로 로그인하는 경로가 없어 실질적 위험은 낮음. 다만 이 sudoers 파일이 빌드 후에도 이미지에 남아있다는 점은 참고로 남김 (해당 파일/유저를 최종 스테이지에서 제거하는 것도 고려 가능하나, 최종 stage가 새 `FROM archlinux`라서 별도 빌드 스테이지를 안 쓰는 이상 makepkg 자체가 최종 이미지의 일부이며 root 트러스트 모델과 이미 동일 선상에 있음).

---

## 2. 잘 되어 있는 점 (참고용, 특별한 조치 불필요)

전체 코드베이스가 반복적으로 보여주는 좋은 패턴들 — 새로운 기능을 추가할 때도 이 패턴을 따르면 됨:

- **경로 탈출 방어**: `internal/files`의 `ResolvePath`/`ResolveNonRoot`/`ResolveForAccess`가 `filepath.Rel` 기반으로 `"/code-evil"` 같은 접두어 위장 공격을 막고, 심볼릭 링크 경유 접근도 `EvalSymlinks` 후 재검증. `internal/projects`, `internal/mise`도 "캐시에 이미 존재하는 프로젝트 경로와 정확히 일치해야 함"이라는 동일한 규칙으로 임의 경로가 `exec.Command`/`os.RemoveAll`에 도달하는 것을 차단.
- **커맨드 인젝션 방어**: `internal/dind`(컨테이너/이미지 ID), `internal/gitconfig`(GPG 키 fingerprint), `internal/projectgit`(git object hash), `internal/mise`(tool id/version), `internal/extensions`(확장 ID), `internal/devproxy`(subdomain 이름/target)에서 `exec.Command`에 넘기기 전 모두 엄격한 정규식으로 검증 — `-`로 시작하는 값이 플래그로 오인되는 것까지 명시적으로 방어.
- **인증 게이트 설계**(`internal/authgate`): argon2id 해시, HMAC 서명된 자체완결형 토큰(서버측 세션 저장소 없음), `/etc/environment`에 동일 변수가 재정의되어 있으면 컨테이너 내부에서 변조된 것으로 간주해 게이트를 무력화하는 방어적 크로스체크까지 포함.
- **터미널/파일관리자/Docker 소켓 노출을 코드 주석에 명시적으로 "SECURITY:"로 표시**하고 기본 신뢰 모델(리버스 프록시의 forward-auth)을 문서화해둠 — 은폐가 아니라 투명하게 위험을 알리는 방식.
- **네트워크 격리**: dind 데몬이 `code-docker-internal` 전용 IP에만 바인딩되도록 동적으로 인터페이스를 선택하는 `dind-entrypoint.sh`, tailscale의 loopback 자동 전달을 차단하는 nginx 설정 등 각 트레이드오프가 README/CLAUDE.md에 상세히 근거와 함께 기술됨.
- **비밀번호/시크릿 하드코딩 없음**: 저장소 전체에서 하드코딩된 API 키/토큰/비밀번호 패턴 검색 결과 없음.
- 프론트엔드에서 `dangerouslySetInnerHTML`, `eval(`, `innerHTML =` 등 XSS 위험 패턴 없음.

---

## 3. 감사 범위 관련 참고

- `code-server-autoinstall` 서브모듈은 CLAUDE.md 지침에 따라 "vendored dependency"로 취급하여 이번 감사에서는 깊게 들여다보지 않음 (별도 저장소).
- `webmanager/frontend/src/vendor/claude-conversation-schema/`는 외부 프로젝트에서 가져온 순수 타입 스키마 파일이라 별도 검토는 하지 않음 (실행 코드 없음, Zod 스키마 정의뿐).
- `.claude/`, `docs/`, `*.md` 등 문서/계획 파일은 코드가 아니므로 훑어보되 별도 보안 이슈 대상에서 제외.
