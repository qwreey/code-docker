# webmanager 전체 아키텍처

컴포넌트별이 아니라 webmanager 전체에 걸치는 결정들. 최종 상태 요약이고, 각
결정에 도달한 전체 논쟁 과정은 `.claude/base/history-raw.md`에 있음(필요할
때만 참고).

## 결정

- **배포**: 기존 이미지에 supervisord program(`webmanager`)으로 추가. 별도 컨테이너
  아님 — supervisord unix socket, dind TCP 모두 같은 컨테이너 안에서 바로 접근 가능.
- **스택**: Go(stdlib `net/http`, 컴포넌트별 `internal/*` 패키지, Go 1.22+ 라우팅
  패턴) + Vite/React(TS, CSR). 프론트는 별도 Docker 빌드 스테이지에서 `dist`를
  만들어 최종 이미지에 COPY, 백엔드는 `WEBMANAGER_STATIC_DIR` 환경변수가 가리키는
  그 디렉토리를 런타임에 정적 서빙 — **go:embed가 아님**(최초 계획은 embed였으나,
  프론트만 바뀌어도 백엔드 재컴파일이 필요해지는 게 싫어서 런타임 서빙으로 단순화).
- **인증**: 리버스 프록시의 forward-auth에만 의존, 자체 로그인 없음(code-server와
  동일 신뢰 모델). dind/git-credential/ssh-key 등 민감한 조작을 다루므로 프록시
  앞단 인증이 필수 — README의 "webmanager" 절 경고 문구 참고.
- **바인드 주소**: 기본값이 `private:81`(전용 tailscale IP, 내부 전용)로 확정됨
  — 컨테이너 안 nginx가 `/manager`로 라우팅해주므로 기본 배포에서는 80번 포트
  하나만 외부에 노출되면 됨. `127.0.0.1`이 아니라 `private`인 이유는 레포 루트
  `docs/tailscale.md`의 "보안: tailnet ACL 설정" 절 참고 — loopback 바인드는
  tailscaled가 같은 포트로 tailnet 전체에 자동 노출해버리기 때문에, code-server와
  함께 이 문제를 겪고 있었음(`webmanager/plan.md`의 구 TODO 5번 "바인드 주소 전략
  확정"에서 해결). `0.0.0.0:81`로 직접 노출하고 싶은 사용자는 `WEBMANAGER_ADDR`를
  바꾸고 `docker-compose.yml`의 주석 처리된 `81:81` 매핑을 되살리면 됨(README
  "webmanager" 절 참고).
- **프론트 구조**: 사이드바 + 섹션별 컴포넌트(`src/components/<Feature>/`), 각
  섹션은 `sections.ts`의 `SECTIONS` 배열에 `implemented: true/false`로 등록.
  구현 안 된 섹션은 `Placeholder` 컴포넌트로 "구현 예정" 표시.
- **백엔드 구조**: `internal/<concern>` 패키지(파일 r/w, CLI 래핑 등 순수 로직) +
  루트의 `handlers_<concern>.go`(HTTP 핸들러) + `main.go`의 라우트 등록. 공용
  헬퍼(`writeJSON`/`writeError`)는 `server.go`.
- **개발 방식**: 매 기능마다 backend/frontend subagent를 병렬로 돌리고, 정확한 API
  계약(엔드포인트/요청·응답 shape)을 미리 고정해서 각자 독립적으로 구현하게 한 뒤
  타입/계약 불일치를 직접 대조해서 잡는 패턴을 반복. 실제로 몇 번 잡음(로그
  타임스탬프 타입, `available` 필드 등) — 새 기능 만들 때도 이 패턴 유지 권장.
- **검증 원칙**: 다른 세션/에이전트가 실제 컨테이너를 쓰고 있을 수 있으므로,
  `docker compose build/up`은 "안전하다고 확인된 시점"에만 하고 평소엔 `go build`/
  `go vet`/`npm run build`/`npm run lint` + 스크래치 환경 실행으로 검증. 컨테이너가
  유휴 상태로 확인되면 실제 빌드+기동까지 해서 재검증하는 걸 반복함(가장 최근:
  전체 리뷰 라운드 이후 실제 컨테이너에서 수정사항 전부 재검증 완료).

## 보안 리뷰에서 나온 원칙 (`.claude/archive/webmanager-review.md` (레포 루트) 요약, 새 기능 만들 때 지킬 것)

- 사용자 입력이 파일 경로(`filepath.Join`)나 다른 설정 파일 포맷(SSH config, YAML)에
  원문 그대로 들어가면 path traversal/injection 위험 — 항상 안전한 charset으로
  검증할 것 (실제로 SSH 호스트 이름에서 이 문제가 있었고 고침, `qa-request/gitconfig-plan-done.md`
  참고).
- `exec.Command`에 넘기는 사용자 입력이 `-`로 시작하면 플래그로 오인될 수 있음 —
  포맷이 고정된 값(fingerprint 등)은 정규식으로 정확히 검증하고 나서 넘길 것.
- 파일 파싱(로그 등)에서 한 줄 문제로 전체 요청이 죽지 않게, 부분 실패는 항상
  "그 부분만 스킵하고 계속" 쪽으로 열화시킬 것.
- destructive 액션(삭제/kill/start-stop-restart)은 프론트에서 항상 confirm — 예외
  없이. (Supervisor 탭에 이게 빠져있던 게 critical 버그였음, 리뷰에서 잡고 고침.)
