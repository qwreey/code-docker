# code-docker 외부자 시선 프로젝트 분석 및 보안 감사 보고서

- **작성일자**: 2026-09-16
- **감사 대상**: `qwreey/code-docker` 저장소 전체 및 연계 서브모듈 (`router`, `code-dind`, `code-server-autoinstall`, `envmigrate` 등)
- **감사 관점**:
  1. **외부 침투 테스터 / 공격자 관점**: 공용 인터넷 또는 로컬 네트워크에 노출되었을 때의 공격 표면 및 악용 가능성
  2. **외부 오픈소스 사용자 / 운영자 관점**: 기본 설정의 안전성, 아키텍처 복잡도, 유지보수성, 호스트 시스템 영향도

---

## 1. 종합 요약 (Executive Summary)

`code-docker`는 Arch Linux 기반의 `code-server`, `sshd`, `mise`, `Docker-in-Docker (DinD)`, 독립된 네트워크 경계 컨테이너 `router`, 호스트 네트워크 에이전트 `netinit-docker`, 그리고 통합 관리 패널 `webmanager`가 결합된 **고도로 정교하고 복합적인 개인용 클라우드 개발 환경**입니다.

코드베이스 전반에 걸쳐 커맨드 인젝션 방어, 경로 정규화, 구조화된 로깅 파이프라인(`vector`), 네트워크 격리(`netgate`) 등 작성자의 깊은 시스템 이해도와 고민이 돋보입니다.

그러나 **"외부자 시선"**에서 검토했을 때, 이 프로젝트는 다음과 같은 심각한 보안 및 구조적 문제를 안고 있습니다:

1. **"Secure by Default" 원칙의 전면 부재**: 기본 설정으로 실행 시 `0.0.0.0:80`에 무인증 상태로 바인딩되며, 외부 방문자에게 **즉각적인 Root 웹 터미널(PTY)과 임의 파일 조작 권한**을 제공합니다.
2. **DinD-Authz의 심볼릭 링크 검증 누락으로 인한 샌드박스 완전 무력화**: 컨테이너 생성 정책 검증기(`dind-authz`)가 문자열 정리(`path.Clean`)만 수행하고 심볼릭 링크를 해석하지 않아, `/code` 내 심볼릭 링크를 통해 호스트 블록 디바이스나 정책 파일을 중첩 컨테이너에 바인드 마운트할 수 있습니다.
3. **DNS Rebinding을 통한 원격 코드 실행(RCE) 경로 존재**: `ALLOWED_HOSTS`가 기본 비어있고 WebSocket Origin 검증이 Host 헤더와의 일치 여부만 비교하므로, 사용자가 악성 웹사이트를 방문하는 것만으로 브라우저를 통해 로컬 컨테이너 루트 쉘을 탈취당할 수 있습니다.
4. **극단적인 아키텍처 복잡도 및 결합도**: 컨테이너 4개, 프로세스 매니저 2개, 리버스 프록시 3개(Nginx 2개, Caddy 1개), DNS 서버 2개, iptables 제어, `nsenter` 기반 라우트 주입 등 단일 개발 환경으로서는 지나치게 취약하고 디버깅이 난해한 구조를 지닙니다.
5. **호스트 파일 권한 오염**: 모든 프로세스가 `root`로 동작하여 호스트 볼륨(`data/code`)에 생성된 파일들이 전부 `root:root` 소유로 고정되어 호스트 사용자의 일반 작업을 방해합니다.

---

## 2. 취약점 및 보안 문제 매트릭스

