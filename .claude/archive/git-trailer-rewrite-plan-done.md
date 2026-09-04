# 에이전트 커밋 trailer 치환 계획

작성 2026-09-03. **구현 완료 2026-09-04** — 실제 컨테이너에서 e2e 검증까지 끝남.
아래는 원안이고, 구현하며 바뀐 부분은 맨 끝 "구현하며 바뀐 것"에 적어둠.

## 요구

에이전트가 만든 커밋의 `Co-Authored-By: Claude ... <noreply@anthropic.com>`를
`qwreey-bot`(또는 git 설정에 지정된 이름/이메일)로 바꾸고 싶다. 모델명은 `()`로 묶어
뒤에 붙이거나 뺄 수 있는 옵션. 프로젝트마다 CLAUDE.md에 심는 건 확장이 안 되니,
`/usr/local/bin`에 `git` 래퍼를 두고 실제 git은 절대경로로 호출하는 방식을 생각 중.
설정은 webmanager의 Git 설정 탭에 추가.

## 판단: 래퍼(`bin/git`)보다 **전역 `prepare-commit-msg` 훅**이 낫다

목표(“커밋 메시지의 trailer를 치환”)에 대해 래퍼는 실행 경로를 가로채고, 훅은 데이터를
가로챈다. 이 경우엔 후자가 명백히 우위다.

- **커버리지**: 래퍼는 argv를 파싱해야 하는데 실제 커밋 경로가 너무 많다 —
  `-m`, `-F`, 에디터, `--amend`, `rebase`/`cherry-pick`/`revert`의 재커밋, `git -C`,
  `git -c`, alias. 훅은 이 전부에서 **메시지 파일 경로 하나**로 동일하게 호출된다.
- **파싱 취약성 없음**: 훅은 `$1`이 메시지 파일. argv 해석이 아예 필요 없다.
- **자기 재귀 위험 없음**: 래퍼는 `/usr/local/bin/git`이 `/usr/bin/git`을 부르는
  구조라 PATH가 흐트러지면 무한 재귀한다. 참고로 지금 `bin/`의 스크립트들
  (`xclip`, `wl-copy`, `code`, `copy`)은 **전부 "실제 동명 바이너리를 다시 부르는"
  케이스가 아니다** — 이 레포에 그 패턴의 선례가 없다.
- **supervisord/에이전트 영향 없음**: 래퍼는 컨테이너 안 모든 git 호출(webmanager의
  `internal/gitconfig`가 쓰는 `git config` 포함)을 통과시킨다. 훅은 커밋할 때만 돈다.

### 훅 방식의 유일한 실질 단점과 대응

전역 `core.hooksPath`는 각 repo의 `.git/hooks/`를 **덮어쓴다**. 그래서 훅 스크립트가
끝에 `$GIT_DIR/hooks/prepare-commit-msg`가 있으면 그쪽으로 체이닝해야 한다. 잘 알려진
관용구이고 5줄이면 된다. 이걸 안 하면 남의 repo 훅을 조용히 죽인다.

## 설계

### 훅 위치

- 스크립트: `config/git/hooks/prepare-commit-msg`(override 패턴 적용 가능하게
  `.default`/`.override` 쌍), Dockerfile이 `/etc/code-docker/git/hooks/`로 COPY
- 배선: `user-init.default.sh`에서 `git config --global core.hooksPath` 설정.
  `.gitconfig`는 `/code/.gitconfig`(`webmanager/backend/config.go:171`,
  `GIT_CONFIG_PATH`로 오버라이드 가능)라 `/code` 볼륨에 남는다 → 재빌드에 안 날아감

### 치환 규칙

