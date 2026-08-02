# tailscale IP 할당 조사 (구현 완료)

code-docker 컨테이너가 고유한 tailscale IP를 갖도록 하는 방법 조사. 아래 설계대로 구현 완료됨 - 사용자 문서는 `README.md` 의 "tailscale 연결" 절 참고. 이 파일은 설계 배경/근거 기록용으로 남겨둠 (남은 작업 중 5, 8번의 런타임 검증은 실제 tailnet 계정이 필요해 로컬에서 수동으로 확인 필요).

> **네이밍 참고**: 아래 본문의 alias 이름(`code-docker-dind-internal`, `code-docker-internal-self`, `forwards`)은 조사 당시 이름이고, 실제 구현에서는 `dind`/`private`/`forward` 로 더 짧게 정리됨. 최신 이름은 `docker-compose.yml`/`README.md`/`CLAUDE.md` 참고.

> 이 저장소의 일반적인 구조/컨벤션(override 패턴, supervisord 프로세스 모델, docker-compose 토폴로지 등)은 저장소 루트의 `CLAUDE.md` 를 참고. 구현 착수 전에 먼저 읽을 것.

> 이전 버전(첫 조사)에서는 커널 tun + `NET_ADMIN` 방식을 검토했으나, 컨테이너에 과한 권한이라 판단하여 폐기함. userspace networking 만으로 필요한 두 방향(수신/발신)을 모두 처리할 수 있다는걸 확인해서 아래 내용으로 대체함.

## 방향: userspace networking (NET_ADMIN, tun 불필요)

`tailscaled --tun=userspace-networking` 로 실행하면 커널 tun 디바이스나 `NET_ADMIN` 없이도 아래 두 가지가 모두 가능함.

### 1. 수신 (다른 tailnet 기기 → code-docker) — 별도 설정 없이 기본 동작

userspace 모드에서 tailscaled 는 실제 네트워크 인터페이스가 없는 가상 netstack(gVisor 기반)으로 WireGuard 터널을 종단시킴. 그래서 **정확히 말하면 어떤 프로세스가 tailscale IP에 직접 `bind()` 하는건 불가능함** — 그 IP를 가진 실제 커널 인터페이스가 없어서 bind 자체가 실패함 (커널 tun 모드에서만 가능, 우리는 의도적으로 안 씀). 대신 tailscaled 의 netstack 이 인바운드 연결을 **자동으로 같은 포트의 `127.0.0.1` 로 포워딩**해줌 — 결과적으로 "IP를 할당받고 나서 거기에 bind"한 것과 동일한 효과를 냄. 즉 개발 서버가 `0.0.0.0:80` 이나 `localhost:80` 에 평범하게 bind 하고 있으면, 노트북에서 tailscale hostname(예: `tailscale up --hostname=code-docker-tail` 로 지정한 `code-docker-tail`)로 `code-docker-tail:80` 접속 시 별도 포워딩 설정 없이 그대로 연결됨. sshd, code-server 등 기존에 열려있는 포트도 마찬가지.

