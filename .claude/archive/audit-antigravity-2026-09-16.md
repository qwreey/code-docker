# 외부자 관점 보안 및 아키텍처 감사 보고서 (Security & Architecture Audit Report)

- **감사 일자**: 2026-09-16
- **대상 프로젝트**: `code-docker` (및 하위 서브모듈 `router`, `code-dind`, `webmanager`)
- **감사 관점**: 외부 네트워크/공격자 관점 (External Attacker & Perimeter Perspective) 및 클린 아키텍처 관점
- **감사 원칙**: 
  1. 기존 검사 내역을 배제한 클린 맥락(Clean Context) 기반 자체 분석 수행
  2. 실제 코드 및 동작 메커니즘에 기반한 팩트 위주 분석 (허위 사실/과장 배제)
  3. 유저 설정 누락 및 기본 설정에서 기인하는 보안 이슈는 요청 기준에 따라 **Low** 등급으로 분류

---

## 1. 개요 및 위협 모델 (Threat Model)

본 프로젝트는 Docker 환경에서 `code-server`(VS Code), `webmanager`(관리 UI/터미널), `router`(Caddy/Nginx/Netgate 기반 라우팅 및 아웃바운드 방화벽), `code-dind`(Docker-in-Docker 및 dind-authz 플러그인), `netinit-docker`(호스트 네트워킹 제어 에이전트)를 결합하여 개발 환경을 제공합니다.

외부자(External Outsider / Network Attacker) 시선에서의 주요 위협 경로는 다음과 같습니다:
1. **Perimeter (Host Port 80)**: 기본 compose 구성상 호스트의 `0.0.0.0:80`에 바인딩되어 있으며, 외부 프록시/인증(Forward-Auth) 계층을 우회하거나 직접 노출될 경우의 리스크.
2. **Same-Origin Shared Namespace**: 동일 도메인/포트 아래에 `code-server`(/), `webmanager`(/manager/), `router-manager`(/router/), `App Routes`(/app/<name>/)가 공존함에 따른 세션/쿠키 탈취 및 브라우저 컨텍스트 침해 리스크.
3. **Container Isolation & Privilege Escalation (dind-authz / DinD)**: `code-docker` 내부의 임의 코드/에이전트/외부 프로세스가 `code-dind`(privileged: true)를 통해 호스트 권한 또는 데몬 권한을 획득할 수 있는지 여부.
4. **Egress Firewall Bypass (Netgate)**: 외부 인터넷 및 사설망(RFC1918) 차단 규칙의 경합 조건(Race Condition) 및 패킷 누수 가능성.
5. **Supply Chain & Build Integrity**: 빌드 타임 외부 원격 의존성(`#main` 브랜치 참조) 및 호스트 소켓 노출 리스크.

---

## 2. 보안 취약점 및 문제점 요약

