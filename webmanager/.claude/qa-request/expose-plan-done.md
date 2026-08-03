# code-server + webmanager 단일 origin 통합 (`/manager` 경로) — 구현 완료, 실컨테이너 QA 대기

리서치 단계였던 레포 루트 `expose.md`를 대체함(그 문서는 삭제, 이 문서가 결론 +
실행 계획). 리서치 결론 자체(코드-서버 서브패스 지원 원리, PWA manifest scope
동작)는 바뀐 게 없음 — 요약만 아래 "리서치 요약"에 남기고, 이번 라운드에서 사용자와
확정한 아키텍처 결정 + 실행 계획 위주로 다시 정리함.

**구현 완료 (2026-08-03)**: M1(nginx supervisord program)~M3(프론트엔드
서브패스 대응) 전부 코드 작성 + `go build`/`go vet`/`npm run build`/`npm run
lint` 검증까지 끝남. 아래 실행 계획 본문은 작성 당시 스냅샷이라 "미착수"
기준으로 서술되어 있지만, 실제로는 계획대로 구현됨 — 실제 변경 파일 목록은
아래 "구현 결과" 절 참고. 남은 건 사용자 본인이 `docker compose build && up`으로
실컨테이너에서 확인하는 것뿐(README/docs 갱신도 함께 끝남). "나중 마일스톤"
절(code-server 안에서 매니저를 여는 위젯/PWA 바로가기)은 여전히 착수 안 함 —
질문만 `question.md`에 남아있음.

## 구현 결과 (실제 변경 파일)

- `config/nginx.default.conf`(신규), `config/nginx-service.default.sh`(신규),
  `script/nginx-service.sh`(신규) — M1 그대로. 계획 문서에 없던 디테일 하나
  추가: `location = /manager { return 301 /manager/; }` — trailing slash
  없이 `/manager`로 들어오면 `location /manager/`에 안 걸리고 `location /`
  (code-server)로 새 버려서, 명시적으로 슬래시 붙는 URL로 리다이렉트.
- `config/supervisord.default.conf`에 `[program:nginx]` 추가,
  `config/build.default.sh`의 pacman 목록에 `nginx` 추가, `Dockerfile`에
  `/var/log/nginx` 생성 + `script/nginx-service.sh` COPY 추가.
- `config/code-config.default.yaml`의 `bind-addr`를 `127.0.0.1:8080`으로 변경,
  `config/code-service.default.sh`의 최초 1회 가드 제거(매 시작 재생성)로 M2 반영.
- `docker-compose.yml`의 `81:81` 매핑 주석 처리, `example-env.webmanager`의
  `WEBMANAGER_ADDR` 기본값을 `127.0.0.1:81`로 변경 + `WEBMANAGER_ENV_VERSION`을
  1→2로 bump(기본값 변경이라 마이그레이션 도구가 사용자에게 알리도록).
- `webmanager/frontend/vite.config.ts`(`base` 조건부 적용),
  `webmanager/frontend/src/api/client.ts`(`apiUrl()` 헬퍼 추가),
  `FileManager.tsx`(다운로드/업로드 두 곳), `Terminal.tsx`(WebSocket URL) — M3
  계획의 4개 하드코딩 지점 전부 `apiUrl()`로 교체.
- `README.md`, `docs/webmanager.md`, `docs/build-customization.md`,
  `webmanager/.claude/base/architecture.md` — 아래 "README 갱신 필요 항목"
  전부 반영.

## 확정된 아키텍처

- **code-server는 그대로 루트(`/`)** — 안 옮김. PWA manifest의 기본 scope가
  이미 `/`라서 옮길 이유가 없다는 리서치 결론 그대로.
