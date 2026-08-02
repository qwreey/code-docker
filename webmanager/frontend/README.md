# webmanager frontend

code-docker의 관리자 패널(webmanager) 프론트엔드. Vite + React + TypeScript로 작성된
클라이언트 사이드 렌더링(CSR) 앱이며, 백엔드는 별도 Go 프로젝트(`webmanager/backend`)에서
빌드된다.

## 구현 현황

- 구현됨: Supervisor(프로세스 관리), SSH Keys(authorized_keys 관리), Git Config(gitconfig +
  SSH 호스트 + HTTPS credential)
- 자리만 잡아둠 ("구현 예정"): Tailscale, mise, Docker (dind), Terminal

## 개발 모드 실행

```sh
npm install
npm run dev
```

`vite dev`는 `/api/*` 요청을 백엔드 dev 서버로 프록시한다. 프록시 대상은
`VITE_BACKEND_PROXY_TARGET` 환경변수로 지정하며 기본값은 `http://localhost:8081`이다.
Go 백엔드가 다른 포트에서 뜨는 경우 `.env.local`을 만들어 덮어쓴다:

```sh
cp .env.example .env.local
# .env.local 안의 VITE_BACKEND_PROXY_TARGET 값을 실제 백엔드 포트로 수정
```

## 빌드

```sh
npm run build
```

`dist/` 디렉토리가 생성된다. 이 디렉토리는 이후 Docker 이미지 빌드 단계에서 Go 백엔드가
`go:embed`로 포함하게 된다 (별도 통합 작업, 이 프로젝트의 범위 밖).

## 구조

```
src/
  api/            fetch 래퍼(client.ts) + 백엔드 응답 타입(types.ts)
  utils/          시간 포맷 등 유틸리티
  components/
    Layout/       사이드바 + 섹션 메타데이터
    Supervisor/   프로세스 목록/제어 + 로그 뷰어
    SshKeys/      authorized_keys 목록/추가/삭제
    GitConfig/    gitconfig, SSH 호스트, HTTPS credential 세 서브섹션
    Placeholder/  미구현 섹션 공용 "구현 예정" 컴포넌트
    common/       StatusBadge, ErrorBanner, CopyButton 등 공용 UI
```

## 비고

- 인증 UI는 없음 — 리버스 프록시의 forward-auth에 의존한다 (다른 code-docker 서비스와 동일).
- 다크/라이트 테마 전환 로직은 없음. 단일 라이트 톤의 차분한 색상 스킴만 사용한다.