입력에서 잡아야 하는 것 (하네스가 실제로 붙이는 것들):

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_...
```

동작:

- `Co-Authored-By:` 중 이메일이 `@anthropic.com`인 줄을 대상으로 한다
  (이름 문자열이 아니라 **이메일 도메인**으로 매칭 — 모델명이 계속 바뀌므로)
- 설정된 이름/이메일로 치환. 모델명 보존 옵션이 켜져 있으면 원본에서 이름 부분을
  뽑아 `()`로 감싸 뒤에 붙임:
  `Co-Authored-By: qwreey-bot (Opus 5) <bot@qwreey.moe>`
- 중복 제거 — 이미 같은 trailer가 있으면 추가하지 않음
- `Claude-Session:` 줄은 별도 옵션으로 제거(기본 제거 권장). 이건 claude.ai 세션 URL이
  **공개 repo 커밋에 그대로 남는다**는 점에서 취향이 아니라 프라이버시 항목이다
- 이름/이메일이 비어 있으면 `user.name`/`user.email`로 폴백

### 설정 저장 위치

`git config` 키로 저장한다(전용 파일 신설 안 함). 기존 `internal/gitconfig`가 전부
`git config -f <path> --get/--unset` 헬퍼(`user.go`의 `getConfig`/`setConfig`)로
돌아가므로 그대로 얹힌다.

```
codedocker.aitrailer.enabled      = true|false
codedocker.aitrailer.name         = qwreey-bot
codedocker.aitrailer.email        = bot@qwreey.moe
codedocker.aitrailer.keepModel    = true|false
codedocker.aitrailer.stripSession = true|false
```

훅 스크립트는 `git config --get`으로 직접 읽는다 → **webmanager가 안 떠 있어도 동작**.

### webmanager 쪽

`internal/gitconfig/aitrailer.go` 신설 — `signing.go`와 동일한 모양
(구조체 + `GetAITrailer`/`SetAITrailer`), 핸들러는 `handlers_git_aitrailer.go`,
프론트는 Git 설정 탭에 섹션 추가. 미리보기(치환 후 trailer가 어떻게 보이는지) 한 줄을
같이 보여주면 설정 의미가 바로 전달된다.

## 검증

훅 특성상 유닛 테스트가 어렵다. 대신 임시 repo에서 케이스별 수동 확인:
`-m` / 에디터 / `--amend` / `rebase -i`의 reword / 이미 치환된 메시지 재커밋(멱등성) /
`.git/hooks/prepare-commit-msg`가 이미 있는 repo(체이닝) / trailer가 아예 없는 커밋.

## 대안(래퍼)을 남겨둘 것인가

훅으로 못 잡는 유일한 케이스는 `git commit --no-verify`다. 에이전트가 그걸 쓸 이유는
거의 없으므로 래퍼는 만들지 않는다. 필요해지면 그때 추가.

## 구현하며 바뀐 것 (2026-09-04)

원안대로 안 간 지점이 셋. 전부 실측으로 드러난 것들이라 근거를 남겨둠.

### 1. `prepare-commit-msg` 하나로는 부족했다 → `commit-msg`도 같이 건다

원안은 "훅은 모든 커밋 경로에서 메시지 파일 하나로 호출된다"였는데, **호출 시점**을
빼먹었다. `prepare-commit-msg`는 **에디터가 열리기 전에** 돈다. 그래서 `git rebase -i`의
reword처럼 에디터에서 직접 타이핑/붙여넣기 한 trailer는 못 잡는다 — 시퀀서가 *이전*
메시지에 대해 훅을 돌리고, 그 뒤에 에디터가 파일을 통째로 갈아치우기 때문(git 2.55에서
`prepare-commit-msg fired: ... src=commit` 로그로 확인).

반대로 `commit-msg`는 에디터 뒤에 돌지만 `--no-verify`에 건너뛰어진다. 그래서 둘 다 건다.
치환이 멱등이라(출력 주소가 `@anthropic.com`이 아니므로 2회차에는 아무것도 매칭 안 됨)
두 번 도는 게 안전하다. 실제 로직은 `ai-trailer.sh` 한 파일이고 두 훅 파일은 그걸
`exec`하는 래퍼다.

### 2. 전역 `core.hooksPath`는 `prepare-commit-msg`만 죽이는 게 아니었다

원안의 "체이닝 5줄이면 된다"는 과소평가였다. `core.hooksPath`는 그 저장소의
`.git/hooks/`를 **모든 훅에 대해** 대체한다 — 디렉터리에 있는 훅만이 아니라. 즉
`prepare-commit-msg` 하나만 두면 컨테이너 안 모든 프로젝트의 husky / pre-commit /
lefthook / 손으로 쓴 훅이 **아무 에러 없이** 전부 죽는다.

그래서 `hook-dispatch` 하나를 두고 Dockerfile이 git 훅 이름 전부(23개)를 거기로
심볼릭 링크한다. 이 스크립트가 저장소 자신의 훅으로 체이닝한다. 순서는 **저장소 훅 먼저,
우리 것 나중** — 우리 건 정규화 패스라 마지막에 도는 게 맞고, 커밋을 거부하는 프로젝트
훅이 있으면 헛수고를 먼저 막아준다. 하나만 존재할 땐 `exec`해서 stdin을 읽는 훅
(`pre-push`, `pre-receive`, `post-rewrite`)이 그대로 받게 한다.

**함정**: 저장소 훅 경로를 `git rev-parse --git-path hooks/<name>`으로 구하면 안 된다.
이건 `core.hooksPath`를 존중해서 **이 디렉터리 자신**을 돌려주고, 무한 재귀한다
(git 2.55에서 확인). `--absolute-git-dir`을 쓴다.

### 3. 기본값은 꺼짐, 그리고 `core.hooksPath`를 절대 덮어쓰지 않음

`enabled` 기본값을 켜짐으로 두면, 이름/이메일 미설정 상태에서 원안의
`user.name`/`user.email` 폴백이 co-author를 **커밋 작성자 자신으로** 치환한다 — 무의미.
그래서 기본 꺼짐.

`user-init.default.sh`는 `core.hooksPath`가 이미 설정돼 있으면 건드리지 않고 로그로
알린다(전역 슬롯 하나뿐이라 조용히 뺏으면 사용자가 걸어둔 게 죽는다). 그 상태에선 이
기능이 아예 안 도는데 UI에서 켜면 켜진 것처럼 보이므로, `GET /api/git/ai-trailer`가
`hookActive`를 같이 내려주고 프론트가 경고 배너를 띄운다.

## 검증 결과

호스트의 임시 저장소에서 케이스별로: `-m` / `-F` / 에디터 / `--amend` / `rebase -i`
reword / `--no-verify` / cherry-pick / revert / 멱등성 / 이미 훅이 있는 저장소(체이닝) /
저장소 훅의 커밋 거부 / trailer 없는 커밋 / `commit -v`의 diff 안 trailer(scissors 아래)
/ 중복 제거 / `enabled=false`. 그 다음 실제 이미지를 빌드해 컨테이너 안에서
기본 꺼짐 상태 → 켠 상태 → 저장소 훅 체이닝, 그리고 webmanager API로
쓴 설정을 훅이 읽는 것(git이 키 이름을 소문자로 저장하는데 `--get`이
대소문자 무시라 문제없음)까지 확인.

## 이 기능이 이상할 때 (후행 에이전트용)

구현: 커밋 `2416f82`. 파일은 `config/git/hooks/`(훅 4개),
`webmanager/backend/internal/gitconfig/aitrailer.go` + `handlers_git_aitrailer.go`,
`webmanager/frontend/src/components/GitConfig/AiTrailer.tsx`, 그리고 Dockerfile의
심볼릭 링크 `RUN`과 `config/user-init/user-init.default.sh`의 `core.hooksPath` 설정.

### 먼저 확인할 3가지

```sh
docker compose exec code-docker git config --global --get core.hooksPath
#  -> /etc/code-docker/git/hooks 여야 함. 아니면 훅이 아예 안 돈다.
#     user-init이 기존 값을 덮어쓰지 않으므로 이럴 수 있고, 부팅 로그에 이유가 찍힌다.