| ID | 구분 | 취약점 / 문제점 | 심각도 | 영향 |
|---|---|---|---|---|
| **SEC-01** | 보안 | 기본 배포 시 0.0.0.0:80 무인증 노출 (Fail-Open) | **Critical** | 외부 인터넷/LAN 접속자에게 즉각적인 Root 권한 및 파일시스템 탈취 |
| **SEC-02** | 보안 | DinD-Authz의 심볼릭 링크 미검증으로 인한 격리 우회 | **Critical** | 중첩 도커 샌드박스를 우회하여 호스트 블록 디바이스/설정 탈취 |
| **SEC-03** | 보안 | DNS Rebinding 기반 WebSocket 원격 루트 쉘 탈취 (RCE) | **High** | 외부 악성 사이트 방문만으로 로컬 인스턴스에 루트 쉘 실행 |
| **SEC-04** | 보안 | Webmanager 상태 변경 API의 CSRF 보호 부재 | **High** | 사용자의 브라우저를 유도하여 임의 프로젝트 및 파일 삭제, 프로세스 종료 |
| **SEC-05** | 보안 | TRUSTED_PROXIES 설정 시 Nginx 내부 소스 차단(DENY) 우회 | **High** | X-Forwarded-For 스푸핑을 통해 라우터 관리 API 및 Exports 접근 통제 무력화 |
| **SEC-06** | 보안 | Webmanager를 통한 민감 자격증명(Git/SSH/OAuth) 노출 | **Medium** | 파일 관리자 API를 통해 토큰, 비공개키, 세션 정보 열람 가능 |
| **SEC-07** | 보안 | Egress Netgate 방화벽 재적용 시 비원자적 플러시 레이스 | **Medium** | 30초 주기 iptables -F 시점에 미필터링 트래픽 통과 가능 |
| **SEC-08** | 보안 | 원격 Git 브랜치(floating `#main`) 및 unpinned 스크립트 빌드 | **Medium** | 업스트림 저장소 변조 시 즉시 호스트 root 탈취로 이어지는 공급망 위험 |
| **SEC-09** | 보안 | Netinit-docker의 과도한 호스트 권한 (Host Root 동등) | **Medium** | 도커 소켓 + SYS_ADMIN + NET_ADMIN + Host Netns 결합으로 단일 컨테이너 침해 시 호스트 전체 장악 |

---

## 3. 세부 보안 취약점 분석

### SEC-01 [Critical]: 기본 배포 시 0.0.0.0:80 무인증 노출 (Fail-Open)

#### 취약점 상세
1. `docker-compose.yml` 및 `router/docker-compose.router.yml`에서 HTTP 포트 바인딩 기본값은 다음과 같습니다:
   ```yaml
   ports:
     - "${ROUTER_HTTP_BIND:-0.0.0.0}:${ROUTER_HTTP_PORT:-80}:80"
   ```
2. `code-server`는 `code-config.default.yaml`에서 `auth: none`으로 설정되어 자체 인증이 전혀 없습니다.
3. `webmanager`의 경우 `webmanager/backend/internal/authgate/gate.go`에서 비밀번호 해시가 없을 때의 동작이 **Fail-Open**으로 작성되어 있습니다:
   ```go
   func (g *Gate) RequirePassword(next http.Handler) http.Handler {
       return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
           if !g.Configured() {
               next.ServeHTTP(w, r) // ← 해시 미설정 시 무조건 통과!
               return
           }
   ```
4. `router` 저장소에서는 2026-09-07 보안 검토(C2) 후 `RequirePassword`를 **Fail-Closed (503 에러)**로 수정했으나, `webmanager`는 여전히 이전의 위험한 Fail-Open 방식을 유지하고 있습니다.
5. 대화형 초기 설정 스크립트인 `ootb.sh` 및 `ootb-config.sh`는 `ROUTER_HTTP_BIND`나 타임존 등은 묻지만, **Webmanager 비밀번호 설정을 전혀 프롬프트하지 않습니다.**

#### 파급 효과
- 외부 VPS(AWS, Oracle, DigitalOcean 등)나 포트포워딩된 홈서버에서 기본 안내대로 실행하는 즉시, 인터넷의 임의 스캐너 및 공격자가 `http://<IP>/` (code-server) 및 `http://<IP>/manager/` (webmanager)에 아무런 인증 없이 접근할 수 있습니다.
- `GET /manager/api/terminal` WebSocket을 열면 즉시 **컨테이너 내부 Root PTY 쉘**이 주어지며, `POST /manager/api/files/*`를 통해 호스트에 마운트된 모든 프로젝트 파일을 탈취/변조할 수 있습니다.