| ID | 구분 | 취약점 / 문제점 | 심각도 (Severity) | 영향도 |
|---|---|---|---|---|
| **SEC-01** | 코드 결함 | `code-dind`: `dind-authz`의 심볼릭 링크(Symlink) 미검증으로 인한 볼륨 격리 우회 및 DinD 루트 탈취 | **Critical** | dind-authz 무력화, 호스트 블록 디바이스/소켓 접근 가능 |
| **SEC-02** | 코드 결함 | `router`: `firewall.default.sh`의 주기적 규칙 플러시(`iptables -F`)로 인한 아웃바운드 패킷 누수(Race Condition) | **High** | 30초마다 차단 대상 사설망/호스트로의 트래픽 누출 가능 |
| **SEC-03** | 설계 결함 | `router`: 최초 구동 시 외부 네트워크에서의 `router-manager` 관리자 계정 선점(Setup Claiming) | **High** | 외부 공격자가 router 관리자 권한 선점 및 방화벽/DNS 변조 |
| **SEC-04** | 코드 결함 | `router`: `targetguard.Validate`의 루프백(127.0.0.0/8) 및 다형성 IP 주소 검증 누락으로 인한 SSRF | **Medium** | router 컨테이너 내부 서비스(tinyauth 등) 대상 내부 SSRF 가능 |
| **SEC-05** | 빌드/공급망 | `Dockerfile` & `docker-compose.yml`: 고정되지 않은 GitHub `#main` 브랜치 원격 빌드 및 호스트 docker.sock 마운트 | **Medium** | 공급망 오염 시 호스트 루트 권한 즉시 탈취 위험 |
| **SEC-06** | 아키텍처 | 동일 Origin 내 관리자 쿠키(`*_unlock`)와 비신뢰 App Route(/app/) 공존에 따른 클라이언트 사이드 세션 하이재킹 | **Medium** | 악성/취약 App을 통한 브라우저 Same-Origin API 악용 |
| **SEC-07** | 프로토콜 | `webmanager` & `router`: 기본 `ALLOWED_HOSTS` 부재 시 DNS Rebinding을 통한 터미널/VNC 웹소켓 탈취 | **Medium** | 외부 사이트 방문만으로 피해자 로컬 컨테이너 터미널 장악 가능 |
| **SEC-08** | 유저 설정 | 외부 Forward-Auth 부재 및 기본 비밀번호 미설정 배포 시 unauthenticated root RCE 노출 | **Low** *(규정 기준)* | 인증 없는 웹 환경 노출 시 즉시 루트 쉘 장악 가능 |
| **SEC-09** | 유저 설정 | 리소스 제한(CPU / Memory Limits) 기본값 0(무제한)으로 인한 호스트 서비스 거부(DoS) | **Low** *(규정 기준)* | 컨테이너 내 프로세스 폭주 시 호스트 OOM 유발 |
| **SEC-10** | 코드 결함 | `code-dind`: `dind-authz`에서 `UsernsMode` 및 `docker exec` 권한 상승 검증 누락 | **Low** | userns-remap 모드 무력화 가능성 |

---

## 3. 세부 분석 및 조치 방안

---

### [SEC-01] [Critical] `code-dind`: `dind-authz`의 심볼릭 링크 미해결로 인한 볼륨 격리 우회 및 DinD 루트 탈취

- **위치**: `code-dind/dind-authz/policy.go` (`bindSourceAllowed` 함수, 319-331행)
- **설명**:
  `dind-authz` 플러그인은 컨테이너 생성 요청(`POST /containers/create`) 시 마운트 소스가 허용된 디렉토리 접두사(`bind_allow_prefixes`, 기본값 `["/code/"]`) 내에 속하는지 검사합니다.
  ```go
  func bindSourceAllowed(src string, allowRoots []string) bool {
      if !strings.HasPrefix(src, "/") {
          return true
      }
      cleanSrc := path.Clean(src)
      for _, root := range allowRoots {
          cleanRoot := path.Clean(root)
          if cleanSrc == cleanRoot || strings.HasPrefix(cleanSrc, cleanRoot+"/") {
              return true
          }
      }
      return false
  }
  ```
  그러나 `path.Clean`은 단순한 문자열/경로 정규화만 수행할 뿐, **실제 파일시스템의 심볼릭 링크를 해석하지 않습니다 (`filepath.EvalSymlinks` 미수행)**.
  
  `code-docker`와 `code-docker-dind`는 호스트의 `HOME_VOLUME`을 공유하여 `/code`에 마운트하고 있습니다. 따라서 `code-docker` 내부의 사용자, AI 에이전트, 또는 npm postinstall 등의 스크립트가 `/code` 내에 다음과 같은 심볼릭 링크를 생성할 수 있습니다:
  ```bash
  ln -s / /code/dind_rootfs
  ```
  이후 `DOCKER_HOST=tcp://dind:2375`로 컨테이너 생성 요청을 보냅니다:
  ```bash
  docker run -v /code/dind_rootfs:/target_root alpine ...
  ```
  `dind-authz`는 `cleanSrc`가 `/code/dind_rootfs`이므로 `/code/` 접두사 검사를 통과시킵니다. 하지만 `dockerd`와 runc가 마운트를 수행할 때 커널은 심볼릭 링크를 따라가 `code-docker-dind` 컨테이너의 루트 파일시스템(`/`) 전체를 새 컨테이너의 `/target_root`에 읽기/쓰기 권한으로 마운트합니다.

