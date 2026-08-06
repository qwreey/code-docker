# router

`code-docker-router`는 code-docker의 네트워크 경계를 전담하는 별도 컨테이너입니다.
`code-docker-internal`(사설, code-docker/dind가 붙는 망)과 `code-docker-external`(진짜
인터넷으로 나가는 망) 양쪽에 다리를 걸친 유일한 컨테이너로, code-docker보다 신뢰
수준이 높습니다. 네 가지 기능을 담당합니다:

1. **아웃바운드 격리(netgate)** — RFC1918/사설망 차단, DNS 레벨(dnsmasq) 콘텐츠
   블록리스트, 인바운드 포트포워딩. 자세한 내용은 [egress-netgate.md](egress-netgate.md).
2. **tailscale** — 데몬+로그인+포트 가져오기(forwards)+포트 내보내기(publish). 아래 참고.
3. **Dev Proxy** — 컨테이너 안 dev 서버를 도메인으로 노출. 자세한 내용은
   [dev-proxy.md](dev-proxy.md).
4. **tinyauth** — Dev Proxy 개별 라우트를 보호하는 가벼운 forward-auth.

이렇게 한데 모은 이유(신뢰 경계가 code-docker보다 명확한 지점에 네트워크 관련 정책을
집중시킨다는 설계)는
[`.claude/backlog/functional-router-plan.md`](../.claude/backlog/functional-router-plan.md)에
정리되어 있습니다.

## tailscale

`docker-compose.yml`의 `TAILSCALE_ENABLED`(기본 `"true"`)로 켜고 끕니다 — `"false"`면
`tailscaled`/`tailscale-forward`/`tailscale-publish` 세 프로그램이 router 컨테이너
안에서 idle 상태로 떠 있습니다. router가 고유한 tailscale IP를 가지므로, tailnet 안
어디서든 code-docker에 접근하거나(호스트 포트 게시 없이) code-docker에서 다른 tailnet
기기의 포트를 가져올 수 있습니다.

### 최초 로그인

자동 로그인 시도는 router 컨테이너 생애주기 동안 딱 한 번만 일어납니다(상태 디렉토리
안 마커 파일로 추적, code-docker 쪽과 동일한 self-DDoS 방지 이유). 로그인 URL은
`docker compose logs -f code-docker-router`로 확인하거나, code-server 화면 우측 상단
배너(같은 code-patch 메커니즘, `tailscale-notify.js`)로도 뜹니다 — 이제 이 배너는
router의 읽기전용 상태 API(`GET /tailscale/state`, code-docker의 nginx가 프록시)를
폴링합니다.

로그인 상태는 `${ROUTER_VOLUME:-./router-data}/tailscale/state`(호스트 경로)에
영속됩니다. 자동 시도를 놓쳤거나 소진된 상태라면 직접 로그인 서버 안으로 들어가야
합니다 — router 전용 재시도 UI는 아직 없습니다(아래 "아직 없는 것" 참고), 필요하면
`docker compose exec code-docker-router tailscale up`을 직접 실행하세요.

### 설정 파일 (forwards / publish)

`${ROUTER_VOLUME:-./router-data}/tailscale/config.yaml`(호스트 경로, 컨테이너
안에서는 `/var/lib/code-docker-router/tailscale/config.yaml`)을 편집합니다.

```yaml
forwards:
  - name: adb
    local_port: 5037
    remote_host: laptop          # tailscale hostname 또는 IP (MagicDNS 이름 아님)
    remote_port: 5037

publish:
  - name: dev-server
    tailscale_port: 80
    local_port: 3000
    mode: tcp                    # tcp | tls-terminated-tcp
```

- **forwards** — 다른 tailnet 기기의 포트를 가져옵니다. code-docker 안에서는 `forward`
  hostname으로 접근하세요(예: [adb 연결](tips/adb.md)의 `ANDROID_ADB_SERVER_ADDRESS=forward`) —
  이 alias는 이제 router를 가리킵니다(예전엔 code-docker 자신).
- **publish** — code-docker의 로컬 포트를 tailscale IP에 게시합니다. `publish:`의
  `local_port`는 이제 router가 아니라 **code-docker 자신**의 포트를 가리킵니다(router의
  `tailscale-publish` 프로그램이 `tcp://code-docker:<port>`로 타겟팅) — 게시하려는 서비스는
  code-docker 안에서 뜬 그대로 두면 됩니다.