---

### SEC-02 [Critical]: DinD-Authz의 심볼릭 링크(Symlink) 미검증으로 인한 샌드박스 탈출

#### 취약점 상세
`code-dind`는 DinD 환경에서 컨테이너의 권한 상승(`Privileged`, 위험 Capability, 호스트 마운트 등)을 막기 위해 자체 Go 플러그인 `dind-authz`를 개발하여 적용했습니다 (`code-dind/dind-authz/policy.go`).

바인드 마운트 검증 함수인 `bindSourceAllowed`를 살펴보면 다음과 같습니다:
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
- 이 검증은 순수하게 문자열 레벨의 `path.Clean(src)`만 수행하며, **심볼릭 링크(`filepath.EvalSymlinks`)를 전혀 해석하지 않습니다.**
- `code-docker` 컨테이너와 `code-docker-dind` 컨테이너는 호스트의 `./data/code`를 동일하게 `/code`로 공유 마운트하고 있습니다.
- `code-docker-dind`는 도커 데몬을 실행하기 위해 **호스트 레벨에서 `privileged: true`**로 동작합니다. 따라서 dind 컨테이너 내부의 `/dev`에는 호스트 시스템의 물리 디스크 노드(`/dev/nvme0n1`, `/dev/sda` 등)가 모두 노출되어 있습니다.

#### 공격 시나리오
1. 공격자가 `code-docker` 내부(또는 터미널/에이전트)에서 다음과 같이 심볼릭 링크를 생성합니다:
   ```sh
   ln -s /dev /code/escape_dev
   ln -s /etc/dind-authz.d /code/escape_policy
   ```
2. 도커 CLI를 통해 중첩 컨테이너를 생성합니다:
   ```sh
   docker run -v /code/escape_dev:/host_dev alpine
   ```
3. `dind-authz` 플러그인은 요청 바인드 경로 `/code/escape_dev`가 `/code/`로 시작하므로 **정상 경로로 판단하고 승인**합니다.
4. DinD 데몬이 컨테이너를 실행할 때 커널 VFS가 심볼릭 링크를 해석하여 DinD 컨테이너의 `/dev`를 마운트합니다.
5. 중첩 컨테이너는 unprivileged 상태이더라도 `/host_dev`를 통해 호스트의 원시 디스크 파티션에 직접 쓰기 작업을 수행하거나 호스트 파일시스템을 마운트하여 **호스트 OS를 완전히 장악**할 수 있습니다.
6. 또한 `/code/escape_policy`를 통해 `dind-authz.d`에 `ALL` Capability나 `Privileged: true`를 허용하는 JSON 정책을 주입하여 Authz 플러그인을 완전히 무력화할 수도 있습니다.

---

### SEC-03 [High]: DNS Rebinding 기반 WebSocket 원격 루트 쉘 탈취 (RCE)

#### 취약점 상세
1. `config/nginx/nginx.default.conf` 및 `router/config/nginx/nginx.default.conf`에서 `ALLOWED_HOSTS`는 기본적으로 빈 문자열입니다. 빈 문자열일 경우 `default 1;`로 매핑되어 **임의의 Host 헤더를 무조건 수락**합니다.
2. `webmanager/backend/handlers_terminal.go`의 WebSocket 핸들러는 `coder/websocket` 라이브러리의 기본 Origin 검증을 사용합니다:
   ```go
   conn, err := websocket.Accept(w, r, nil)
   ```
   `Accept`의 기본 동작은 요청의 `Origin` 호스트가 `Host` 헤더와 일치하는지만 비교합니다.