docker compose exec code-docker git config --global --get-regexp '^codedocker\.aitrailer'
#  -> git이 키를 소문자로 저장한다(keepmodel/stripsession). 정상이다.
#     --get은 대소문자 무시라 훅/Go 양쪽 모두 그대로 읽힌다.

docker compose exec code-docker ls -la /etc/code-docker/git/hooks | head
#  -> 훅 이름 23개가 전부 hook-dispatch 심볼릭 링크여야 한다.
```

### 훅이 도는지 직접 보기

`ai-trailer.sh`는 조용히 종료하는 경로가 많다(비활성 / 이름·이메일 둘 다 없음 /
`$1`이 없거나 파일이 아님). 어디서 빠져나가는지 보려면 임시로 `set -x`를 넣지 말고
스크립트 맨 위에 한 줄 추가하는 편이 빠르다:

```sh
echo "ai-trailer: $* cfg=$(git config --get codedocker.aitrailer.enabled)" >> /tmp/ai-trailer.log
```

### 안 잡히는 케이스 (버그가 아니라 설계상 범위 밖)

- **컨테이너 밖에서 만든 커밋.** 훅은 이 이미지 안에만 있다. 호스트에서 커밋하면
  raw trailer가 그대로 남는다.
- **이미 만들어진 커밋의 히스토리.** 훅은 새 커밋에만 돈다. 과거 커밋을 고치려면
  `git rebase -i`로 reword 하거나 `git filter-repo`를 써야 하고, 후자는 훅을 안 탄다.
- **`--no-verify` + 에디터에서 직접 타이핑한 trailer.** `--no-verify`가 `commit-msg`를
  건너뛰고, `prepare-commit-msg`는 에디터보다 먼저 돈다. 둘 다 못 잡는 유일한 교집합인데
  실사용에서 나올 조합이 아니라 대응 안 했다.
- **git CLI를 안 쓰는 클라이언트.** libgit2/JGit 기반(일부 GUI)은 훅을 아예 안 탄다.
  VS Code 내장 git은 git CLI를 쓰므로 정상 동작한다.

### 고칠 때 조심할 것

- `ai-trailer.sh`의 awk는 **scissors 줄 아래를 건드리지 않는다**(`commit -v`의 diff).
  이 가드를 지우면 diff 안의 trailer처럼 보이는 줄까지 치환될 수 있다.
- 멱등성이 `commit-msg`/`prepare-commit-msg` 이중 실행의 전제다. 출력 trailer의
  이메일이 `@anthropic.com`이 되는 변경(예: 이메일 폴백을 harness 주소로)을 넣으면
  무한 치환/중복이 생긴다.
- `hook-dispatch`에서 저장소 훅 경로를 `git rev-parse --git-path hooks/<name>`으로
  바꾸면 **무한 재귀**한다. `--absolute-git-dir`을 유지할 것.