- **파급 효과**:
  1. **정책 파일 위조**: `code-docker`에 절대 마운트되지 않도록 설계된 `/etc/dind-authz.d` 볼륨에 접근하여 새 json 정책을 작성(`allowed_caps: ALL` 등), 플러그인을 완전히 무력화할 수 있습니다.
  2. **원시 도커 소켓 접근**: `code-docker-dind` 내부의 `/var/run/docker.sock`에 직접 접근하여 플러그인을 우회할 수 있습니다.
  3. **호스트 탈출(Host Escape)**: `code-docker-dind`는 `privileged: true`로 실행 중이므로, `/target_root/dev`에 호스트의 원시 디바이스 노드(디스크 파티션, loop 디바이스 등)가 존재합니다. 이를 통해 물리적 호스트 파일시스템을 직접 조작할 수 있습니다.
- **수정 방안**:
  `webmanager/backend/internal/files/path.go`에서 구현된 방식처럼, 마운트 소스 경로의 조상 및 리프 심볼릭 링크를 실제 dind 루트 파일시스템 상에서 `filepath.EvalSymlinks`를 통해 완전히 역참조한 후, 결과 절대 경로가 허용된 root(`/code`) 내부에 존재하는지 확인(`within(root, target)`)하도록 수정해야 합니다.

---

### [SEC-02] [High] `router`: `firewall.default.sh`의 주기적 플러시로 인한 아웃바운드 패킷 누출 경합 조건

- **위치**: `router/config/netgate/firewall.default.sh` (45-51행, 177-185행, 274-277행)
- **설명**:
  `netgate-firewall` 서비스는 30초마다 루프를 돌며 `apply_rules`를 실행합니다:
  ```bash
  ensure_chain() {
      iptables -t "$1" -N "$2" 2>/dev/null || iptables -t "$1" -F "$2"
  }
  ...
  while true; do
      apply_rules || echo >&2 "..."
      sleep 30
  done
  ```
  `apply_rules`가 시작되면 `ensure_chain filter NETGATE-FORWARD`가 실행되어 기존의 `NETGATE-FORWARD` 체인에 걸려있던 모든 `DROP` 규칙이 즉시 플러시(`-F`)됩니다.
  그 후 `yq`를 통해 `config.yaml`을 한 줄씩 쉘 루프로 순회하며 새 규칙을 차례대로 다시 `iptables -A`로 삽입합니다. 이 파싱 및 삽입 과정은 수백 밀리초 이상 소요됩니다.
  
  Docker의 기본 `FORWARD` 체인 정책은 `ACCEPT`이므로, `NETGATE-FORWARD`가 비어 있는 이 수백 밀리초 동안에는 `code-docker` 및 `code-dind`에서 외부로 나가는 모든 FORWARD 트래픽이 아무런 검사 없이 통과합니다.

- **파급 효과**:
  - `code-docker` 내부의 비인가 프로세스나 공격자가 30초마다 발생하는 플러시 타이밍에 맞춰 지속적으로 SYN 패킷을 전송하면, 차단되어야 마땅한 RFC1918 사설망 IP(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) 및 내부 호스트 네트워크로 연결을 수립(ESTABLISHED)할 수 있습니다.
  - 연결이 한 번 수립되면 상단의 `ESTABLISHED,RELATED -j ACCEPT` 규칙에 의해 이후 트래픽도 지속적으로 유지됩니다.