#### 공격 시나리오
1. 피해자 개발자가 로컬 머신에서 `docker compose up`으로 `code-docker`를 띄워두고 있습니다.
2. 피해자가 외부 웹 브라우징 중 공격자의 웹페이지(`evil.com`)를 방문합니다.
3. 공격자는 짧은 TTL을 가진 DNS 서버를 이용하여 `rebind.evil.com`의 A 레코드를 처음에는 공격자 IP로, 직후 `127.0.0.1`로 변경합니다 (DNS Rebinding).
4. 브라우저는 동일 출처로 인식하고 `rebind.evil.com/manager/api/terminal`로 WebSocket 연결을 시도합니다.
5. 브라우저가 전송하는 헤더:
   - `Host: rebind.evil.com`
   - `Origin: http://rebind.evil.com`
6. 라우터 및 컨테이너 Nginx는 `ALLOWED_HOSTS`가 꺼져 있으므로 통과시킵니다.
7. Webmanager는 `Origin`과 `Host`가 둘 다 `rebind.evil.com`으로 일치하므로 WebSocket 업그레이드를 승인합니다.
8. Webmanager Authgate는 기본 비활성화(Fail-Open) 상태이므로 인증 없이 Root PTY 쉘이 열립니다.
9. 공격자의 JavaScript가 WebSocket을 통해 임의 쉘 명령어를 전송하여 **개발자 호스트/컨테이너에 대한 무인증 RCE**를 달성합니다.

---

### SEC-04 [High]: Webmanager 상태 변경 API의 CSRF 보호 부재

#### 취약점 상세
Webmanager의 주요 백엔드 핸들러는 CSRF 토큰이나 Origin 검증이 없습니다. 특히 일부 위험한 엔드포인트는 쿼리 파라미터만으로 동작합니다:
- `POST /api/projects/delete?path=/code/Projects/target`
- `POST /api/projects/delete-reclaimable?path=...&target=...`
- `POST /api/supervisor/processes/{name}/stop`
- `POST /api/processes/{pid}/signal` (JSON body: `{"signal":"KILL"}`)

#### 공격 시나리오
- 브라우저는 `<form method="POST">` 또는 `fetch(..., { mode: 'no-cors' })` 호출 시 단순 요청(Simple Request)에 대해 사전 검증(CORS Preflight) 없이 요청을 목적지로 전송합니다.
- `Content-Type: text/plain`으로 JSON 페이로드를 전송할 경우에도 Go의 `json.NewDecoder(r.Body).Decode(&body)`는 Content-Type 헤더를 확인하지 않고 본문을 파싱합니다.
- 따라서 외부 웹사이트에 심어진 단순 스크립트만으로 피해자의 로컬 인스턴스 프로젝트 디렉터리를 강제 삭제(`os.RemoveAll`)하거나 주요 프로세스를 원격에서 종료시킬 수 있습니다.

---

### SEC-05 [High]: TRUSTED_PROXIES 설정 시 Nginx 내부 소스 차단(DENY) 우회

#### 취약점 상세
1. `router/config/nginx/nginx.default.conf`는 관리자 API(`location /router/`) 및 외부 노출 트래픽(`location /exports/`)에 대해 내부 컨테이너의 직접 접근을 막는 `deny ${internal_subnet}; allow all;` 디렉티브를 적용합니다.
2. 하지만 상단 HTTP 블록에 다음 설정이 존재합니다:
   ```nginx
   ${NGINX_TRUSTED_PROXIES_DIRECTIVES}
   real_ip_header X-Forwarded-For;
   real_ip_recursive on;
   ```
3. Nginx의 `ngx_http_access_module`(`deny`/`allow`)은 `ngx_http_realip_module`에 의해 재작성된 `$remote_addr`을 기준으로 평가합니다.
4. 만약 운영자가 외부 리버스 프록시(동일 호스트의 Docker 네트워크에 상주하는 Caddy/Nginx Proxy Manager 등)를 신뢰하기 위해 `TRUSTED_PROXIES`에 Docker 서브넷(예: `172.16.0.0/12`)을 등록할 경우:
   - `code-docker` 내부의 임의 프로세스가 `X-Forwarded-For: 8.8.8.8` 헤더를 조작하여 `http://router/router/api/...`로 전송하면,
   - Nginx는 클라이언트 IP를 `8.8.8.8`로 인식하여 `deny` 규칙을 우회하고 라우터 관리 API에 도달할 수 있게 됩니다.

