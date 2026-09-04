# 에이전트 커밋 trailer 치환 계획

작성 2026-09-03. 아직 착수 전.

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
