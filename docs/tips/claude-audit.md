# Claude Code 작업 기록을 컨테이너 밖에 남기기

code-docker 안에서 Claude Code 에이전트를 돌릴 때, 에이전트가 무엇을 했고 무엇을
시도했는지 **나중에 검토할 기록**을 남기는 방법입니다. 실시간 승인 장치가 아니라 사후
검토용이고, 공격 자체를 막는 건 컨테이너 격리와 netgate, dind authz의 몫입니다.

## 왜 밖에 두나

Claude Code는 세션마다 프롬프트, 모델 응답, 툴 호출과 결과를 전부
`~/.claude/projects/<프로젝트>/<세션>.jsonl`에 씁니다(code-docker에서는
`/code/.claude/projects`, 호스트의 `${HOME_VOLUME:-./data/code}/.claude/projects`).
이 기록은 모델이 아니라 Claude Code가 직접 쓰니 빠짐없이 남습니다. 다만 두 가지가
걸립니다.

- 컨테이너 안에서 에이전트는 root라서 이 파일을 고치거나 지울 수 있습니다.
- Claude Code가 30일 지난 기록을 스스로 지웁니다(`cleanupPeriodDays`).

그래서 이 폴더를 **읽기 전용으로만** 보는 별도 컨테이너가 기록을 따라 읽으며,
code-docker가 마운트하지 않는 폴더에 이어 붙이게 합니다.

## 설정

아래 파일을 레포 루트에 `claude-audit.yml`로 저장하고(버전 관리 대상 아님), `.env`의
`EXTRA_INCLUDE`가 이 파일을 가리키게 한 뒤 `docker compose up -d` 하세요. 이미 다른
`extra-include.yml`을 쓰고 있다면 그 파일의 `include:`에 이 파일을 추가하면 됩니다.

```yaml
services:
  claude-audit:
    image: timberio/vector:0.57.0-alpine
    container_name: ${PREFIX:-}code-docker-claude-audit
    restart: unless-stopped
    network_mode: none
    volumes:
      - ${HOME_VOLUME:-./data/code}/.claude/projects:/src:ro
      - ${CLAUDE_AUDIT_VOLUME:-./data/claude-audit}:/audit
    configs:
      - source: claude-audit
        target: /etc/vector/vector.yaml
    command: ["--config", "/etc/vector/vector.yaml"]

configs:
  claude-audit:
    content: |
      data_dir: /audit
      sources:
        transcripts:
          type: file
          include: ["/src/**/*.jsonl"]
          read_from: beginning
          max_line_bytes: 67108864
          fingerprint:
            strategy: device_and_inode
      sinks:
        archive:
          type: file
          inputs: [transcripts]
          path: "/audit/%Y-%m-%d.jsonl"
          encoding:
            codec: json
```

- `network_mode: none`: 네트워크가 아예 없어서 code-docker 쪽에서 이 컨테이너에 닿을 길이
  없습니다.
- 원본은 `:ro`로만 보고, 보관 폴더(`CLAUDE_AUDIT_VOLUME`, 기본 `./data/claude-audit`)는
  code-docker에 마운트되지 않습니다.
- `max_line_bytes`: 툴 결과가 긴 줄은 vector 기본값(100KB)을 넘어서 버려지므로 크게 잡습니다.
- 처음 켜면 이미 있는 기록부터 읽고(`read_from: beginning`), 그 뒤로는 새로 붙는 줄을 따라갑니다.

## 기록 보기

보관본은 날짜별 파일이고, 한 줄이 원본의 한 줄입니다(`file`에 원본 경로, `message`에 원래
줄). 예를 들어 어떤 세션에서 실행한 Bash 명령만 뽑으려면:

```sh
jq -r 'select(.file | endswith("<세션 id>.jsonl")) | .message | fromjson
  | .message.content[]? | select(.type == "tool_use" and .name == "Bash") | .input.command' \
  data/claude-audit/*.jsonl
```

원본 JSONL 형식은 Claude Code 내부 형식이라 버전에 따라 바뀔 수 있습니다. 위 `jq`는 예시일
뿐이고, 사람이 읽기에는 webmanager의 Claude 탭 세션 로그 뷰어가 편합니다(보관본이 아니라
원본을 봅니다).

## 한계

- 에이전트가 원본 파일을 고치거나 지워도 이미 복사된 줄은 남습니다. 대신 같은 파일을 짧게
  덮어쓴 **새 내용**은 다시 읽히지 않을 수 있어서, "무엇이 지워졌는지"는 보관본과 원본을
  비교해야 보입니다.
- 에이전트가 `claude`를 다른 `CLAUDE_CONFIG_DIR`로 띄우거나 `--no-session-persistence`로
  돌리면 그 세션은 이 폴더에 남지 않습니다.
- 보관본은 계속 쌓이기만 합니다. 정리는 호스트에서 직접 하세요.

이벤트 단위로 밖의 서버에 보내고 싶다면 Claude Code의 HTTP 훅(`managed-settings.json`)이나
OpenTelemetry 내보내기도 있습니다 — 설계 메모는 `.claude/backlog/agent-fleet-audit-plan.md`.