- **수정 방안**:
  실시간 트래픽을 처리하는 체인을 플러시하지 말고, 임시 체인(예: `NETGATE-FORWARD-NEW`)을 생성하여 모든 규칙을 삽입한 뒤, 메인 체인에서의 점프 타깃을 원자적(Atomic)으로 교체하거나, `iptables-restore --noflush`를 활용하여 원자적으로 갱신해야 합니다.

---

### [SEC-03] [High] `router`: 외부 네트워크에서의 `router-manager` 관리자 계정 선점 취약점

- **위치**: `router/backend/handlers_auth.go` (201-223행), `router/config/nginx/nginx.default.conf` (291-314행)
- **설명**:
  `router-manager`는 비밀번호가 설정되지 않은 초기 상태(`gate.Source() == "unset"`)에서 `POST /api/auth/setup` 엔드포인트를 인증 없이 개방합니다.
  ```go
  func handleAuthSetup(w http.ResponseWriter, r *http.Request) {
      ...
      if err := gate.SetupPassword(body.Password); err != nil {
          if errors.Is(err, authgate.ErrAlreadyConfigured) {
              writeError(w, http.StatusConflict, "password already configured...")
              return
          }
      ...
  ```
  `router`의 nginx 설정(`nginx.default.conf`)을 보면:
  ```nginx
  location /router/ {
      ${NGINX_DENY_INTERNAL_MANAGER_DIRECTIVE}
      proxy_pass http://unix:/run/router-manager.sock:/;
  ```
  내부 네트워크(`code-docker-internal`)로부터의 접근은 차단하지만, 호스트 외부 인터페이스(`code-docker-external` / 포트 80)를 통해 인입되는 요청은 **전혀 차단되지 않습니다**.
  
  관리자가 배포 시점에 `.env.router`에 `ROUTER_MANAGER_AUTH_PASSWORD_HASH`를 미리 지정하지 않았거나, `ootb.sh` 과정에서 비밀번호 설정을 건너뛰고 컨테이너를 올린 경우, 인터넷이나 LAN 상의 외부 공격자가 `http://<host>/router/api/auth/setup`에 먼저 접근하여 자신의 비밀번호를 등록할 수 있습니다.

- **파급 효과**:
  - 외부 공격자가 `router-manager`의 관리자 권한을 획득하게 됩니다.
  - 공격자는 Netgate 방화벽의 아웃바운드 차단 목록을 삭제하여 내부망 전체 접근을 허용하거나, 인바운드 포트 포워딩을 추가하여 컨테이너 내부 포트를 외부에 임의 개방하거나, DNS 리졸버 및 블록리스트를 변조(DNS 하이재킹)할 수 있습니다.
- **수정 방안**:
  - `POST /api/auth/setup`이 웹에서 자유롭게 호출되지 않도록, 최초 구동 시 1회용 셋업 토큰(Setup Token)을 컨테이너 로그나 로컬 파일에 생성하고 이를 입력해야만 비밀번호를 등록할 수 있게 하거나,
  - `ROUTER_MANAGER_AUTH_PASSWORD_HASH`가 환경변수로 주어지지 않은 경우 외부 네트워크로부터의 `/router/` 접근 자체를 503 등으로 원천 차단해야 합니다.

---

### [SEC-04] [Medium] `router`: `targetguard.Validate`의 루프백 서브넷 및 IP 다형성 검증 미흡으로 인한 SSRF

