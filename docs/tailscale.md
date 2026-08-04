# tailscale 연결

`docker-compose.yml` 의 `TAILSCALE_ENABLED` 를 `"false"` 로 설정하면 tailscale 관련 기능이 전부 꺼집니다 (`tailscaled`/`tailscale-forward` 두 프로그램은 그대로 떠있지만 아무 것도 하지 않습니다). 기본값은 `"true"` 입니다.

code-docker 가 고유한 tailscale IP를 가지도록 하여, ssh/adb 를 위해 별도로 포트를 열거나 `ssh -R` 로 소켓을 전송하지 않고도 tailnet 안 어디서든 code-docker 에 접근하거나, 반대로 code-docker 에서 다른 tailnet 기기(예: 랩탑의 adb 서버)의 포트를 가져올 수 있습니다. `NET_ADMIN`/커널 tun 디바이스 없이 tailscaled 의 userspace networking 모드만으로 동작합니다.

## 켜고 끄기

`docker-compose.yml` 의 `TAILSCALE_ENABLED` 를 `"false"` 로 설정하면 됩니다 (위 참고). 다시 켜려면 `"true"` 로 되돌리고 `docker compose up -d` 하세요.

## 최초 로그인과 상태 배너

**자동 로그인 시도는 컨테이너 생애주기 동안 딱 한 번만 일어납니다** (`state/.login-attempted` 마커로 추적). 로그인을 완료하지 않은 채 컨테이너를 껐다 켰다 하면 매 재부팅마다 새 인증 요청이 tailscale 컨트롤 서버에 등록되는 문제가 있었어서(일종의 self-DDoS), 이후 재시도는 사람이 명시적으로 트리거해야만 일어나도록 바뀌었습니다. 로그인 서버(`TAILSCALE_LOGIN_SERVER`)를 바꾸려고 `/code/.tailscale/state` 를 지우고 재시작하는 절차([아래](#자체-호스팅-로그인-서버-headscale) 참고)를 밟으면 이 마커도 같이 지워지므로 자동 시도가 다시 한 번 살아납니다 - 별도로 신경 쓸 필요 없습니다.

최초 실행 시 `docker compose logs -f code-docker` 로 로그를 확인하면 `tailscaled` 프로그램 쪽에 인증 URL이 출력됩니다. 이 URL을 브라우저로 한 번 열어 로그인하면 됩니다 (auth key 대신 인터랙티브 로그인 방식). 로그인 상태는 `/code/.tailscale/state` 에 영속되므로 컨테이너를 재생성해도 다시 로그인할 필요가 없습니다.

자동 시도를 놓쳤거나(이미 재부팅을 몇 번 했다거나) 이미 소진된 상태라면, [webmanager의 Tailscale 탭](webmanager.md#tailscale)에서 "로그인 시도하기" 버튼으로 로그인을 다시 트리거할 수 있습니다 - 컨테이너를 재시작할 필요가 없습니다.

로그를 뒤질 필요 없이, code-server 화면 자체에도 로그인이 필요할 때 우측 상단에 배너로 뜹니다 (URL이 있으면 로그인 링크를, 아직 없으면 webmanager로 가는 링크를 보여줍니다 - 현재 상태 문자열도 그대로 표시됩니다). 배너의 "Ignore"를 누르면 같은 상태에 대해서는 다시 뜨지 않습니다(브라우저 `localStorage`에 저장, 상태가 실제로 바뀌면 한 번은 다시 뜹니다). 배너에는 tailscale을 아예 쓰지 않을 거라면 [`TAILSCALE_ENABLED=false`](#켜고-끄기)로 끌 수 있다는 안내도 함께 표시됩니다. 로그인이 완료되면 별도로 "Tailscale connected" 토스트도 뜹니다. 이미 브라우저 알림 권한을 허용해둔 상태라면 OS 알림도 함께 뜹니다. `code-patch` 가 기본으로 심어주는 `/code/.server/patch/tailscale-notify.js`(폴링 + 표시할 내용 + ignore 상태) 와 `/code/.server/patch/cd-dialog.js`(배너/토스트/알림을 그리는 재사용 가능한 `window.CDDialog` 모듈) 두 파일로 구성되며, [빌드 커스터마이징 문서의 `code-patch/`](build-customization.md) 를 통해 관리됩니다 - `patch/*.js` 자체는 [코드 서버 패치](code-server-patch.md)와 동일하게 동작하는 파일이라 직접 편집/교체 가능합니다.

## 자체 호스팅 로그인 서버 (Headscale)

기본적으로 공식 tailscale.com 컨트롤 서버에 로그인합니다. Headscale 등 자체 호스팅 서버를 쓰고싶다면 `docker-compose.yml` 의 `TAILSCALE_LOGIN_SERVER` 환경변수를 원하는 URL로 설정하세요 (`tailscale up --login-server=` 로 전달됩니다). 이미 로그인된 상태에서 이 값을 바꾼 경우, `/code/.tailscale/state` 를 지우고 컨테이너를 재시작해야 새 서버로 다시 로그인합니다.

## 설정 파일

수신/발신 설정은 `/code/.tailscale/config.yaml` 을 편집합니다 (최초 실행 시 기본값이 자동 생성됩니다).

```yaml
forwards:
  - name: adb                    # 로그/디버깅용 이름표
    local_port: 5037
    remote_host: laptop          # tailscale hostname 또는 IP
    remote_port: 5037

publish:
  - name: dev-server
    tailscale_port: 80
    local_port: 3000
    mode: tcp                    # tcp | tls-terminated-tcp
```

## 포트 가져오기 (forwards)

다른 tailnet 기기의 포트를 code-docker 로 가져옵니다. 컨테이너 안에서는 `forward` 라는 hostname 으로 접근하세요 (예: [adb 연결](tips/adb.md)은 `ANDROID_ADB_SERVER_ADDRESS=forward` 로 설정하는 방식 - 기존 `ssh -R` 방식의 대안입니다). 편집 후에는 `forward-reload` 명령으로 반영합니다 (`tailscale-forward` 서비스만 재시작하며, 로그인 세션은 그대로 유지됩니다).

## 포트 내보내기 (publish)

code-docker 의 로컬 포트를 tailscale IP에 명시적으로 게시합니다 (포트 리매핑, 또는 `mode: tls-terminated-tcp` 로 무료 HTTPS 종단). 게시하려는 서비스는 `0.0.0.0`/`localhost` 가 아니라 `private` hostname(자기 자신의 tailscale용 전용 IP)에 bind 되어 있어야 합니다. 편집 후에는 `forwards` 와 마찬가지로 `forward-reload` 로 반영합니다.

## 보안: tailnet ACL 설정

> **주의: sshd(22), code-server(80), webmanager(81)는 `config.yaml`에 없어도 항상 tailnet 에 자동 노출됩니다.** tailscaled 는 `tailscale serve` 규칙이 없는 포트도 같은 번호로 `127.0.0.1`/`0.0.0.0` 에 떠있는 서비스에 자동으로 연결해주기 때문입니다 — 이 세 서비스는 전부 `0.0.0.0` 에 바인드되어 있어서(sshd/code-server는 호스트 포트 퍼블리시 때문에, webmanager는 바인드 주소 전략이 아직 미정이라) 이 자동 노출을 피할 방법이 없습니다. `code-config.default.yaml` 은 `auth: none` 이고 webmanager는 아예 자체 로그인이 없으므로(SSH 키/git credential 을 다루는 만큼 code-server 보다 더 민감), code-docker 가 tailnet 에 들어가는 순간 인증 없이 두 서비스에 접근 가능한 사람이 tailnet 전체로 넓어집니다.
>
> **그래서 tailnet 관리 콘솔(ACL)에서 code-docker 태그로 접근 가능한 포트를 반드시 제한하세요.** 예:
> ```json
> {
>   "tagOwners": { "tag:code-docker": ["autogroup:admin"] },
>   "grants": [
>     { "src": ["autogroup:member"], "dst": ["tag:code-docker"], "ip": ["tcp:22", "tcp:80", "tcp:81"] }
>   ]
> }
> ```
> 이게 없으면 sshd/code-server/webmanager 는 항상 tailnet 전체에 열려있는 상태입니다.
>
> 반대로 `forwards`/`publish` 는 이런 자동 노출에 걸리지 않도록 이미 전용 네트워크의 자기 자신 IP에만 바인드되어 있어서 안전합니다 — private 하게 유지하고 싶은, 직접 띄운 서비스(dev 서버 등)는 `0.0.0.0`/`localhost` 대신 `private` 에 bind 하고 필요할 때만 `publish:` 에 추가하세요. `forwards:` 로 가져온 것들은 `forward` hostname 으로만 접근 가능하니 혼동하지 마세요.
