# code-server 익스텐션 추천/설치 관리 — 완료

## 구현 완료 (2026-08-02)

이 문서의 설계대로 구현 완료. 백엔드: `internal/extensions`(override 우선/default
폴백으로 `recommendations.default.yaml` 로드, `--list-extensions`/`--install-extension`
shell-out, 확장 ID `publisher.name` 정규식 검증) + `handlers_extensions.go`
(`GET /api/recommendations`, `GET /api/code-extensions`, `POST /api/code-extensions`).
프론트: `src/components/Extensions/`, `sections.ts`에 `'extensions'` 탭 추가. 루트
`config/recommendations.default.yaml` 신규 생성(`extensions:` 목록, README에
override 안내 추가). `go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부
클린 확인. 아래는 원래 설계 문서(구현 전 작성).

## 업데이트 (2026-08-02, 두 번째 라운드) — UX 개선

- **설치된 익스텐션 전체 목록** 섹션 추가(추천 목록에 없는 것도 포함, 기본
  접힘).
- **카테고리 접기/펼치기**(기본 펼침 — mise와 반대, 아래 참고).
- **"추천 표시" 토글**(새로고침 버튼 옆) — 끄면 추천 섹션 전체 숨김, 켜짐/꺼짐
  `localStorage`에 저장돼 새로고침해도 유지(`webmanager.extensions.
  showRecommendations`).
- **"더 보기"(open-vsx) 링크 — 구현 완료**: `Extensions.tsx`의 `openVsxUrl(id)`가
  `id`(항상 `publisher.name` 형식)만으로 `https://open-vsx.org/extension/
  <publisher>/<name>`를 기계적으로 구성 — 설치된 목록/추천 목록 항목 모두
  "open-vsx ↗" 링크로 새 탭에 열림(원래 `.claude/extension-search-plan.md`
  "1. 더 보기 정보 링크" 절에서 설계했던 것, 저 절은 구현 완료 후 이 문서로
  옮기고 그쪽에선 삭제함). GitHub 홈페이지 링크는 여전히 안 만듦(레지스트리
  응답에 필드가 없어서, 아래 참고).
- **삭제(uninstall) — 구현 완료**: `DELETE /api/code-extensions/{id}` →
  `internal/extensions.Uninstall()`(`--uninstall-extension <id>`,
  `Install()`과 거의 동일한 구조), 프론트에 `window.confirm` 확인 다이얼로그
  포함 삭제 버튼. install/uninstall 둘 다 `gate.RequirePassword` 적용됨
  (2026-08-05, 보안 감사로 누락 발견 — `archive/authgate-plan-done.md` 참고).
- **비활성화(disable) — 조사 후 구현 안 하기로 결정**: 개별 익스텐션의 영속적
  on/off는 VS Code가 문서화 안 된 SQLite(`state.vscdb`, 예전엔 `storage.json`)
  에 저장 — 버전마다 포맷이 바뀐 이력이 있어 직접 건드리기엔 부서지기 쉬움.
  자세한 근거는 `.claude/extension-search-plan.md`의 "0. 삭제/비활성화 리서치
  결과" 참고.
- **아직 안 함**(계획만, `question.md` 참고): 검색해서 설치, 특히 마켓플레이스
  URL 붙여넣기로 설치(마소 공식 → open-vsx 교차 조회 → vsix 직접 폴백) —
  `.claude/extension-search-plan.md`로 별도 설계만 해두고 미착수.

---

# 원 설계 문서 (구현 전 설계, 우선순위 중간)

`mise-plan.md`에서 분리된 문서 — mise 관리를 기다릴 필요 없이 독립적으로 구현 가능
(mise-plan.md의 `recommendations.yaml` 설계를 공유하지만, 이 기능 자체는 mise CRUD와
무관).

`webmanager/ideas.md`에서 "VS Code / code-server 설정 UI"를 후순위로 내렸던 이유
(Monaco/CodeMirror 같은 무거운 에디터 컴포넌트 필요, 자동완성 효용 불확실)는
"settings.json 같은 설정 파일 편집"에만 해당함 — 이 기능(추천 목록 보고 설치 버튼
누르기)은 그 문제를 안 가지고 있어서 별개로 분리, 우선순위도 다름(중간 — 기술적으로
막히는 결정 포인트가 없어서 mise/dind/웹쉘보다 낮은 난이도).

## 기능

`recommendations.yaml`의 `extensions` 목록(익스텐션 ID + 라벨)을 읽어서, 이미 설치된
것과 대조해 체크박스/버튼으로 나열, 선택 설치.

## 실제 호출 방법 (확인 완료)

`code-server-autoinstall/start.sh:110`에서 실제 실행 플래그 확인함 — 서버는

```
--user-data-dir="$SPATH/user-data" --extensions-dir="$SPATH/extensions"
```

로 떠 있음(`$SPATH` = `/code/.server`). 익스텐션 설치는 서버가 떠 있는 채로 별도 CLI
프로세스를 독립적으로 실행하면 됨(VS Code CLI 표준 동작 — 서버 중지/재시작 불필요,
설치 후 반영만 기존 `restart` 안내와 동일하게 필요). 동일한 두 디렉토리 플래그를
맞춰서 shell-out:

```sh
/code/.server/code-server/bin/code-server \
  --user-data-dir=/code/.server/user-data \
  --extensions-dir=/code/.server/extensions \
  --install-extension <id>
```

이미 설치된 목록 확인은 같은 플래그에 `--list-extensions`.

**기술적으로 막히는 결정 포인트가 없음** — 구현 자체는 이 CLI 호출 하나 +
`recommendations.yaml`의 `extensions` 파싱 + 목록/체크박스 UI 정도.

## API 스케치

- `GET /api/recommendations` — `mise`/`extensions` 둘 다 포함(mise-plan.md와 공유
  엔드포인트)
- `GET /api/code-extensions` — `--list-extensions` 결과
- `POST /api/code-extensions` body `{id: string}` — `--install-extension` 실행

## 참고

- 도구 추천 목록/`recommendations.yaml` 전체 설계는 `mise-plan.md`
- 전체 우선순위는 `webmanager/plan.md`, `webmanager/CLAUDE.md`
- `archive/claude-plan-done.md`(당시 claude-plan.md)도 별개로 "Claude Code 확장 미설치 배너" 하나를 원함 — 이 기능이
  먼저 만들어지면 그 배너도 이 API를 재사용하면 됨(중복 구현 방지)