- **위치**: `router/backend/internal/targetguard/targetguard.go` (26-32행, 70-83행)
- **설명**:
  Dev Proxy 및 App Routes에서 Caddy 리버스 프록시 대상을 검증할 때, `SelfHosts` 맵을 통해 router 자신을 향한 루프백을 방지하고 있습니다:
  ```go
  var SelfHosts = map[string]bool{
      "localhost": true,
      "127.0.0.1": true,
      "::1":       true,
      "router":    true,
      "forward":   true,
  }
  ```
  그러나 이 검사는 단순 문자열 일치(`SelfHosts[host]`)에만 의존합니다.
  Linux 네트워크 스택에서 `127.0.0.0/8` 전체는 루프백(`lo`) 인터페이스로 라우팅됩니다.
  - `127.0.0.2`, `127.0.1.1` 등 `127.0.0.1` 이외의 루프백 IP
  - `0.0.0.0` 또는 `0`
  - IPv4-Mapped IPv6 주소 또는 10진수 정수형 IP 표기 (`2130706433` = 127.0.0.1)
  
  운영자가 `ROUTER_DEV_PROXY_ALLOW_EXTERNAL_TARGETS=true` 또는 `APPROUTES_ALLOW_EXTERNAL_TARGETS=true`를 활성화한 상태에서 공격자가 대상 주소로 `127.0.0.2:3000`을 입력하면, `SelfHosts` 검사를 그대로 우회하여 router 컨테이너 로컬에서 3000번 포트로 수신 대기 중인 `tinyauth` 데몬 또는 로컬 소켓/서비스에 Caddy가 직접 프록시하게 됩니다.

- **파급 효과**:
  - 외부로 직접 노출되지 않아야 하는 router 내부 로컬 서비스(예: `127.0.0.1:3000`의 tinyauth 관리/인증 백엔드)를 SSRF를 통해 외부로 노출시킬 수 있습니다.
- **수정 방안**:
  문자열 비교 대신 `net.ParseIP`를 통해 IP를 파싱한 후 `ip.IsLoopback()`, `ip.IsUnspecified()`, `ip.IsPrivate()`를 엄격하게 검증해야 합니다.

---

### [SEC-05] [Medium] 고정되지 않은 원격 GitHub `#main` 브랜치 의존성 및 호스트 소켓 마운트 위험

- **위치**:
  - `Dockerfile` (89, 96행):
    ```dockerfile
    ADD https://github.com/qwreey/router-docker-client.git#main:netshare /etc/code-docker/netshare
    ADD https://github.com/qwreey/router-docker-client.git#main:dns-local /etc/code-docker/router-client/dns-local
    ```
  - `code-dind/Dockerfile` (56행):
    ```dockerfile
    ADD https://github.com/qwreey/router-docker-client.git#main:netshare /netshare
    ```
  - `docker-compose.yml` (431행):
    ```yaml
    code-docker-netinit-docker:
      build:
        context: "${NETINIT_DOCKER_CONTEXT:-https://github.com/qwreey/router-docker-client.git#main:netinit-docker}"
      network_mode: host
      cap_add:
        - NET_ADMIN
        - SYS_ADMIN
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock:ro
        - /var/run/docker/netns:/var/run/docker/netns:ro,rslave
    ```
- **설명 및 파급 효과**:
  - `code-docker-netinit-docker`는 `network_mode: host`와 `SYS_ADMIN` 권한을 가지고 있으며, 호스트의 `/var/run/docker.sock`을 직접 마운트하고 있습니다. 주석에서도 명시하듯 `ro` 마운트는 파일 디스크립터 쓰기 행위를 막지 못하므로 이는 사실상 **호스트 루트(Root on Host)** 권한과 동일합니다.
  - 그런데 이 서비스의 빌드 컨텍스트 및 상위 Dockerfile의 주요 스크립트들이 특정 커밋 해시(Commit SHA)나 체크섬으로 고정(Pinning)되어 있지 않고, 원격 저장소의 유동적인 `#main` 브랜치를 직접 빌드 타임에 다운로드합니다.
  - 만약 해당 GitHub 계정이나 저장소가 침해당하거나, 악의적인 커밋이 머지되거나, 네트워크 레벨의 공격이 발생할 경우, 사용자가 `--no-cache` 빌드를 수행하는 즉시 호스트 장악 백도어 코드가 호스트 Docker 데몬 제어 권한으로 실행될 수 있습니다.
- **수정 방안**:
  원격 Git URL 대신 서브모듈(Git Submodule)을 사용하거나, 변경 불가능한 고정 커밋 해시(Commit SHA)를 지정하고 체크섬을 검증해야 합니다.