---

### SEC-06 [Medium]: Webmanager 파일 관리자를 통한 민감 자격증명 노출

#### 취약점 상세
- `WEBMANAGER_FILES_ROOT`의 기본값은 `/code`입니다.
- 사용자 편의를 위해 `git credentials`, SSH 키, Claude 설정 등이 `/code` 하위에 평문 파일로 저장됩니다:
  - `/code/.git-credentials` (Git 저장소 HTTP 토큰/비밀번호 평문 저장)
  - `/code/.ssh/id_rsa`, `/code/.ssh/id_ed25519` (SSH 비공개키)
  - `/code/.claude.json`, `/code/.claude/` (Claude Code OAuth 토큰 및 세션)
  - `/code/Projects/*/.env` (각종 프로젝트 환경변수 및 API 키)
- Authgate가 꺼져 있는 기본 상태에서는 `GET /manager/api/files/content?path=/code/.git-credentials` 호출 하나로 개발자의 모든 Git 토큰이 유출됩니다.

---

### SEC-07 [Medium]: Egress Netgate 방화벽 재적용 시 비원자적(Non-Atomic) 플러시 레이스

#### 취약점 상세
`router/config/netgate/firewall.default.sh`는 매 30초마다 설정 변경을 반영하기 위해 다음을 실행합니다:
```sh
ensure_chain() {
    iptables -t "$1" -N "$2" 2>/dev/null || iptables -t "$1" -F "$2"
}
```
스크립트 주석(line 36-44)에도 명시되어 있듯이:
> *"Each cycle flushes and rebuilds netgate's own chains... there's a brief window every cycle where the rebuilt chain is empty and FORWARD's default ACCEPT policy applies unfiltered."*

체인을 비운 뒤 새 규칙들이 루프를 돌며 하나씩 삽입되는 동안, FORWARD 체인의 기본 ACCEPT 정책에 의해 RFC1918 및 클라우드 메타데이터 IP(`169.254.169.254`)로의 아웃바운드 패킷이 누출될 수 있는 레이스 컨디션 윈도우가 주기적으로 발생합니다. 임시 체인을 생성하여 원자적으로 교체(`iptables-restore` 또는 체인 스왑)하지 않는 설계상 결함입니다.

---

### SEC-08 [Medium]: 원격 Git 브랜치(floating `#main`) 및 Unpinned 스크립트 의존성

#### 취약점 상세
1. `Dockerfile` 및 `code-dind/Dockerfile`에서 외부 코드를 가져오는 방식:
   ```dockerfile
   ADD https://github.com/qwreey/router-docker-client.git#main:netshare /etc/code-docker/netshare
   ADD https://github.com/qwreey/router-docker-client.git#main:dns-local /etc/code-docker/router-client/dns-local
   ```
2. `docker-compose.yml`:
   ```yaml
   context: "${NETINIT_DOCKER_CONTEXT:-https://github.com/qwreey/router-docker-client.git#main:netinit-docker}"
   ```
- Git 커밋 해시나 태그가 아닌 부동 브랜치(`#main`)를 지정하고 있습니다.
- 해당 원격 저장소가 해킹되거나 악의적인 커밋이 유입될 경우, 이를 빌드하는 모든 사용자가 즉시 감염됩니다. 특히 `netinit-docker`는 호스트 도커 소켓과 `SYS_ADMIN`을 가지고 있으므로 **즉각적인 호스트 장악**으로 이어집니다.
- 또한 Docker 엔진은 원격 Git URL 컨텍스트를 캐싱하기 때문에, 정작 업스트림에서 보안 버그를 수정했을 때 사용자가 `--no-cache`를 주지 않으면 수정 사항이 빌드에 반영되지 않는 "침묵의 캐시 버그"를 유발합니다 (실제로 CLAUDE.md에 이로 인한 장애 이력이 기록되어 있음).
- 부팅 시 실행되는 `user-init.default.sh`는 `qs_setup.fish`의 해시를 검증하도록 개선되었으나, 해당 스크립트 내부에서 여전히 Fisher 플러그인과 `curl https://mise.run | sh`를 무검증으로 다운로드하여 root로 실행합니다.