- **webmanager만 `/manager`로 이동**.
- **strip-prefix 리버스 프록시는 컨테이너 안의 nginx로 처리** — 외부 Caddy에
  맡기지 않음. **이유**: 이 컨테이너 자체가 다루는 대상이 이미 컨테이너
  바깥의 Caddy(포워드 인증용)라서, "컨테이너 안팎에 리버스 프록시가 두 겹"
  구조가 됨 자체는 어쩔 수 없음 — 다만 `/manager` 스플릿은 code-docker
  자신의 내부 구조(webmanager가 원래 별도 포트였다는 사실)를 감추기 위한
  것이지 외부 인증/도메인 라우팅과는 관심사가 다르므로, 외부 Caddy 설정에
  얹지 않고 컨테이너 안에서 완결시킨다. 외부 Caddy는 앞으로 사용자가
  플러그인(`CADDY_PATH`, 아직 미정)을 자유롭게 넣게 해줄 계획이라 "항상
  작동한다"를 보장하기 어려워질 수 있음 — Caddy reload가 실패하거나
  플러그인이 죽으면 code-server와 webmanager 둘 다 통째로 못 들어가는 상황이
  생기는데, 이건 감수할 만한 리스크가 아님. nginx 바이너리는 1.5~3MB
  수준이라 이미지 용량 문제는 무시 가능 — 안 들일 이유가 없음.
- **호환성**: 이미 외부 Caddy(또는 다른 리버스 프록시)를 두고 있는 사용자는
  아무 변경 없이 그대로 동작함 — nginx가 컨테이너 안에서 처리를 끝내고
  하나의 포트(80)만 노출하므로, 바깥쪽은 지금처럼 그 포트 하나만 보고
  reverse_proxy 한 줄이면 됨(오히려 지금 README 예시처럼 서비스마다 블록을
  나눌 필요가 없어져서 더 단순해짐 — 아래 "README 갱신" 참고).

## 실행 계획

### M1. nginx를 컨테이너 안 supervisord program으로 추가

기존 override 패턴 그대로:
- `config/nginx.default.conf` (+ 사용자용 `config/nginx.override.conf`) —
  아래 라우팅 규칙.
- `script/nginx-service.sh` → `config/nginx-service.default.sh` (+ override)
  — `exec nginx -g "daemon off;" -c /etc/code-docker/nginx.conf` 형태.
  supervisord가 프로세스를 직접 관리해야 하므로 `daemon off` 필수(안 그러면
  nginx가 자체적으로 마스터+워커로 fork해서 supervisord가 좀비를 관리하게
  됨).
- `config/supervisord.default.conf`에 `[program:nginx]` 추가 — 기존
  프로그램들과 동일한 `stdout_logfile=/var/log/%(program_name)s/stdout.log`
  패턴(다른 수정 불필요, vector가 `/var/log/*/stdout.log*`를 이미 glob으로
  집는 중).
- `config/build.default.sh`의 `pacman -Suy ...` 목록에 `nginx` 추가.