---

### [SEC-06] [Medium] 동일 Origin 내 관리자 쿠키(`*_unlock`)와 비신뢰 App Route(/app/) 공존에 따른 세션 하이재킹 위험

- **위치**: `router/config/nginx/nginx.default.conf` (103-156행, 218-358행)
- **설명**:
  기본 포트 80 환경에서 `code-server`(/), `webmanager`(/manager/), `router-manager`(/router/), 그리고 사용자가 등록한 임의의 웹 애플리케이션 `App Routes`(/app/<name>/)가 **모두 단일 Origin(동일 도메인 및 포트)**을 공유합니다.
  
  `nginx.default.conf`는 백엔드 프록시로 전달되는 HTTP `Cookie` 헤더에서 `router_manager_unlock`을 정규식 map으로 제거하려고 시도하지만, 설정 파일의 주석에서도 인정하고 있듯이:
  > *"This only closes the 'untrusted backend reads the raw header' vector - it does NOT stop client-side script running same-origin from issuing its own same-origin fetch('/router/api/...')"*
  
  즉, 사용자가 `/app/<name>/`에 호스팅된 제3자 웹 앱(또는 취약점이 있는 웹 앱)에 브라우저로 접속한 상태라면, 해당 웹 앱의 클라이언트 사이드 JavaScript는 브라우저의 Same-Origin Policy에 따라 동일 Origin으로 인식됩니다. 따라서 악성 스크립트가 `fetch('/router/api/...')` 또는 `fetch('/manager/api/...')`를 호출하면 브라우저는 `HttpOnly` / `SameSite=Strict` 쿠키를 자동으로 요청에 첨부하여 전송합니다.

- **파급 효과**:
  - 사용자가 브라우저에서 `router-manager`나 `webmanager`를 잠금 해제한 후, 동일 탭/브라우저에서 App Route 애플리케이션을 탐색하면, 해당 앱에 존재하는 XSS 취약점이나 악의적인 코드가 관리자 API를 백그라운드에서 마음대로 호출할 수 있습니다.
- **수정 방안**:
  - `ROUTER_MANAGER_HOSTS`와 `ROUTER_VHOST_*`를 적극 권장/기본화하여 관리 도구와 일반 애플리케이션의 Origin(도메인)을 물리적으로 분리해야 합니다.
  - 관리자 API 요청에 `Origin` / `Sec-Fetch-Site` 헤더 검증 또는 임의의 커스텀 헤더(`X-Requested-With` 등) 필수 요구 조건을 추가하여 브라우저의 무단 교차 요청을 방어해야 합니다.

---

### [SEC-07] [Medium] `ALLOWED_HOSTS` 기본값 부재 시 DNS Rebinding을 통한 WebManager 및 VNC 웹소켓 탈취

- **위치**:
  - `router/config/nginx/nginx-service.default.sh` (23-34행: 미설정 시 `default 1;`)
  - `webmanager/backend/handlers_terminal.go` (89행: `websocket.Accept(w, r, nil)`)
  - `router/backend/handlers_vnc.go` (403행: `websocket.Accept(w, r, nil)`)
- **설명**:
  - `coder/websocket` 패키지의 `Accept(w, r, nil)`는 `Origin` 헤더의 호스트가 HTTP 요청의 `r.Host`와 일치하는지 검사합니다.
  - 그러나 `ALLOWED_HOSTS` 환경변수가 비어 있는 경우(기본 상태), Nginx는 인입되는 임의의 `Host:` 헤더를 허용합니다 (`default 1;`).
  - 외부 공격자가 `attacker.com` 도메인을 소유하고 짧은 TTL로 DNS Rebinding 공격을 구성합니다:
    1. 피해자가 `attacker.com` 웹페이지를 방문합니다.
    2. 공격자의 페이지가 로드된 후 DNS가 피해자의 로컬 IP(예: `192.168.1.50:80` 또는 `127.0.0.1:80`)로 재바인딩됩니다.
    3. 브라우저의 스크립트가 `ws://attacker.com/manager/api/terminal`로 WebSocket 연결을 시도합니다.
    4. 브라우저는 `Host: attacker.com`, `Origin: http://attacker.com`을 전송합니다.
    5. Nginx는 `Host` 검사를 통과시키고, `webmanager`의 `websocket.Accept`는 `Origin`과 `Host`가 일치하므로 연결을 수락합니다.