편집 후 반영하려면 (지금은 code-docker 안에서 실행할 방법이 없습니다 — 아래 "아직 없는
것" 참고):

```sh
docker compose exec code-docker-router supervisorctl restart tailscale-forward tailscale-publish
```

호스트 원격 CLI로 이 명령을 실행하는 게 부담스럽다면, `bin/forward-reload`(code-docker
안 PATH에 있음)를 실행하면 이 안내가 그대로 출력됩니다.

### 호스트네임 지정 / 자체 호스팅 로그인 서버

`TAILSCALE_HOSTNAME`/`TAILSCALE_LOGIN_SERVER`(`docker-compose.yml`, `.env`)로 설정합니다 —
이제 router 컨테이너에 적용됩니다(기본 hostname은 `code-docker-router`, `code-docker`가
아님). MagicDNS 이름은 forwards/publish의 `remote_host` 등에 쓰지 마세요 — 동적으로
바뀔 수 있어 tailscale hostname/IP만 신뢰합니다
([functional-router-plan.md](../.claude/backlog/functional-router-plan.md) 참고).

### 보안

router는 이제 code-docker보다 신뢰 수준이 높은 유일한 국경 컨테이너이므로, tailscaled의
자동 loopback 노출 문제(예전엔 code-docker 자신의 tailscaled가 `private` alias로
우회해야 했음)가 code-docker 쪽에서는 완전히 사라졌습니다 — code-docker 자신은
tailscaled를 아예 실행하지 않기 때문입니다. sshd(22)/code-server(80)는 여전히 tailnet
ACL로 보호하는 걸 권장합니다(router가 명시적으로 forward/publish하지 않는 한 애초에
tailnet에서 도달 불가능하지만, sshd는 호스트 포트 게시를 위해 여전히 `0.0.0.0`에
바인드되어야 하는 code-docker 자신의 이야기입니다).

## tinyauth

Dev Proxy 라우트별 "인증 요구"를 지원하는 forward-auth입니다(공식 이미지
`ghcr.io/tinyauthapp/tinyauth`, 소스 빌드 아님 — pnpm 프론트엔드 빌드가 필수라 이
레포의 다른 Go 바이너리 빌드 패턴과 안 맞습니다). 기본적으로 아무도 로그인할 수 없는
상태로 시작합니다(`TINYAUTH_AUTH_USERS` 빈 값) — 사용하려면 `example-env`의 안내대로
사용자를 생성하세요:

```sh
docker run --rm ghcr.io/tinyauthapp/tinyauth:v5 user create \
  --username <name> --password <password> --docker
```

출력된 `TINYAUTH_AUTH_USERS=...` 줄을 `.env`에 붙여넣고, `TINYAUTH_APPURL`도
실제 도메인 형식(`https://code-docker.example.com`)으로 설정한 뒤
`docker compose up -d`로 재기동하세요. 자세한 사용법(라우트에 인증 요구 걸기)은
[dev-proxy.md의 "인증"](dev-proxy.md#인증)을 확인하세요.

## router-manager (읽기전용 API)

router는 `router-manager`라는 작은 Go 백엔드를 갖고 있습니다(webmanager와 같은 패턴).
지금은 두 가지만 제공합니다:

- `GET /tailscale/state`(code-docker의 nginx가 프록시, 인증 없음 — backendState/authUrl만
  노출하는 저위험 상태 조회) — code-server 화면의 로그인 배너가 여기서 읽습니다.
- Dev Proxy expose CRUD(`/dev-proxy/*`, 역시 nginx가 프록시) — webmanager의
  [Dev Proxy 탭](webmanager.md#dev-proxy)이 여기로 요청을 보냅니다.

## 아직 없는 것

- **router 전용 forwards/publish 관리 UI** — webmanager가 예전에 갖고 있던 Tailscale
  탭(forwards/publish CRUD, 로그인 트리거 버튼)은 router로 옮기면서 함께 옮기지
  않았습니다. router-manager 백엔드가 아직 읽기전용 상태 조회만 지원하기 때문입니다 —
  지금은 `config.yaml`을 직접 편집 + 위 명령으로 재시작하는 수밖에 없습니다.
- **router-manager 자체 API 인증** — `/tailscale/state`, `/dev-proxy/*` 모두 호스트
  포트가 열려있지 않다는 것에 의존해 인증 없이 열려 있습니다. UI가 생긴 지금 이 자체를
  tinyauth 등으로 보호할지는 아직 결정되지 않았습니다.