라우팅 규칙 (`nginx.default.conf`):
```nginx
server {
    listen 80;

    # 웹쉘 WebSocket, 파일 업로드(2GiB 기본 한도, WEBMANAGER_FILES_MAX_UPLOAD_BYTES)
    # 둘 다 nginx 기본값(1MB body / 60s read timeout)에 걸려 끊기므로 명시적으로 풂.
    client_max_body_size 0;
    proxy_read_timeout 3600s;

    location /manager/ {
        proxy_pass http://127.0.0.1:81/;   # trailing slash 필수 — prefix 제거
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;   # code-server, 아래 M2 참고
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### M2. 포트 재배치 — code-server/webmanager를 loopback 내부 포트로

**지금 문제**(사소하지 않음): `code-config.default.yaml`이 `bind-addr:
0.0.0.0:80`을 박아두고 있고, `code-service.default.sh`가 이 파일을
`/code/.server/config.yaml`로 복사하는 로직이 `[ ! -e
"/code/.server/config.yaml" ]`(최초 1회만) 조건이라 **기존에 이미 초기화된
컨테이너는 이미지를 업데이트해도 새 기본값을 못 받는다** — 포트 80을 nginx가
가져가야 하는데, code-server가 계속 80을 잡고 있으면 충돌.

**해결 (합의됨)**: `code-service.default.sh`에서 그 `[ ! -e ... ]` 가드를
제거하고 **매 시작마다 무조건 덮어쓴다**(override 있으면 override, 없으면
default). 이유: `code-config.override.yaml`이 이미 있으니(gitignored,
override 패턴 그대로) 런타임 커스터마이징은 원래 그쪽으로 하는 게 맞고,
`/code/.server/config.yaml`을 직접 손으로 고치는 걸 "지원되는 방법"으로 둘
이유가 없다 — 지금까지도 사실상 의미 없는 파일이었음(override 패턴의 다른
모든 파일처럼 재빌드해야 반영되는 게 자연스러움). **README에 명시적으로
추가할 문구**: "`/code/.server/config.yaml`은 매 시작마다 자동 재생성되니
직접 편집하지 말 것 — 커스터마이징은 `config/code-config.override.yaml`을
만들고 재빌드할 것."

구체적 변경:
- `code-config.default.yaml`: `bind-addr: 0.0.0.0:80` →
  `bind-addr: 127.0.0.1:8080` (nginx만 붙을 수 있는 내부 전용 포트로 변경).
- `docker-compose.yml`: `WEBMANAGER_ADDR` 기본값을 `:81`(=`0.0.0.0:81`)에서
  `127.0.0.1:81`로 바꾸도록 `example-env.webmanager`/README 갱신 (webmanager
  자체 바인드 주소 관련 TODO — `webmanager/plan.md`의 "바인드 주소 전략
  확정" 항목을 이 기능이 부분적으로 해결하는 셈). `ports:`에서 `81:81` 매핑
  제거 — nginx의 `/manager`를 거치지 않고 webmanager에 직접 접근할 이유가
  이제 없음(필요한 사람은 주석 처리된 예시로 남겨두고 직접 켜게).
- `code-service.default.sh`: 위 가드 제거.
- `code-service.default.sh`가 이미 `code-server-autoinstall/install.sh`
  다음에 config.yaml을 다루므로 순서상 문제 없음 — 그대로 그 위치에서
  가드만 빼면 됨.

**마이그레이션 영향**: 기존 사용자가 이미지를 업데이트하고 컨테이너를
재시작하면 code-server의 리스닝 포트가 자동으로 80 → 8080(내부 전용)으로
바뀜 — 이건 nginx가 새로 껴서 여전히 바깥에서는 80으로 그대로 접속되므로
사용자 입장에서 체감 변화는 없어야 정상. 다만 **CHANGELOG/README에 눈에 띄게
공지 필요**: `code-config.override.yaml`로 `bind-addr`를 직접 지정해둔
사용자가 있다면(가능성은 낮지만) 그 값이 이제 nginx 라우팅 대상과 어긋날 수
있음 — override에서 `bind-addr`를 건드리지 말라고 안내.

### M3. webmanager 프론트엔드 — 서브패스 대응

`Explore` 서브에이전트로 직접 grep해서 확인한, `/manager` prefix 없이
하드코딩된 절대경로 4곳(전부 코드 수정 필요, `base` 설정만으론 안 잡힘):

| 파일:라인 | 코드 | 비고 |
|---|---|---|
| `src/api/client.ts:39` | `` fetch(`/api${path}`, init) `` | 모든 REST 호출의 단일 진입점 |
| `src/components/FileManager/FileManager.tsx:106` | `` window.location.href = `/api/files/download?path=...` `` | client.ts 안 거치고 직접 네비게이션 |
| `src/components/FileManager/FileManager.tsx:168` | `fetch('/api/files/upload', ...)` | client.ts 안 거치고 직접 fetch(멀티파트라 그런 듯) |
| `src/components/Terminal/Terminal.tsx:270` | `` new WebSocket(`${protocol}//${host}/api/terminal?session=...`) `` | WS라 client.ts 밖에 있음 |

**확인된 것 (수정 불필요)**:
- `index.html`의 `<link rel="icon" href="/favicon.svg">`, `<script
  src="/src/main.tsx">` — 둘 다 Vite가 빌드 시 HTML을 파싱해서 `base`
  기준으로 다시 쓰는 대상이라 자동으로 처리됨.
- 라우터 없음(`react-router` 등 클라이언트 라우팅 자체가 코드베이스에 없음)
  — basename 걱정 없음.
- webmanager 자체 `manifest.json`/서비스워커 없음(code-server 쪽과 달리) —
  지금 라운드에선 PWA scope 이슈 자체가 없음. 아래 "선택 사항"에서 독립 PWA
  화하고 싶을 때만 다시 등장하는 문제.