- 이건 tailscaled 코어(netstack) 자체의 동작이고 공식 도커 이미지의 containerboot 전용 기능이 아님 — 실제로 tailscaled 자신이 내는 에러 메시지(`netstack: could not connect to local backend server at 127.0.0.1:PORT`, [tailscale/tailscale#13931](https://github.com/tailscale/tailscale/issues/13931))로 확인됨. pacman 으로 tailscale 을 직접 설치해도(=공식 docker 이미지의 containerboot 없이) 동일하게 동작해야 함.
- 알려진 캐비앗 하나: tailscaled 시작 직후 잠깐 인바운드 포워딩이 바로 안 될 수 있음 ([tailscale/tailscale#2642](https://github.com/tailscale/tailscale/issues/2642)). 별도 대응은 불필요, 클라이언트가 재시도하면 됨.
- `code-docker-tail` 같은 tailscale hostname 으로 노트북에서 접속하려면 MagicDNS 가 필요한데, 이건 **노트북 쪽** OS의 tailscale 클라이언트가 알아서 처리하는 부분이라(tailnet 관리 콘솔에서 MagicDNS 켜져있으면 기본으로 됨) code-docker 쪽에서 별도로 할 일은 없음.

#### `tailscale serve` — 특정 로컬 포트를 명시적으로 게시하는 네이티브 기능 (추가 조사)

위 자동 포워딩 말고, tailscale 자체에 로컬 포트를 tailscale IP에 명시적으로 매핑하는 커맨드가 실제로 존재함: [`tailscale serve`](https://tailscale.com/docs/reference/tailscale-cli/serve).

```sh
# tailscale IP의 80번 포트를, 로컬 3000번에서 뜨는 dev 서버로 연결 (raw TCP, 포트 리매핑)
tailscale serve --bg --tcp=80 tcp://localhost:3000
tailscale serve status          # 현재 게시된 목록 확인
tailscale serve reset           # 전부 초기화
```

- `-bg` 를 붙여야 tailscaled 재시작 후에도 규칙이 유지됨.
- 같은 포트일 필요가 없음 — tailscale IP 쪽 포트와 로컬 포트를 다르게 매핑 가능 (위 예시가 80→3000). HTTP(S) 모드(`tailscale serve https:443 / http://localhost:3000`)를 쓰면 Tailscale이 발급하는 진짜 인증서로 HTTPS 종단까지 공짜로 됨.
- userspace 모드에서도 동작함 — 공식 `tailscale/tailscale` 도커 이미지가 기본값이 userspace 모드인 채로 `TS_SERVE_CONFIG` 환경변수를 지원하는 것 자체가 방증이고, `tailscale/tailscale` 저장소의 `wgengine/netstack/netstack.go` 소스를 직접 읽어봐도 커널 tun 여부와 무관하게 동작하는 경로로 구현되어 있음.

**중요 — 이걸로 "명시한 포트만 열리게" 제한할 수 있는 건 아님.** `netstack.go` 의 `acceptTCP()` 로직을 직접 읽어보면:

```go
if ns.lb != nil {
    handler, opts := ns.lb.TCPHandlerForDst(clientRemoteAddrPort, dstAddrPort)
    if handler != nil { ... handler(c); return }
}
...
switch {
...
case isTailscaleIP:
    dialIP = ipv4Loopback   // <- serve 규칙이 없는 포트는 전부 이 기본 동작으로 fallback
}
```

즉 `tailscale serve` 규칙이 있는 포트는 그 규칙(리매핑/TLS 등)이 우선 적용되지만, **규칙이 없는 나머지 모든 포트는 여전히 위에서 설명한 "같은 포트로 localhost 자동 포워딩" 기본 동작이 그대로 적용됨**. 즉 `tailscale serve` 자체는 화이트리스트/차단 메커니즘이 아니라 "몇몇 포트를 더 세련되게(리매핑, HTTPS) 게시하는" 추가 기능일 뿐, 그것만으로는 나머지 포트 노출을 막지 못함. (노출 범위를 실제로 제한하는 두 가지 방법은 아래 "보안 주의사항 > 노출 범위를 실제로 제한하는 방법" 참고 - tailnet ACL, 그리고 bind 주소를 이용한 로컬 opt-in.)

**계획 반영**: 이 기능은 유용하니 채택하되, 역할을 정확히 표시함 — `config.yaml`의 `forwards:`(발신, socat)와 별개로 `publish:` 섹션을 추가해서, dev 서버처럼 "다른 포트로 리매핑하고 싶거나 HTTPS로 깔끔하게 열고 싶은" 케이스에 명시적으로 쓰도록 함. 그냥 같은 포트로만 접근해도 되는 경우(sshd, code-server 등)는 위 자동 포워딩으로 충분하니 `publish:` 에 넣을 필요 없음.

#### 참고: 발신(SOCKS5) 쪽에서 MagicDNS 이름을 쓰려면

`config.yaml` 의 `forwards:` 에서 `remote_host: laptop` 처럼 MagicDNS 이름을 쓰려면 반대로 **code-docker 자신의** DNS 조회가 tailscale 의 MagicDNS 서버(`100.100.100.100`)를 거쳐야 하는데, userspace 모드라 실제 `tailscale0` 인터페이스가 없어서 OS가 이 nameserver 를 자동으로 추가해주지 않음. `/etc/resolv.conf` 에 `nameserver 100.100.100.100` 을 직접 추가하거나, 그냥 MagicDNS 이름 대신 tailnet 관리 콘솔에서 확인 가능한 tailscale IP(`100.x.y.z`)를 직접 적으면 됨 (이건 사용자가 상황에 맞게 채워넣는 설정값이지 코드에 박아넣는 하드코딩이 아님). 실제 빌드해보고 어느 쪽이 더 편한지 확인 필요.

### 2. 발신 (code-docker → 다른 tailnet 기기의 포트를 가져오기) — SOCKS5 + socat

userspace 모드에서 새로 나가는 연결은 tailscaled 가 띄우는 SOCKS5(또는 HTTP) 프록시를 거쳐야 함. `tailscaled --socks5-server=localhost:1055` 로 로컬에만 열리는 SOCKS5 프록시를 켜두고, `socat` 이 SOCKS5 주소 타입을 네이티브로 지원하므로 아래처럼 원격 포트를 로컬 포트에 그대로 바인드할 수 있음.

```sh
# 노트북(호스트네임: laptop)의 adb 서버(5037)를 code-docker 컨테이너의 localhost:5037 로 바인드
socat TCP-LISTEN:5037,fork,reuseaddr SOCKS5:localhost:1055:laptop:5037
```

이렇게 하면 컨테이너 안에서는 `adb devices` 가 로컬 소켓을 쓰듯 그대로 동작함 (현재 README에 있는 `ssh -R 5037:localhost:5037 code -TN` 방식의 대안이 됨).

**중요 — 위 예시처럼 loopback 에 바인드하면 안 됨 (재노출 문제).** "1. 수신" 절에서 확인했듯 tailscale 의 fallback 은 `127.0.0.1`/`0.0.0.0` 에 떠있는 건 전부 tailscale IP 로 그대로 재노출함. 그런데 이 `socat TCP-LISTEN` 도 결국 loopback 에 리슨하는 서비스이므로, ACL 로 code-docker 접근 권한만 준 다른 tailnet 기기(예: 휴대폰)가 있다면 그 기기가 code-docker 를 거쳐 **laptop 의 adb 서비스까지 투명하게 재노출받음** — laptop 소유자가 그런 권한을 준 적이 없는데도. `forwards:` 로 가져온 모든 항목이 이 문제를 갖고 있음. 해결책은 아래 "노출 범위를 실제로 제한하는 방법 > 방법 2" 참고 - `TCP-LISTEN` 을 loopback 이 아니라 전용 네트워크의 자기 자신 IP 에 바인드해야 함. (정확한 socat 문법은 `TCP-LISTEN:<port>,bind=<주소>,...` 임 - 주소를 포트 앞에 붙이는 게 아니라 `bind=` 옵션으로 지정. 위 예시와 아래 재시도 예시는 개념 설명용이라 아직 이 옵션이 빠져있음, 최종 문법은 "방법 2" 참고.)

**socat 이 꼭 필요한지 확인함**: tailscale CLI 자체에 이 방향(원격 피어의 포트를 로컬에 지속적으로 바인드)을 대체할 커맨드가 있는지 찾아봤으나 없음. 가장 가까운 게 [`tailscale nc <host> <port>`](https://tailscale.com/kb/1080/cli) 인데, 이건 stdin/stdout 에 파이프하는 1회성 연결(넷캣과 동일한 모델)일 뿐 리스닝 소켓을 만들어주진 않음 — 즉 `tailscale nc` 를 쓰더라도 매 접속마다 그걸 새로 실행해줄 리스너(=socat 같은 도구)가 어차피 필요함. `tailscale serve`/`funnel` 도 전부 반대 방향(로컬 → tailnet 게시)만 지원함. 그래서 이 방향엔 socat(또는 동급의 범용 프록시 도구)이 여전히 필요하다는 결론.

### socat 재시도 (피어가 죽어있어도 전체가 죽지 않게) — 조사 결과

- **`TCP-LISTEN:...,fork` 는 이미 안전함**: `fork` 옵션을 쓰면 각 접속마다 자식 프로세스가 처리를 맡고, 부모(리스닝 소켓)는 자식의 성패와 무관하게 계속 살아서 다음 접속을 받음. 즉 피어(예: laptop)가 죽어서 특정 연결이 실패해도 리스너 자체나 다른 포워딩엔 영향이 없음. socat의 fork-서버 모델 자체가 원래 이렇게 동작함.
- **연결 재시도는 기본값이 아님**: socat의 `retry=<n>` 옵션 기본값은 **0** (딱 1번만 시도). 재시도를 하려면 `forever`(무한 재시도) 또는 `retry=<n>`(최대 n회)을 명시적으로 켜야 함. 재시도 간격 옵션명은 `intervall`(오타처럼 보이지만 socat 공식 옵션명, l 이 두개), 기본값 1초.
- 이 옵션들은 tcp4/tcp6 connect/listen 주소와 그 파생 주소(socks, proxy, openssl 등)에 전부 적용 가능 — 지금 쓰려는 `SOCKS5:` 주소에도 그대로 적용됨. 즉 SOCKS5 대상 주소 쪽에 `forever,intervall=N` 을 붙이면, 접속 시점에 피어가 잠깐 죽어있어도 즉시 거부하지 않고 N초 간격으로 계속 재시도하다가 피어가 돌아오면 그대로 이어짐 (클라이언트 입장에선 연결이 조금 늦게 붙는 정도로 보임).

```sh
# retry_intervall(초)을 설정 가능하게 만들 값
socat TCP-LISTEN:5037,fork,reuseaddr SOCKS5:localhost:1055:laptop:5037,forever,intervall=5
```

## 동적 설정: YAML + yq (유저가 재빌드 없이 포워딩 추가/제거)

너무 정교한 sh 파싱(cut/awk 손조립)을 짜지 않기 위해, 설정 포맷을 YAML로 하고 Arch 공식 `extra/yq` 패키지([mikefarah/yq](https://github.com/mikefarah/yq), jq 스타일 문법으로 YAML을 다루는 Go 바이너리, `docker` 처럼 무거운 의존성 없음)로 파싱함. 새 볼륨을 추가할 필요 없이, 이미 persist 되는 `/code` (호스트의 `./code`) 안에 설정을 두면 됨.

- `/code/.tailscale/state/` — `tailscaled` 상태 디렉터리 (`--state=`). 재시작해도 로그인 상태 유지.
- `/code/.tailscale/config.yaml` — 유저가 직접 편집하는 발신(`forwards`)/수신 게시(`publish`) 목록:
  ```yaml
  socks5_address: localhost:1055   # tailscaled 의 SOCKS5 리슨 주소, 보통 안건드림
  retry_intervall: 5               # forwards 의 기본 재시도 간격(초), 항목별 override 가능

  # 발신: 다른 tailnet 기기의 포트를 code-docker 로컬 포트로 가져옴 (socat + SOCKS5).
  # local_port 는 전용 네트워크(code-docker-forwards)의 $FORWARDS_IP 에 리슨함 -
  # loopback 아님, publish 용 $INTERNAL_IP 와도 분리된 별도 주소(포트 겹침 방지).
  # 컨테이너 안에서는 IP 대신 그냥 hostname "forwards" 로 접근 가능함
  # (예: adb 처럼 localhost 를 기대하는 클라이언트는 ANDROID_ADB_SERVER_ADDRESS=forwards).
  # 자세한 이유는 아래 "방법 2" 참고.
  forwards:
    - name: adb                    # 로그/디버깅용 이름표
      local_port: 5037
      remote_host: laptop
      remote_port: 5037
    - name: chrome-debug
      local_port: 9222
      remote_host: workstation
      remote_port: 9222
      retry_intervall: 15          # 이 항목만 다른 간격을 쓰고 싶을 때 override

  # 수신: code-docker 로컬 포트를 tailscale IP에 명시적으로 게시 (`tailscale serve`).
  # local_port 로 지정한 서비스는 $INTERNAL_IP 에 bind 되어있어야 함 (예: dev 서버를
  # --host=$INTERNAL_IP 로 실행) - 그래야 비공개 기본값 + 이 목록만 opt-in 노출이 성립함.
  # 참고: 여기 없어도 서비스가 0.0.0.0/localhost 에 떠있으면 같은 번호로 자동 노출됨
  # (위 "1. 수신" 참고) - 이 목록은 그것과 별개로, $INTERNAL_IP 에 있는 걸 포트
  # 리매핑하거나 HTTPS로 게시하고 싶을 때 씀.
  publish:
    - name: dev-server
      tailscale_port: 80
      local_port: 3000
      mode: tcp                    # tcp | tls-terminated-tcp
  ```
- 매니저 스크립트 의사코드 (`yq` 로 파싱, `jq` 스타일 필터). `trap` 으로 SIGTERM/SIGINT 을 받으면 띄워둔 `socat` 들에게 직접 전달해서 graceful 하게 죽도록 함 — 안 그러면 supervisord 가 매니저 스크립트만 죽이고 자식 `socat` 들은 orphan 으로 남거나, `stopwaitsecs` 넘어가서 전부 SIGKILL 당함. `publish:` 는 `tailscaled` 자체가 들고있는 영속 상태라서 종료 시엔 안 건드리고(그대로 유지), 시작할 때만 `reset` 후 YAML 기준으로 다시 적용해서 YAML 에서 지운 항목이 자동으로 해제되도록 함:
  ```sh
  #!/bin/sh
  set -eu

  CONFIG=/code/.tailscale/config.yaml
  pids=""

  # 이미 accept된 연결(fork로 뜬 자식)은 건드리지 않고 그대로 끝까지 살려둠 -
  # 여기서 정리하는건 새 연결을 더 받지 않도록 socat 리스너(부모)만 내리는 것.
  # tailscale serve 쪽 상태는 tailscaled 가 들고있는 영속 설정이라 건드리지 않음.
  cleanup() {
      trap - TERM INT
      for pid in $pids; do
          kill "$pid" 2>/dev/null || true
      done
      for pid in $pids; do
          wait "$pid" 2>/dev/null || true
      done
      exit 0
  }
  trap cleanup TERM INT

  # tailscaled 로그인 완료까지 대기 (SOCKS5/serve 둘 다 로그인 세션 필요)
  until tailscale status --json 2>/dev/null | yq -e '.BackendState == "Running"' >/dev/null; do
      sleep 1
  done

  # code-docker 자신의 IP 두 개 - loopback 대신 여기에 바인드해서 fallback 으로
  # tailnet 전체에 재노출되지 않게 함 (아래 "노출 범위를 실제로 제한하는 방법 >
  # 방법 2" 참고). forwards/publish 를 별도 네트워크로 분리해서 포트 네임스페이스가
  # 서로 안 겹치게 함.
  FORWARDS_IP=$(getent hosts forwards | awk '{ print $1; exit }')
  INTERNAL_IP=$(getent hosts code-docker-internal-self | awk '{ print $1; exit }')

  socks5=$(yq '.socks5_address' "$CONFIG")
  default_intervall=$(yq '.retry_intervall // 5' "$CONFIG")

  # 발신: forwards -> socat 로 계속 살려둠. loopback 이 아니라 $FORWARDS_IP 에 리슨.
  # (socat 의 바인드 주소 문법은 포트 앞이 아니라 bind= 옵션임)
  count=$(yq '.forwards | length' "$CONFIG")
  i=0
  while [ "$i" -lt "$count" ]; do
      local_port=$(yq ".forwards[$i].local_port" "$CONFIG")
      remote_host=$(yq ".forwards[$i].remote_host" "$CONFIG")
      remote_port=$(yq ".forwards[$i].remote_port" "$CONFIG")
      intervall=$(yq ".forwards[$i].retry_intervall // $default_intervall" "$CONFIG")
      socat TCP-LISTEN:"$local_port",bind="$FORWARDS_IP",fork,reuseaddr \
          SOCKS5:"$socks5":"$remote_host":"$remote_port",forever,intervall="$intervall" &
      pids="$pids $!"
      i=$((i + 1))
  done

  # 수신: publish -> tailscale serve 는 한 번만 적용하면 되는 선언적 설정이라
  # 매번 reset 후 YAML 기준으로 다시 씀 (YAML에서 지운 항목이 실제로 해제되도록).
  # 로컬 타겟도 $INTERNAL_IP - 게시하려는 서비스가 $INTERNAL_IP 에 bind 되어있다고 가정.
  tailscale serve reset
  pcount=$(yq '.publish | length' "$CONFIG")
  j=0
  while [ "$j" -lt "$pcount" ]; do
      tport=$(yq ".publish[$j].tailscale_port" "$CONFIG")
      lport=$(yq ".publish[$j].local_port" "$CONFIG")
      mode=$(yq ".publish[$j].mode // \"tcp\"" "$CONFIG")
      tailscale serve --bg --"$mode"="$tport" "tcp://$INTERNAL_IP:$lport"
      j=$((j + 1))
  done

  wait
  ```
- 이 스크립트를 supervisord program 으로 등록 (`sshd-service.*.sh` 와 동일한 override 패턴: `tailscale-forward.default.sh`).

### tailscaled / tailscale-forward: 별도 supervisord program 으로 분리

`tailscaled` 데몬과 forward 매니저 스크립트는 같은 프로그램으로 묶지 않고 처음부터 별도 supervisord program 으로 등록함 (`[program:tailscaled]`, `[program:tailscale-forward]`):

- `config.yaml` 을 고쳐서 `tailscale-forward` 만 재시작해도 `tailscaled` 의 로그인 세션엔 영향이 없어야 함. 합쳐놨으면 forward 하나 바꿀 때마다 tailscaled 까지 같이 내려갔다 올라와서 다른 forward 연결들까지 전부 끊김.
- 반대로 tailscaled 가(네트워크 문제 등으로) 죽어도 `tailscale-forward` 와 독립적으로 supervisord 가 tailscaled 만 재시작 가능.

### 리로드용 bin 명령

`config.yaml` 수정 후 반영은 `tailscale-forward` supervisord program 재시작만으로 충분함(`tailscaled` 는 그대로 두어 로그인 세션 유지). 기존 `bin/restart` (`setsid supervisorctl restart code-server &`) 와 동일한 패턴으로 새 명령을 추가:

```sh
# bin/forward-reload
#!/bin/sh
setsid supervisorctl restart tailscale-forward &
```

`bin/` 은 Dockerfile 에서 이미 `/usr/local/bin/` 에 통째로 복사되므로(`COPY --chown=root:root bin /usr/local/bin/`) 파일만 추가하면 별도 빌드 설정 변경 없이 PATH 에 잡힘.

## 로그인 방식

- **Auth key** (`TS_AUTHKEY`): 헤드리스/자동화에 적합하지만 시크릿 관리가 필요함 (tag 지정 + ACL 제한 권장, `.env` 로 분리, git 커밋 금지).
- **인터랙티브 로그인** (`tailscale up` 실행 시 뜨는 브라우저 인증 URL을 최초 1회만 수동으로 열어줌): 이 프로젝트가 "개인적인 목적"인 점을 감안하면 이 편이 더 적합해보임 — 관리할 시크릿이 없고, 상태가 `/code` 에 영속되므로 컨테이너 재생성 후에도 재로그인 불필요. 최초 설치 시 한 번만 로그를 확인해서 인증하면 됨.

## 구현 시 변경사항 초안 (미구현)

- `config/build.default.sh`: `tailscale`, `socat`, `yq` 패키지 추가 (`docker-buildx` 를 추가했을 때와 동일하게, 기존 `pacman -Suy ...` 한 줄에 이어붙이면 됨)
- `script/tailscale-service.sh` + `config/tailscale-service.default.sh` (`sshd-service.*.sh` 패턴):
  - `tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --state=/code/.tailscale/state/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock` 백그라운드 실행
  - 소켓 준비 대기 후, 로그인이 안 되어있으면 `tailscale up` 실행 (interactive 시 로그에 인증 URL 출력됨)
- `script/tailscale-forward.sh` + `config/tailscale-forward.default.sh`: `/code/.tailscale/config.yaml` 을 `yq` 로 읽어 `socat`(발신) + `tailscale serve`(수신 게시) 를 설정하고, `trap` 으로 정리함 (위 의사코드 참고). `tailscaled` 로그인 완료를 기다렸다가 시작해야 함 (`tailscale status --json` 폴링). `$FORWARDS_IP` 를 `forwards:` 바인드에, `$INTERNAL_IP` 를 `publish:` 바인드에 씀 (아래).
- `bin/forward-reload`: `tailscale-forward` program 만 재시작하는 명령 (위 참고). `bin/` 은 통째로 `/usr/local/bin/` 에 복사되므로 Dockerfile 변경 불필요.
- `config/supervisord.default.conf`: `[program:tailscaled]`, `[program:tailscale-forward]` 두 개를 **별도로** 추가 (하나로 합치지 말 것 - 위 "별도 supervisord program 으로 분리" 참고)
- `docker-compose.yml`: **필수 변경** — 최상위 `networks:` 에 `code-docker-forwards` 신규 추가, `code-docker` 서비스에 `code-docker-internal`/`code-docker-forwards` 각각 전용 alias 추가:
  ```yaml
  networks:
    code-docker-forwards:
      name: "${PREFIX:-}code-docker-forwards"
      internal: true

  services:
    code-docker:
      networks:
        code-docker-internal:
          aliases:
            - code-docker-internal-self
        code-docker-external: {}
        code-docker-forwards:
          aliases:
            - forwards
  ```
  `tailscale-service.*.sh` 가 `getent hosts code-docker-internal-self`/`getent hosts forwards` 로 각각 `$INTERNAL_IP`/`$FORWARDS_IP` 를 export.

## 남은 작업 (구현 순서 제안)

1. `config/build.default.sh` 에 패키지 3종 추가하고 빌드 확인
2. `docker-compose.yml` 에 `code-docker-forwards` 네트워크 + `code-docker-internal-self`/`forwards` alias 추가
3. `tailscale-service.*.sh` 작성 → 로그인 흐름(인터랙티브) 확인, `$INTERNAL_IP`/`$FORWARDS_IP` export 확인
4. `config.yaml` 포맷 확정 + `tailscale-forward.*.sh` (trap 포함) 작성 → `$FORWARDS_IP` 바인드로 adb 케이스 실제 동작 검증 (`ANDROID_ADB_SERVER_ADDRESS=forwards` 로 접근), `supervisorctl stop tailscale-forward` 로 graceful 종료도 확인
5. **누출 시나리오 검증**: 휴대폰 등 다른 tailnet 기기를 code-docker 에만 ACL 접근 권한을 준 상태로, `forwards:` 로 가져온 laptop 의 서비스(adb 등)에 접근이 안 되는지(연결 거부) 확인 — 이게 이번에 발견한 문제의 핵심 회귀 테스트
6. `supervisord.default.conf` 에 `tailscaled`, `tailscale-forward` 두 program 등록
7. `bin/forward-reload` 추가
8. 개발 서버(node dev server 등)를 `$INTERNAL_IP` 에 bind 해서 띄우고, `publish:` 에 추가하기 전엔 노트북에서 안 보이다가 추가한 후에만 tailscale hostname:port 로 붙는지 검증
9. **`README.md` 에 "tailscale" 절 추가** — 기존 ssh/adb/discord/dind 절과 같은 톤으로: 왜 필요한지, `config.yaml` 편집 방법과 `forward-reload`, 최초 로그인 방법(인증 URL 확인), **"private 하게 유지하고 싶은 서비스는 `$INTERNAL_IP` 에, `forwards:` 로 가져온 것은 `forwards` hostname 으로 접근하라"는 안내(혼선 방지용, 명시적으로 요청받음)**, 보안 주의사항(아래 항목 요약해서 옮기기). 다른 절들처럼 `## 기타 환경에 대한 노트와 팁 모음` 아래 배치.
10. **README 에 tailnet ACL grant 설정을 필수 단계로 명시** — 아래 "노출 범위를 실제로 제한하는 방법"의 grants 예시를 그대로 옮기고, sshd/code-server 는 방법 2 로 못 가리므로 이거 없이는 항상 열려있다는 점을 경고로 강조.
11. 이 파일(`tailscale.md`)은 README 반영 후 삭제하거나 "구현 완료" 로 표시

## 보안 주의사항

- NET_ADMIN/tun 을 안 쓰므로 이전 버전보다 권한 요구가 훨씬 적음. subnet router나 exit node 로는 동작할 수 없음 (이 프로젝트 용도에는 불필요).
- 그래도 **수신 포워딩이 기본 동작**이라는 점은 그대로 주의해야 함: code-docker 가 tailnet 에 들어가는 순간, `code-config.default.yaml` 의 `auth: none` 설정 때문에 tailnet 안의 누구든 인증 없이 code-server(80번 포트)에 접근 가능해짐.
- SOCKS5 프록시는 `localhost` 에만 바인드되므로 컨테이너 밖에서는 접근 불가능함 (기본적으로 안전).
- `/code/.tailscale/config.yaml` 는 code-docker 에 접근 가능한 사람이면 누구나 편집 가능 — 이 프로젝트의 기존 신뢰 모델(루트, 인증받은 운영자)과 동일한 수준.
- `forwards:` 로 가져온 것도 (수신 포워딩과 동일한 이유로) loopback 에 두면 tailnet 전체에 재노출됨 — ACL 로 code-docker 만 허용해도 그걸 거쳐 원격 피어의 서비스까지 새어나감. 아래 "방법 2" 로 반드시 막아야 함 (필수, 선택 아님).

### 노출 범위를 실제로 제한하는 방법

"게시된 포트만 열리게, 나머지는 막고 싶다"는 요구를 조사함. `allow_unknown_ports: false` 같이 tailscaled 에 강제시킬 수단이 없는 로컬 설정 키는 추가하지 않기로 했지만 (아래 "시도했지만 안 되는 방법" 참고), **바인드 주소를 이용하는 방법은 실제로 로컬에서 됨** (아래 "방법 2"). 정리하면 두 층으로 방어함:

#### 시도했지만 안 되는 방법

- userspace 모드에서는 인바운드 트래픽이 tailscaled 프로세스 안의 가상 netstack 에서 전부 종단됨 (컨테이너의 실제 커널 네트워크 스택을 아예 거치지 않음). 그래서 컨테이너 안에서 `iptables`/`nftables` 로 포트별 차단을 걸어도 애초에 그 트래픽이 커널까지 내려오질 않아 아무 효과가 없음. (커널 tun 모드로 바꾸면 가능하지만, 그건 우리가 피하려는 `NET_ADMIN` 을 다시 요구함.)
- tailscaled 자체에도 이런 로컬 스위치가 없음. 가장 가까운 게 `tailscale up --shields-up` 인데, 이건 all-or-nothing 옵션 — 인바운드를 전부 막아버려서 `tailscale serve`/`funnel` 자체가 같이 깨짐 ([tailscale/tailscale#11049](https://github.com/tailscale/tailscale/issues/11049)). "shields-up 이면서 특정 포트만 예외로 허용"은 아직 없는 기능임 ([FR: Allow exceptions for shields-up #4881](https://github.com/tailscale/tailscale/issues/4881), 아직 미구현). 그래서 이런 종류의(강제력 없는) 설정 키는 추가하지 않음 — "막혔다고 착각하게 만드는" 역효과만 있음.

#### 방법 1: tailnet ACL (grants) — control-plane, 모든 포트에 적용 가능한 backstop

control-plane(관리 콘솔/정책 파일) 에서 처리되는, 기본적으로 default-deny 인 진짜 화이트리스트:
```json
{
  "tagOwners": { "tag:code-docker": ["autogroup:admin"] },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:code-docker"], "ip": ["tcp:22", "tcp:80"] }
  ]
}
```
code-docker 노드는 22, 80 포트 외엔 로컬에 뭐가 떠있든 tailnet 상의 다른 기기에서 아예 도달이 안 됨. sshd/code-server 처럼 항상 떠있는 서비스에 대한 backstop 으로 반드시 필요함 (아래 "방법 2" 로는 이 둘을 못 가림 — 이유는 바로 아래).

#### 방법 2: loopback 을 피해서 bind — 됨. `forwards:` 재노출 누출도 이걸로 막아야 함 (필수로 격상)

**별다른 메커니즘이 있는 게 아님.** `netstack.go` 의 fallback 은 `dialIP` 를 도커 네트워크와 무관하게 **무조건** `127.0.0.1` 로 재작성해서 그 주소로만 forward 함 (위 코드 참고) — 즉 노출 여부는 오직 "`127.0.0.1`/`0.0.0.0` 에 뭔가 리슨 중인가" 그 자체가 전부이고, 그 이상의 검사나 필터링은 없음.

**처음엔 `publish:`(dev 서버 등 명시적으로 열고 싶은 것) 용도로만 생각했는데, `forwards:`(socat 로 원격 포트를 가져오는 것) 도 똑같은 문제를 가짐을 확인함**: `socat TCP-LISTEN` 이 결국 loopback 에 리슨하는 이상, 그것도 fallback 에 의해 그대로 재노출됨. 즉 ACL 로 code-docker 접근 권한만 준 다른 tailnet 기기(예: 휴대폰)가, code-docker 를 거쳐 `forwards:` 로 가져온 laptop 의 adb 서비스까지 투명하게 써버릴 수 있음 — laptop 소유자가 그런 권한을 준 적이 없는데도. 그래서 이 방법은 "선택적 편의"가 아니라 **`forwards:`/`publish:` 를 쓰는 이상 필수**로 격상함.

- 원칙: **`forwards:` 의 socat 리스너, `publish:` 의 `tailscale serve` 로컬 타겟 모두 loopback 이 아닌 주소에 둔다.** 이 성질만 만족하면 fallback 에 안 걸림.
- `publish:` 는 기존 `code-docker-internal` 재사용 그대로 유지 (`code-docker-internal-self` alias, `$INTERNAL_IP`) — dind 소켓도 이미 거기 있어서 "code-docker 내부용" 의미가 확립돼있는 네트워크에 자연스럽게 묶임.
- **`forwards:` 는 별도 전용 네트워크(`code-docker-forwards`)로 분리함** — 처음엔 `publish:` 와 같은 `$INTERNAL_IP` 를 재사용하려 했으나, 그러면 "가져온 원격 포트들"과 "게시하려는 로컬 서비스들"이 같은 IP 하나의 포트 네임스페이스를 공유하게 되어 우연히 포트 번호가 겹치면(예: 둘 다 8888 을 쓰고 싶은 경우) 문제가 됨. 완전히 분리된 네트워크를 쓰면 `forwards:$FORWARDS_IP:8888` 과 `publish:$INTERNAL_IP:8888` 이 전혀 다른 주소라 겹칠 일이 없음:
  ```yaml
  networks:
    code-docker-forwards:
      name: "${PREFIX:-}code-docker-forwards"
      internal: true

  services:
    code-docker:
      networks:
        code-docker-internal:
          aliases:
            - code-docker-internal-self
        code-docker-external: {}
        code-docker-forwards:
          aliases:
            - forwards   # 짧고 기억하기 쉬운 이름 - http://forwards:8888 처럼 바로 씀
  ```
  IP 를 하드코딩하지 않고 알아내는 방법은 동일한 alias 트릭: `getent hosts forwards` 로 code-docker 자신의 이 네트워크 IP 를 조회, `tailscale-service.*.sh` 에서 `$FORWARDS_IP` 로 export.
  - **`forwards` 라는 alias 자체가 hostname 으로 바로 쓸 수 있다는 것도 장점**: `$FORWARDS_IP` 환경변수를 안 거쳐도, 컨테이너 안 어디서나(브라우저, curl, 툴 설정 파일 등) 그냥 `forwards` 라는 이름으로 바로 접근 가능함 (Docker 내장 DNS 가 alias 를 그대로 resolve 해줌 - env var 로 IP 를 읽어서 대입하는 것보다 사람이 직접 타이핑하기에도 편함). 예: 브라우저 개발자도구에서 `http://forwards:8888` 그대로 입력.
- (참고) socat 의 정확한 바인드 문법은 주소를 포트 앞에 붙이는 게 아니라 `bind=` 옵션: `TCP-LISTEN:<port>,bind=<주소>,fork,reuseaddr`. `bind=` 는 IP 뿐 아니라 hostname 도 받으므로 `bind=$FORWARDS_IP` 대신 `bind=forwards` 를 직접 써도 되지만, 다른 곳(`code-docker-internal-self`)과의 일관성을 위해 여기서도 `getent hosts` 로 미리 resolve 해서 IP 로 넘기는 쪽을 채택함.
- `tailscale-forward.*.sh` 최종 정리:
  - `forwards:` → `socat TCP-LISTEN:"$local_port",bind="$FORWARDS_IP",fork,reuseaddr SOCKS5:...`
  - `publish:` → `tailscale serve --bg --tcp="$tport" "tcp://$INTERNAL_IP:$lport"` (게시하려는 서비스는 `$INTERNAL_IP` 에 bind 되어있어야 이 규칙이 실제로 그 서비스를 찾음)
- adb 처럼 컨테이너 안의 다른 프로세스가 `localhost:5037` 을 기대하는 경우엔(예: `adb` CLI 기본값), README 에 이미 있는 `ANDROID_ADB_SERVER_ADDRESS`/`ANDROID_ADB_SERVER_PORT` 환경변수 패턴을 그대로 재사용 - `ANDROID_ADB_SERVER_ADDRESS=forwards` (env var 대신 alias 이름을 직접 써도 됨, 위 참고) 로 지정하면 loopback 을 거치지 않고도 기존처럼 씀.
- 노출하고 싶은 서비스만 `publish:` 에 추가 → 로컬에서 강제되는 opt-in 화이트리스트. 반대로 `0.0.0.0` 에 그냥 바인드하면 기존처럼 예상대로 자동 노출됨 — 두 습관이 공존 가능함 (사용자 표현 그대로: "private 으로 남길 것을 loopback 에서 떼어내는" 방식).

**sshd(22), code-server(80) 는 예외로 둠 — 이 방법으로 못 가림**: 이 둘은 `docker-compose.yml` 의 `ports: - 80:80` 호스트 포트 퍼블리시가 동작하려면 원래 `0.0.0.0` 에 바인드되어야 하므로, 항상 fallback 으로 자동 노출됨. 그래서 이 둘엔 여전히 방법 1(ACL grant) 이 유일한 방어선임.

#### 결론

- **README/설치 안내에 방법 1(ACL grant)을 필수 항목으로 넣어야 함** (sshd/code-server 는 이것 없인 항상 열려있음, 남은 작업에 반영).
- **방법 2 도 이제 필수** — `code-docker-internal`(`code-docker-internal-self` alias, `$INTERNAL_IP`, `publish:` 용)와 신규 `code-docker-forwards`(`forwards` alias, `$FORWARDS_IP`, `forwards:` 용) 두 네트워크로 분리. `forwards:`/`publish:` 를 쓰는 이상 이게 없으면 `forwards:` 로 가져온 항목들이 통째로 tailnet 에 재노출됨. `docker-compose.yml` 변경도 이제 선택이 아니라 기본 계획에 포함.
- **README 에 "private 하게 유지하고 싶은 서비스는 `$INTERNAL_IP` 에 bind 하라, `forwards:` 로 가져온 건 `forwards` hostname 으로 접근하라"는 안내를 명시적으로 넣을 것** (유저가 직접 실행하는 dev 서버 등에 혼선 없도록).

## 참고 자료

- [Contain your excitement: A deep dive into using Tailscale with Docker](https://tailscale.com/blog/docker-tailscale-guide)
- [tailscale/tailscale - Docker Image (Docker Hub)](https://hub.docker.com/r/tailscale/tailscale)
- [Userspace networking mode (for containers) · Tailscale Docs](https://tailscale.com/docs/concepts/userspace-networking)
- [Docker configuration parameters · Tailscale Docs](https://tailscale.com/docs/features/containers/docker/docker-params)
- [socat(1) manual page](https://man.freebsd.org/cgi/man.cgi?query=socat&sektion=1) — `retry`/`forever`/`intervall` 옵션 정의
- [Arch Linux - docker-buildx package](https://archlinux.org/packages/extra/x86_64/docker-buildx/) — Arch 에서 `docker` 가 optional dependency 로만 걸리는 CLI 플러그인 패키지 패턴 (`docker-compose`, `docker-buildx`, `yq` 모두 동일)
- [tailscale/tailscale#13931 - netstack: could not connect to local backend server](https://github.com/tailscale/tailscale/issues/13931) — 인바운드-localhost 포워딩이 tailscaled 코어(netstack) 자체 동작이라는 근거
- [tailscale/tailscale#2642 - userspace-networking incoming TCP doesn't always work right away](https://github.com/tailscale/tailscale/issues/2642) — 시작 직후 인바운드 포워딩 지연 캐비앗
- [tailscale/tailscale#14467 - MagicDNS in containers needs 100.100.100.100 in resolv.conf](https://github.com/tailscale/tailscale/issues/14467) — 발신 SOCKS5 쪽에서 MagicDNS 이름을 쓰려면 필요한 설정
- [tailscale serve command · Tailscale Docs](https://tailscale.com/docs/reference/tailscale-cli/serve) — `--tcp`/`--tls-terminated-tcp`/`-bg`/`status`/`reset` 등 정확한 CLI 문법
- [wgengine/netstack/netstack.go (acceptTCP) · tailscale/tailscale](https://github.com/tailscale/tailscale/blob/main/wgengine/netstack/netstack.go) — `tailscale serve` 규칙이 없는 포트가 왜 여전히 자동 포워딩되는지의 실제 근거 소스
- [Grant examples · Tailscale Docs](https://tailscale.com/docs/reference/examples/grants) — 포트 단위 default-deny 화이트리스트(`ip: ["tcp:22", "tcp:80"]`) 설정 예시
- [tailscale/tailscale#11049 - funnel fails when shields-up is enabled](https://github.com/tailscale/tailscale/issues/11049), [tailscale/tailscale#4881 - FR: Allow exceptions for shields-up](https://github.com/tailscale/tailscale/issues/4881) — `shields-up` 이 all-or-nothing 이라 로컬 설정으로는 선택적 차단이 안 된다는 근거