- **파급 효과**:
  - 피해자가 외부 악성 웹사이트를 방문하는 것만으로도, 공격자의 브라우저 스크립트가 피해자 로컬 네트워크의 `code-docker` 내부 `root` 쉘 터미널을 장악하여 임의 명령을 실행할 수 있습니다.
- **수정 방안**:
  - `ALLOWED_HOSTS`를 필수 설정으로 전환하거나, 기본적으로 RFC1918 및 미등록 외부 도메인 Host 헤더를 차단(Fail-Closed)해야 합니다.
  - 웹소켓 핸드셰이크 시 Same-Origin 검사 외에 추가 세션 토큰 검증을 강제해야 합니다.

---

### [SEC-08] [Low - 유저 설정] 외부 Forward-Auth 부재 및 기본 비밀번호 미설정 배포 시 unauthenticated root RCE 노출

- **위치**:
  - `config/code/code-config.default.yaml` (`auth: none`)
  - `webmanager/backend/internal/authgate/gate.go` (325-334행: 미설정 시 `RequirePassword` 통과)
  - `docker-compose.yml` (`ROUTER_HTTP_BIND: 0.0.0.0`, 80 포트 바인딩)
  - `ootb.sh` (79행: `webmanager 비밀번호 설정... [y/N]` 기본값 `n`)
- **설명 및 파급 효과**:
  - 프로젝트 설계상 `code-server`는 `auth: none`으로 동작하며, 앞단에 Authentik/Caddy 등의 외부 리버스 프록시 및 Forward-Auth가 존재할 것을 전제합니다.
  - 그러나 기본 배포 설정은 호스트의 `0.0.0.0:80`에 바인딩되어 있으며, `ootb.sh`를 실행할 때 관리자가 Enter(기본값 n)를 눌러 비밀번호 설정을 넘기면:
    1. `code-server`에 인증 없이 접속하여 웹 VS Code 터미널(root) 실행 가능.
    2. `webmanager`의 `GET /api/terminal`에 인증 없이 접속하여 루트 대화형 PTY 쉘 장악 가능.
    3. `webmanager`의 `/api/files/*`를 통해 `/code` 내부의 모든 파일(SSH 키, gitconfig 등) 임의 읽기/쓰기/삭제 가능.
  - 이 문제는 사용자가 Forward-Auth 프록시를 구성하지 않거나 `WEBMANAGER_AUTH_PASSWORD_HASH`를 설정하지 않음으로써 발생하는 **유저 설정/배포 미흡에 따른 문제**이므로, 보고 기준에 따라 **Low** 심각도로 보고합니다.
- **수정 방안**:
  - 기본 바인딩 주소를 `0.0.0.0` 대신 `127.0.0.1`로 변경하여 외부 노출을 기본 차단.
  - `ootb.sh`에서 비밀번호 설정을 기본값 `Y`로 강제하거나, 비밀번호 미설정 시 컨테이너 실행을 거부(Fail-Closed)하도록 유도.

---

### [SEC-09] [Low - 유저 설정] 리소스 제한(CPU / Memory Limits) 미지정으로 인한 호스트 서비스 거부(DoS)

