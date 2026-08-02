# Docker/dind 관리 (구현 전, 미착수)

`caddy-plan.md`에서 확정된 우선순위: **웹쉘보다 먼저** 진행 (`terminal-plan.md` 다음
이 아니라 그 앞 — 전체 순서는 `webmanager/CLAUDE.md` 참고).

## 알려진 것

- `DOCKER_HOST=tcp://dind:2375`로 이미 평문 TCP 도달 가능(인증/TLS 없음,
  `code-docker-internal` 전용) — Docker Engine API를 그대로 웹 UI 백엔드에서 호출
  하면 됨, 새 인증 계층 불필요(기존 신뢰 경계 재사용).
- **주의**: 이 API는 사실상 호스트 루트 권한과 동급 — webmanager 자체의 (없는) 인증이
  곧 이 API의 유일한 문지기가 됨(README의 기존 dind 보안 각주와 동일 성격).

## API 초안 (구현 전 상상, 재검토 필요)

`GET /api/dind/containers`, `GET /api/dind/images`,
`POST /api/dind/containers/:id/start|stop|remove`,
`GET /api/dind/containers/:id/logs`(스트림) — Docker Engine API를 얇게 프록시/래핑.

## 구현 시 확인할 것

- Go에서 Docker Engine API를 다루는 표준 라이브러리(`docker/docker/client` 공식
  SDK vs 직접 HTTP 클라이언트) 중 뭘 쓸지 — 공식 SDK는 무겁고 이 컨테이너의
  "가벼운 의존성" 원칙과 맞는지 검토 필요.
- 로그 스트림(`GET .../logs?follow=true`)을 프론트에 어떻게 중계할지(SSE/WS) —
  이미 있는 `Logs`/`Supervisor` 로그 패널 패턴(폴링, 스트림 아님)과 다르게 갈지,
  같은 폴링 패턴으로 단순화할지 판단 필요.