---

### SEC-09 [Medium]: Netinit-docker의 과도한 호스트 권한 (Blast Radius)

#### 취약점 상세
`code-docker-netinit-docker`는 다음과 같은 권한을 가집니다:
- `network_mode: host`
- `cap_add: [NET_ADMIN, SYS_ADMIN]`
- `/var/run/docker.sock:/var/run/docker.sock:ro`
- `/var/run/docker/netns:/var/run/docker/netns:ro,rslave`

도커 소켓은 `:ro`로 마운트하더라도 소켓 파일 아이노드 자체만 읽기 전용일 뿐, 소켓을 통한 REST API 통신(컨테이너 생성, 호스트 루트 볼륨 마운트 등)은 100% 정상 작동합니다. 즉, 이 컨테이너는 **호스트의 완전한 root 권한**을 보유합니다.
단지 타깃 컨테이너의 기본 라우트를 심고 DOCKER-USER 규칙을 넣기 위한 용도로 쓰기에는 컨테이너 탈취 시 호스트가 완전히 장악되는 폭발 반경(Blast Radius)이 지나치게 큽니다.

---

## 4. 구조 및 운영 관점의 문제점 (Outsider's Perspective)

외부 엔지니어나 사용자가 이 프로젝트를 도입하거나 유지보수하려고 할 때 직면하는 구조적 결함들입니다:

### 4.1 호스트 파일시스템 권한 오염 (Root Permission Pollution)
- 컨테이너 내부의 모든 서비스(`code-server`, `webmanager`, `mise`, 사용자 셸)가 `root` (UID 0)로 실행됩니다.
- 그 결과, 컨테이너 내에서 생성된 모든 소스코드, git 설정, 캐시 파일들이 호스트의 `./data/code`에 `root:root` 소유권으로 저장됩니다.
- 호스트의 일반 사용자(UID 1000 등)는 IDE 밖에서 git 명령어를 쓰거나 파일을 편집/삭제하려면 매번 `sudo`를 사용해야 하거나 권한 오류에 직면합니다.
- 현대 컨테이너 개발 환경(LinuxServer, Dev Containers)의 표준인 `PUID`/`PGID` 환경변수 매핑이나 사용자 네임스페이스 격리가 지원되지 않습니다.

### 4.2 오버엔지니어링과 극단적인 시스템 복잡도
단일 사용자의 개발 환경을 위해 구동되는 컴포넌트 목록:
- **컨테이너**: `code-docker`, `code-docker-dind`, `code-docker-router`, `code-docker-netinit-docker`
- **프로세스 감시자**: 컨테이너 2개에서 각각 `supervisord` 실행
- **웹 서버 / 프록시**: 컨테이너별 Nginx 2개 + Caddy + Webmanager Go 서버 + Code-server Node.js
- **DNS**: 컨테이너별 dnsmasq 2개
- **네트워크 기교**: `SandboxKey` 추적 후 `nsenter`로 netns 진입하여 `ip route replace`, `iptables` 체인 동적 생성, `tailscaled` 연동

이 복합 구조로 인해 네트워크 지연이나 서비스 간 레이스 컨디션이 빈번하게 발생할 수 있습니다. 예를 들어 호스트 에이전트가 SandboxKey를 찾는 타이밍이나 Docker 캐시 불일치로 인해 **컨테이너는 정상 실행(Up) 중으로 표시되지만 내부에서는 외부 인터넷이나 DNS가 먹통이 되는 침묵의 고장(Silent Failure)**이 발생하기 쉽습니다.