**변경 사항**:
1. `vite.config.ts` — `base`를 빌드에서만 조건부 적용:
   ```ts
   export default defineConfig(({ mode, command }) => {
     ...
     return {
       base: command === 'build' ? '/manager/' : '/',
       ...
     }
   })
   ```
   dev 서버는 지금처럼 루트(`/api` 프록시 규칙 그대로) 로 유지 — `base`를
   무조건 `/manager/`로 박으면 dev proxy(`server.proxy['/api']`) 키가
   `/manager/api`로 어긋나서 별도로 rewrite 로직까지 손봐야 하는데, 어차피
   개발할 땐 nginx를 거치지 않고 webmanager를 직접 보므로 dev에서까지
   `/manager/` prefix를 흉내 낼 이유가 없음. `command === 'build'`로만
   분기해서 이 복잡도를 피한다.
2. `src/api/client.ts` — `` fetch(`/api${path}`, init) `` →
   `` fetch(`${import.meta.env.BASE_URL}api${path}`, init) `` (또는 별도
   `apiUrl(path)` 헬퍼로 뽑아서 아래 3곳도 재사용).
3. `FileManager.tsx:106`, `FileManager.tsx:168`, `Terminal.tsx:270` — 위와
   같은 방식으로 `import.meta.env.BASE_URL` 접두어를 붙임(WebSocket URL은
   프로토콜/호스트 계산 로직은 그대로 두고 경로 부분만 접두).

**webmanager 백엔드**: 무변경 — nginx가 `/manager` prefix를 이미 벗겨주므로
Go 서버는 지금처럼 `/api/...`를 그대로 받음.

### 필요 없는 것 (재확인)

- code-server 쪽 코드/설정 변경 없음(bind-addr 재배치 제외 — M2는
  code-server "서브패스 이동"이 아니라 "포트만 내부로 이동", 서빙 방식
  자체는 그대로 루트).
- `sub_filter` 등 응답 본문 치환 불필요(리서치 결론 그대로, code-server가
  이미 상대경로로 응답 생성).

## README 갱신 필요 항목

- "보안 (로그인)" 절의 Caddy 예시 — 지금은 서비스마다 `reverse_proxy` 블록을
  하나씩 쓰라는 뉘앙스인데, nginx가 안에서 이미 합쳤으므로 **컨테이너당 블록
  하나**로 단순화됨:
  ```Caddy
  code.yaeji.moe {
    ...
    reverse_proxy http://containerip:80   # code-server + /manager(webmanager) 전부 이 한 줄
  }
  ```
- `/code/.server/config.yaml`은 매 시작마다 재생성됨 — 직접 편집 금지,
  `config/code-config.override.yaml` 사용을 명시.
- webmanager 섹션의 "81번 포트" 문구를 "`/manager` 경로(같은 origin, 80번
  포트 안에서 nginx가 라우팅)"로 갱신, 독립 포트로 열고 싶은 사람을 위해
  `WEBMANAGER_ADDR`/`81:81` 매핑을 되살리는 방법도 한 줄 남겨둘 것.
- `example-env.webmanager`의 `WEBMANAGER_ADDR` 기본값/주석 갱신(`:81` →
  `127.0.0.1:81`, docker-compose 포트 매핑 언급 삭제).

## 선택 사항 (필수 아님, 지금 안 해도 됨)

- webmanager를 **독립적으로도** PWA 설치 가능하게 하려면 자체
  `manifest.json`(`scope: "/manager/"`)을 추가해야 함 — README의 기존
  주의사항(매니페스트/아이콘은 인증 없이 공개 노출돼야 안드로이드 APK 빌드가
  됨)이 여기도 그대로 적용됨.
- code-server 창 안에 매니저로 가는 버튼/링크 — `config/code-patch/`로 JS
  하나 추가하면 지금 당장도 가능(서브패스 이전과 무관하게 독립적으로 할 수
  있는 작업).

## 나중 마일스톤 (지금 구현 안 함, 질문만 정리)

사용자가 언급한 "code 웹 앱 안에서 manager를 여는 방법" — 같은 origin이
되고 나면(위 M1~M3 완료 후) code-server 쪽에서 `/manager`를 iframe/위젯으로
띄우는 것도 진짜 same-origin이라 CORS/서드파티 쿠키 걱정이 완전히 없어짐(기존
`expose.md`의 "대안: iframe/위젯" 절이 걱정했던 서브도메인 간 쿠키 이슈 자체가
사라짐). 다만 아래는 구현 착수 전에 답이 필요한, 아직 안 풀린 질문들 — 지금은
기록만 해두고 손대지 않음:

1. **트리거**: 커맨드 팔레트 항목? 사이드바에 상시 아이콘? 키바인딩? —
   `config/code-patch/`(기존 `window.CDDialog` 메커니즘)로 주입 가능하다는
   전제는 있음, 정확히 뭘 누르면 열리는지가 미정.
2. **표시 형태**: 작은 위젯 패널(iframe) vs 전체 화면 전환(단순 네비게이션)
   — 전자는 `CDDialog` 재사용으로 저비용, 후자는 그냥 링크라 사실 지금도
   가능(추가 작업 불필요). 사용자가 원하는 게 정확히 어느 쪽인지, 아니면
   둘 다(평소엔 위젯, "크게 보기"로 전체 화면 이동)인지 확인 필요.
3. **PWA "앱 바로가기"(홈 화면 아이콘 꾹 눌러서 나오는 서브 액션, Web App
   Manifest의 `shortcuts` 필드)**: code-server의 `manifest.json`은
   `out/node/routes/vscode.js`가 코드-서버 자체적으로 생성하는 것이라,
   `PWA_NAME` 등처럼 `code-server-autoinstall`이 `sed`로 패치하는 필드
   목록에 `shortcuts` 항목을 새로 추가해야 함 — 코드-서버 업스트림 버전이
   바뀌면 패치 대상 텍스트가 어긋날 수 있는 리스크가 있음(`PWA_NAME` 패치도
   같은 리스크를 이미 안고 있으므로 새로운 종류의 리스크는 아니지만, 패치할
   필드가 하나 늘어남). 부가효과가 크다고 판단해서 사용자가 명시적으로
   마일스톤으로만 남겨두자고 함 — 바로가기로 뭘 노출할지(매니저 홈? 특정
   탭? 터미널?)도 별도 질문.
4. 긴 세션(예: 폰으로 여는 Claude Code 세션)은 이 마일스톤과 무관하게 **이미
   해결됨** — `/manager` 경로가 생기고 나면 그냥 그 URL로 접속하면 되는
   일이라 추가 작업이 필요 없음. 오해 방지용으로 여기 기록.

이 4개 질문은 `question.md`에도 옮겨서 저장소 소유자가 나중에 훑어볼 수 있게
해둠.

## 리서치 요약 (원본 `expose.md`에서 이관, 결론 근거)

- code-server는 서브패스 호스팅을 네이티브로 지원(공식 문서 예시,
  `--base-path` 플래그는 v3에서 의도적으로 제거됨 — 메인테이너가 "리버스
  프록시를 쓰라"고 명시). 벤더링된 4.109.2/vscode 1.105.0 소스 레벨로
  확인: 매니페스트/HTML의 모든 asset 경로가 현재 요청 경로의 `/` 개수를
  세서 상대경로로 계산됨 — strip-prefix 프록시 뒤에서 그냥 동작.
- **trailing slash가 핵심 함정** — `location`/`proxy_pass` 양쪽 다 슬래시
  맞춰야 함, 안 그러면 `/login` 리다이렉트가 prefix를 잃어버림.
- PWA manifest(`GET /manifest.json`)의 `start_url: "."`, 명시적 `scope`
  없음 → 브라우저 기본 scope = manifest가 서빙된 디렉토리. code-server를
  루트에 두면 scope가 `/`라서 `/manager`도 자동으로 포함됨 — 이게 "code-server는
  그대로 두고 webmanager만 옮긴다"는 결론의 핵심 근거.
- `X-Forwarded-Prefix` 헤더 인식 코드가 소스에 있지만 버전 간 우선순위가
  달라서(4.109.2 벤더 번들 vs 최신 `microsoft/vscode` main) 불안정 —
  안 씀, 공식 문서의 strip-prefix 방식만 신뢰.
- `sub_filter`(응답 본문 텍스트 치환)는 어떤 성공 사례에서도 필요하다는
  언급이 없음 — code-server가 이미 상대경로 응답을 만들기 때문, 안 써도 됨.
