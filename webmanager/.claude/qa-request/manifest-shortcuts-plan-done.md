# code-server PWA에 "Open manager" shortcuts 항목 추가

**구현 완료 (코드 검증, nginx는 실컨테이너 확인 필요).** 아래 설계 그대로
구현됨:

- `config/nginx.default.conf`에 `location = /manifest.json`(webmanager로
  프록시, `error_page 502 503 504 = @manifest_fallback`) +
  `location @manifest_fallback`(code-server 원본으로 폴백) 추가. `nginx -t`로
  문법 검증까지 완료(디스포저블 `nginx:alpine` 컨테이너, 실제 code-docker
  컨테이너는 건드리지 않음) — 한 가지 실수를 이 검증에서 잡음: named
  location(`@manifest_fallback`) 안의 `proxy_pass`는 URI part를 가질 수
  없다는 nginx 제약이라, `proxy_pass http://127.0.0.1:8080;`로 수정(원본
  요청 URI가 그대로 전달되므로 동작은 동일).
- `webmanager/backend/internal/manifestpatch/`: 신규 패키지. 업스트림에서
  manifest를 fetch(`WEBMANAGER_CODE_SERVER_MANIFEST_URL`, 기본값
  `http://127.0.0.1:8080/manifest.json`) → JSON 파싱 → `shortcuts` 필드만
  병합 → 재직렬화. 실패 시 에러만 반환(폴백 로직 없음, nginx가 담당).
- `webmanager/backend/handlers_manifest.go`의 `handleManifestPassthrough`:
  실패 시 정확히 502 + 빈 바디. 성공 시 `Content-Type:
  application/manifest+json`.
- `main.go`에 `GET /manifest.json` ungated 라우트 등록.
- `example-env.webmanager`에 `WEBMANAGER_CODE_SERVER_MANIFEST_URL` 항목
  추가, `WEBMANAGER_ENV_VERSION` 5→6 bump. `--env-migrate` 왕복 테스트로
  마이그레이션 정상 동작 확인.
- `go build ./...` / `go vet ./...` 통과.

편차 없음 — 설계 문서 그대로 구현됨. 열린 질문(맨 아래 절)은 실컨테이너에서만
확인 가능해 미해결로 남음.

**원래 계획 (아래부터, 참고용으로 보존):**

