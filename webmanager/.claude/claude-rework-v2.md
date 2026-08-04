# Claude Code 탭 — 남은 작업 (M4, M5)

Claude Code 상태/관리 탭의 M1~M3 + 로그인(OAuth) 자동화 + 설치 버튼 + mise
버전확인은 전부 구현 완료(`archive/claude-plan-done.md` 참고, 조사 기록/API
계약/데이터 소스 등 배경은 전부 거기 있음 — 여기서 반복 안 함). 남은 건 M4/M5
둘뿐이라 별도 문서로 분리.

## M4: 익스텐션 설치 배너

`code-server --list-extensions`로 `anthropic.claude-code`(open-vsx:
`https://open-vsx.org/api/anthropic/claude-code`, 다운로드 3600만+) 미설치
확인 시 Claude 탭 안에 "설치"/"닫기" 배너 노출. 이미 구현된 익스텐션 관리 API
(`archive/extensions-plan-done.md`)를 재사용 — 설치는 그쪽 엔드포인트 그대로
호출.

- 닫으면 다시 안 뜨게 dismissed 플래그 영속화 필요 — `archive/claude-plan-done.md`의
  "webmanager 설정 저장소" 절이 제안한 `/code/.webmanager/config.yaml`
  (`claude.extensionBannerDismissed`)을 그대로 쓰거나, 이후 다른 기능들이
  실제로 채택한 백엔드 영속화 패턴(`internal/uiprefs`류, 소규모 JSON
  파일 + atomic write)과 일관되게 새 패키지로 만들지는 착수 시 재확인.
- 스코프는 좁게 유지 — 범용 확장 관리자를 새로 만드는 게 아니라 Claude 탭
  안의 배너 하나.

## M5: MCP 서버 목록

`claude mcp list`가 `--json`을 지원하지 않아(`plugin list`와 비대칭) 텍스트
파싱이 필요한데, 서버가 0개인 상태(`No MCP servers configured...`)만
확인됐고 실제로 서버가 여러 개 등록된 출력 포맷은 아직 관찰 못 함 — 그래서
계속 뒤로 미뤄져 있었다.

착수 시 첫 단계: 실제로 MCP 서버를 하나 이상 등록해보고 `claude mcp list`/
`claude mcp get <name>` 출력을 직접 관찰한 뒤 파싱 규칙을 정할 것. 텍스트
파싱 대신 `~/.claude.json`/`.mcp.json` 설정 파일을 직접 읽는 쪽이 나을 수도
있다는 대안도 열려있음(`archive/claude-plan-done.md`의 "미해결 질문" 절
참고) — 둘 중 뭐가 나을지도 실제 출력을 본 뒤 판단.

## 참고

- `archive/claude-plan-done.md` — 이 탭의 전체 배경/데이터 소스 조사/구현 기록.
- `archive/extensions-plan-done.md` — M4가 재사용할 익스텐션 설치 API.