- **위치**: `docker-compose.yml` (153-159행, 331-335행, 74-77행)
- **설명 및 파급 효과**:
  - `docker-compose.yml`의 모든 서비스(`code-docker`, `code-docker-dind`, `code-docker-router`)의 CPU/메모리 제한 기본값이 `0`으로 설정되어 있습니다.
  - Compose 명세상 `0`은 제한 없음(Unlimited)을 의미합니다.
  - `code-docker` 내부의 빌드 작업(예: c++ 컴파일, 대규모 npm 빌드)이나 `code-dind` 내부에서 폭주하는 컨테이너가 발생할 경우, 호스트 시스템의 메모리와 CPU를 전부 고갈시켜 호스트 OS의 OOM Killer가 호스트 데몬들을 강제 종료시킬 위험이 있습니다.
  - 이 역시 사용자 환경변수(`.env`의 `CODE_MEM_LIMIT` 등)를 통해 제어되는 설정 사항이므로 **Low** 심각도로 보고합니다.
- **수정 방안**:
  기본 템플릿(`example-env`)에 시스템 안정을 위한 합리적인 기본 리소스 상한선(예: Host RAM의 80%, CPU 코어 수 제한)을 기본 활성화 상태로 제공.

---

### [SEC-10] [Low] `code-dind`: `dind-authz`에서 `UsernsMode` 및 `docker exec` 권한 상승 검증 누락

- **위치**: `code-dind/dind-authz/policy.go` (42-64행, 116-133행, 218-229행)
- **설명 및 파급 효과**:
  - `dind-authz`는 `PidMode`, `NetworkMode`, `IpcMode`, `CgroupnsMode`가 `"host"`인 경우는 거부하지만, `UsernsMode`는 검사하지 않습니다.
  - 따라서 사용자가 강화 모드인 `DIND_TARGET=dind-authz-remap`(`--userns-remap`)을 선택해 배포했더라도, 컨테이너 생성 시 `"UsernsMode": "host"`를 지정하면 userns remap을 무력화하고 DinD 내부의 실제 루트 권한으로 컨테이너를 실행할 수 있습니다.
  - 또한 `POST /containers/{id}/exec` 엔드포인트는 `decide()` 검사 대상에 포함되지 않아, unprivileged 컨테이너 내부에서 `docker exec --privileged`를 통해 권한을 상승시키는 호출을 차단하지 못합니다.
- **수정 방안**:
  - `createBody.HostConfig`에 `UsernsMode string`을 추가하고 `hc.UsernsMode == "host"` 검사를 추가.
  - `isContainersExec` 검사를 추가하여 `Privileged: true`를 요구하는 exec 호출을 거부.

---

## 4. 종합 제언 (Recommendations)

1. **dind-authz 파일시스템 심볼릭 링크 검증 도입 (최우선 과제)**:
   `/code` 마운트 소스 검증 시 문자열 접두사 비교가 아닌 커널 파일시스템 레벨의 실제 경로(`filepath.EvalSymlinks`) 검증을 반드시 적용해야 컨테이너 격리 및 호스트 보호가 보장됩니다.
2. **Netgate 방화벽 원자적 교체 구현**:
   30초마다 수행되는 `iptables -F` 방식을 폐기하고, 임시 체인을 구성한 후 원자적으로 점프 규칙을 교체하여 패킷 누수 윈도우를 원천 차단해야 합니다.
3. **router-manager 셋업 보호**:
   초기 비밀번호가 설정되지 않은 상태에서 외부 네트워크의 누구나 관리자 권한을 선점할 수 없도록, 콘솔 출력 1회용 토큰이나 로컬 파일 기반 초기화 메커니즘을 도입해야 합니다.
4. **호스트 바인딩 기본값 및 비밀번호 강제**:
   사용자 설정 부주의로 인한 대형 보안 사고를 방지하기 위해 기본 호스트 바인딩을 `127.0.0.1`로 전환하고, `ootb.sh`에서 비밀번호 설정을 강력히 유도해야 합니다.
5. **원격 빌드 의존성 고정**:
   `router-docker-client`의 `#main` 직접 다운로드를 제거하고, 특정 커밋 해시(Commit SHA) 고정 또는 서브모듈 방식으로 전환하여 빌드 재현성과 공급망 보안을 확보해야 합니다.