**상태: 스코프 확정, 구현 착수.** `webmanager/CLAUDE.md`의 "Already implemented"
절에 기록된 미해결 후속 마일스톤("PWA `shortcuts` entry — still open/not
designed")을 여기서 확정하고 구현함.

## 배경 / 결정 경위

처음엔 "webmanager를 독립적으로도 설치 가능한 별도 PWA로 만들자"는 방향으로
논의가 시작됐으나(별도 manifest, 별도 scope/id, 별도 아이콘), 사용자가
직접 스코프를 정정함:

- 사용자는 에이전트별로 code-docker 인스턴스를 여러 개 띄우는 사용 패턴이고,
  webmanager는 "가끔 확인하는" 용도 — 인스턴스 수만큼 아이콘이 2배로 늘어나는
  건(code×N + manager×N) 원치 않음.
- 원했던 건 애초에 **PWA manifest의 `shortcuts` 필드** — 설치되는 앱은
  code-server 하나뿐이고, 그 설치된 앱 아이콘을 데스크탑에서 우클릭하거나
  안드로이드에서 꾹 누르면 뜨는 점프리스트에 "Open manager" 항목이 추가되는
  것. 별도 앱 설치가 아니므로 전용 아이콘도 필수 아님(스펙상 optional).
- 이 방식이면 `/`(code-server)에서 설치해도 code-server 앱 하나만 깔림 —
  의도한 그대로.
- 결론: **별도 manifest/별도 설치형 PWA는 만들지 않음.** code-server가 이미
  서빙하는 `/manifest.json`(`code-server-autoinstall/code-server/out/node/routes/vscode.js:165`,
  code-server 자체 코드 — 업스트림 업데이트로 바뀔 수 있는 vendored 산출물,
  절대 수정하지 말 것)을 가로채서 `shortcuts` 필드만 추가한 버전을 대신
  서빙한다.
- **webmanager가 없거나 응답 못 하는 상황이면 code-server 원본 manifest로
  자동 폴백** — 사용자가 명시적으로 요청함("없으면 그냥 code 쓰게, 근데
  너무 해키하면 안 해도 됨"). `config/nginx.default.conf`에 이미 완전히
  같은 문제(code-server가 아직 8080에 안 붙은 순간을 `error_page 502 503 504`
  로 처리)를 다루는 선례(`location = /_code_not_ready.html`)가 있어서, 그
  패턴을 그대로 재사용하면 됨 — 해키하지 않음, 표준 nginx 관용구.
  `[program:webmanager]`는 supervisord에 상시 등록돼있어(tailscale처럼
  env로 끌 수 있는 옵션 아님, `config/supervisord.default.conf:66`) "영구히
  없는 환경"보다는 "부팅/재시작 중 잠깐 응답 없는 순간"이 실제 발생 시나리오에
  가까움 — 그래도 폴백 자체는 항상 유효.

## 설계

### nginx (`config/nginx.default.conf`)

`location /`(code-server 프록시) 안에 있는 `/manifest.json` 요청을 가로채기
위해, 그보다 우선순위 높은 exact-match location 하나 추가(정확히
`location = /_code_not_ready.html`와 같은 스타일):

```nginx
location = /manifest.json {
    proxy_intercept_errors on;
    error_page 502 503 504 = @manifest_fallback;
    proxy_pass http://127.0.0.1:81/manifest.json;
    proxy_set_header Host $host;
}

location @manifest_fallback {
    internal;
    proxy_pass http://127.0.0.1:8080/manifest.json;
    proxy_set_header Host $host;
}
```

`try_files`가 아니라 `error_page ... = @named_location`을 쓰는 이유: 이건
"webmanager가 502/503/504로 응답하면(연결 거부 포함) 이름 붙은 위치로 재시도"
하는 표준 nginx 업스트림 폴백 관용구 — webmanager가 아예 안 떠 있어도,
떠 있지만 아래 핸들러가 의도적으로 502를 리턴해도(다음 절 참고) 둘 다 이
한 줄로 커버됨.

### webmanager 백엔드

`main.go`에 새 최상위 라우트(다른 `/api/...`와 달리 code-server의 실제 경로를
그대로 대체해야 하므로 prefix 없이):

```go
mux.HandleFunc("GET /manifest.json", s.handleManifestPassthrough)
```

`internal/manifestpatch/`(가칭) 새 패키지:

- 환경변수(예: `WEBMANAGER_CODE_SERVER_MANIFEST_URL`, 기본값
  `http://127.0.0.1:8080/manifest.json`)로 설정 가능한 업스트림 URL에서
  code-server의 실제 manifest를 fetch — nginx를 다시 거치지 않고 code-server
  내부 포트로 직접(불필요한 hairpin 방지).
- 응답을 JSON으로 파싱해서 `shortcuts` 필드만 추가/덮어쓰기:
  ```json
  "shortcuts": [
    {
      "name": "Open manager",
      "short_name": "Manager",
      "url": "/manager/",
      "description": "webmanager 관리 패널 열기"
    }
  ]
  ```
  `icons`는 이번엔 넣지 않음(옵션, 없으면 텍스트/기본 아이콘으로 표시됨 —
  나중에 원하면 추가). 그 외 필드(`name`/`icons`/`start_url`/`scope`/`display`
  등)는 fetch한 원본 그대로 통과 — 절대 새로 만들지 않음(code-server 업데이트로
  이 필드들이 바뀌어도 자동으로 따라감, 이게 애초에 "직접 만들지 말고
  가져와서 편집하자"고 한 이유).
  `Content-Type: application/manifest+json` 그대로 유지.
- **실패 시(fetch 에러, non-200, JSON 파싱 실패) 반드시 502를 명시적으로
  리턴** — 위 nginx `error_page 502 503 504 = @manifest_fallback`이 이걸
  잡아서 code-server 원본으로 자동 폴백하도록 의도적으로 설계된 것. 이 핸들러
  안에서 별도 폴백 로직(예: 하드코딩된 manifest)을 만들 필요 없음 — nginx가
  이미 그 역할을 함.

### code-server-autoinstall / 그 외

건드리지 않음 — `code-server-autoinstall`은 서브모듈(벤더 의존성), 원본
manifest 라우트는 그대로 두고 앞단에서 가로채기만 함.

## 구현 체크리스트

1. `config/nginx.default.conf`에 `location = /manifest.json` +
   `location @manifest_fallback` 추가
2. `webmanager/backend/internal/manifestpatch/` 새 패키지 (fetch + 파싱 +
   `shortcuts` 병합 + 실패 시 502)
3. `main.go`: `GET /manifest.json` 라우트 등록(gate 없음 — 이건 순수 읽기
   패스스루, 민감 정보 없음)
4. `go build`/`go vet` 검증. nginx 문법은 `nginx -t`로 로컬 검증 가능하면
   해볼 것(컨테이너 없이 docker run으로 문법만 체크하는 것도 가능 — 컨테이너
   재시작/빌드는 사용자 승인 없이 하지 말 것)
5. `webmanager/CLAUDE.md`의 "PWA `shortcuts` entry ... still open/not
   designed" 문구를 구현 완료로 갱신, `webmanager/.claude/README.md` 인덱스에
   이 문서를 `qa-request/`로 등록
6. 이 문서를 `qa-request/manifest-shortcuts-plan-done.md`로 이동(완료 시)

## 열린 질문 (경미)

- `replaceTemplates`가 만드는 아이콘 `src`의 `{{BASE}}` 치환이, webmanager가
  code-server를 직접(nginx 안 거치고) fetch할 때도 브라우저가 최종적으로
  받는 것과 동일하게 해석되는지 실컨테이너에서 확인 필요(정적 분석으로는
  `{{BASE}}`가 요청 컨텍스트에 얼마나 의존하는지 100% 확신 못 함 — 다만 최종
  소비자는 항상 `/manifest.json`을 루트에서 받는 실제 브라우저이므로 문제
  생길 가능성은 낮다고 판단).
