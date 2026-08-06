# Dev Proxy를 in-container nginx로 합류 (`/exports/` 프리픽스)

## 결정

Dev Proxy(내부 Caddy, `caddy-adapter`)를 별도 포트(8082)로 직접 export하는
대신, in-container nginx(포트 80)를 통해서도 도달 가능하게 만든다. 바깥
리버스 프록시가 dev-proxy 대상 요청의 path 앞에 `/exports`를 붙여서 같은
`ctip:80`으로 보내면, in-container nginx가 그 프리픽스를 벗기고 내부
Caddy(`caddy-adapter`)로 넘긴다 — Host 헤더는 끝까지 원본 그대로
보존된다 (`dev.code.yaeji.moe` 등).

```
브라우저 --Host: dev.code.yaeji.moe, path: /api-->
바깥 Caddy (rewrite / /exports/, Host 유지) --path: /exports/api-->
ctip:80 (in-container nginx) --/exports 벗김, Host 유지-->
내부 caddy-adapter (기존 Host 기반 매칭 그대로) --path: /api-->
dev 서버
```

## 왜

- 이 프로젝트는 바깥에 HTTPS 종료용 리버스 프록시(Caddy 등)를 두는 걸
  사실상 강제한다 (클립보드 접근/PWA 설치 모두 HTTPS 필요, 인증서를
  컨테이너 안에서 직접 관리하는 건 피하고 싶음). 즉 "바깥 프록시 연결"은
  항상 있는 전제.
- 지금은 그 바깥 프록시가 code-docker에 닿기 위해 포트를 두 개(80,
  8082) 열어야 한다 — 이건 공격 표면 증가다. 80은 이미 "가장 중요한
  포트"(뚫리면 code-server 터미널까지 사실상 다 뚫림)라, 거기에 버금가는
  포트를 하나 더 여는 것보다 하나로 집중하는 편이 낫다.
- `/exports` 프리픽스는 바깥 프록시 ↔ nginx 사이의 내부 계약일 뿐 브라우저에
  노출되지 않는다 — nginx가 벗겨내고 Host를 그대로 전달하므로:
  - 서브도메인별 origin 격리가 그대로 유지된다 (기존 설계의 핵심 —
    `.claude/archive`에 남아있진 않지만 `docs/dev-proxy.md`의 임의
    hostname/와일드카드 지원 설계 의도와 동일).
  - dev 서버(Vite 등)는 `/exports`를 아예 보지 못하므로 base path 재설정이
    불필요하다.
  - 내부 Caddy(`caddy-adapter`)의 Host 기반 라우팅 로직은 전혀 손댈 필요
    없음.

## 범위

- `config/nginx.default.conf` — `/exports/` location 추가, `ALLOWED_HOSTS`와
  동일한 패턴의 `ALLOWED_EXPORT_HOSTS` 맵 추가 (별도 allowlist, 빈 값이면
  체크 없음). `NGINX_BLOCK_LOOPBACK`은 `server{}` 최상단에서 이미 걸리므로
  손댈 필요 없음 (자동으로 `/exports/`도 커버).
- `config/nginx-service.default.sh` — `ALLOWED_EXPORT_HOSTS` env → map body
  변환 (`ALLOWED_HOSTS` 처리 로직 복사), `NGINX_CADDY_ADAPTER_UPSTREAM`
  (`127.0.0.1:${CADDY_ADAPTER_PORT:-8082}`, nginx와 caddy-adapter는 같은
  컨테이너 안이라 `private` 별칭 우회 불필요) 추가, envsubst 변수 목록에
  포함.
- `docker-compose.yml` — `ALLOWED_EXPORT_HOSTS` env 통과, `8082:8082` 주석을
  "기본은 nginx `/exports` 경유 권장, 직접 퍼블리시는 대안(레거시) 경로"로
  갱신.
- `example-env` — `ALLOWED_HOSTS` 옆에 `ALLOWED_EXPORT_HOSTS` 문서화 (같은
  스타일).
- `docs/dev-proxy.md` — "바깥 리버스 프록시 연결하기" 섹션을 `/exports`
  rewrite 방식을 기본 권장으로 다시 쓰고, 기존 8082 직접 퍼블리시 방식은
  대안으로 아래에 남긴다.

## 스코프 밖 (의도적으로 안 함)

- `caddy-adapter`의 bind 주소를 `private:8082`로 바꾸는 것(0.0.0.0 → 내부
  전용) — nginx는 컨테이너 내부이므로 어차피 `127.0.0.1`로 닿을 수 있어
  이번 변경에 필수는 아니고, 8082 직접 퍼블리시 대안 경로를 막아버리는
  트레이드오프라 별도 논의 없이 지금 같이 하지 않는다.
- `/exports` 프리픽스를 env로 커스터마이징 가능하게 만드는 것 — 브라우저에
  노출되지 않는 내부 계약이라 커스터마이징 필요성이 낮음, 고정 관례로 둔다.
- `TRUSTED_EXPORT_PROXIES` 분리 — 보통 바깥 프록시가 두 경로 다 동일하게
  타므로 `TRUSTED_PROXIES` 공유로 충분, 필요해지면 나중에 추가.