### 4.3 1인 개발자 저장소 생태계와의 강한 결합도
- `qwreey/router-docker`, `qwreey/dind-authz-docker`, `qwreey/router-docker-client`, `qwreey/code-server-autoinstall`, `qwreey/envmigrate`, `qwreey/qwreey-fish` 등 모든 핵심 컴포넌트가 동일한 개인 계정의 서브모듈 및 원격 저장소에 분산 결합되어 있습니다.
- 외부 사용자가 독립적으로 버그를 수정하거나 포크하여 배포하기가 매우 까다롭습니다.

---

## 5. 개선 권고 사항 (Actionable Remediation)

### 단기 조치 (즉시 적용 필요)

1. **Secure by Default 전환**:
   - `example-env` 및 `docker-compose.yml`에서 `ROUTER_HTTP_BIND` 기본값을 `127.0.0.1`로 변경 (원격 노출은 사용자가 명시적으로 `0.0.0.0`으로 설정할 때만 허용).
   - `webmanager`의 `authgate`를 `router`와 동일하게 **Fail-Closed**로 변경 (비밀번호 해시가 설정되지 않은 경우 민감 API 접근 차단 및 설정 안내 반환, 또는 최초 실행 시 콘솔 로그에 무작위 비밀번호를 1회 출력).
   - `ootb-config.sh`에 Webmanager 비밀번호 설정 단계를 필수로 추가.

2. **DinD-Authz 심볼릭 링크 해석 구현**:
   - `policy.go`의 `bindSourceAllowed`에서 검사 대상 경로의 상위 디렉터리들을 `filepath.EvalSymlinks`로 실제 해석한 뒤, 실제 경로가 허용된 접두사(`/code`) 내에 머무는지 검증하도록 수정:
     ```go
     realPath, err := filepath.EvalSymlinks(src)
     // realPath가 allowRoots 내에 있는지 검증
     ```
   - `/code` 내에서 `/dev`, `/var/run`, `/proc`, `/sys` 등을 가리키는 링크를 통한 장치 노출 원천 차단.

3. **Nginx 기본 호스트 필터링 및 WebSocket Origin 검증 강화**:
   - `ALLOWED_HOSTS` 기본값에 `localhost`, `127.0.0.1` 및 인스턴스 IP를 포함시키고, 일치하지 않는 Host 헤더는 403 차단.
   - `webmanager`의 `handleTerminal`에서 요청 `Host` 헤더와의 단순 비교 외에 허용된 호스트 목록에 대한 엄격한 화이트리스트 검증 수행 (DNS Rebinding 방어).

4. **Webmanager 상태 변경 API에 CSRF 방어 적용**:
   - `POST`, `PUT`, `DELETE` 요청에 대해 `Sec-Fetch-Site` 헤더 검증(`same-origin` 확인) 또는 커스텀 헤더(`X-Requested-With` 등) 필수 요구.
   - JSON 파싱 전 `Content-Type: application/json` 검증 강제.

### 중장기 조치 (구조 개선)

1. **외부 Git 의존성 고정 (Pinning)**:
   - Dockerfile 및 Compose 파일의 `#main` 참조를 특정 Git Commit SHA 또는 릴리스 태그로 고정.
2. **원자적 방화벽 규칙 적용 (Atomic Firewall Rule Application)**:
   - `firewall.default.sh`에서 `iptables -F`를 직접 호출하지 말고, 새 체인을 만들어 규칙을 채운 뒤 `iptables -R` 또는 `iptables-restore`를 활용하여 무중단/무누출 원자적 교체 구현.
3. **컨테이너 비루트 실행(PUID/PGID) 지원 검토**:
   - `code-server` 및 사용자 작업 환경을 non-root 사용자로 구동할 수 있는 런타임 옵션 제공하여 호스트 파일 권한 오염 방지.
4. **아키텍처 단순화**:
   - `netinit-docker`의 호스트 소켓 마운트 의존성을 축소하고, 네트워크 라우트 주입 방식을 Docker Compose 표준 네트워크 브리지 옵션이나 안정적인 네이티브 토폴로지로 점진적 통합.
