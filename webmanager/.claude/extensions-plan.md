# code-server 익스텐션 추천/설치 관리 (구현 전 설계 문서, 우선순위 중간)

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
- `claude-plan.md`도 별개로 "Claude Code 확장 미설치 배너" 하나를 원함 — 이 기능이
  먼저 만들어지면 그 배너도 이 API를 재사용하면 됨(중복 구현 방지)
