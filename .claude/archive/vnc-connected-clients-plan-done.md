> **상태 갱신 (2026-09-06): 구현 완료.** 아래 "Shape of the fix" 1~4를 그대로
> 구현했고, 이 문서가 미해결로 남겨둔 재접속 문제도 같이 풀었다. 현재 상태는
> `router/CLAUDE.md`의 VNC 절과 `router/docs/vnc.md`의 "연결된 클라이언트" 절.
>
> 원안이 놓쳤거나 틀렸던 것 두 가지:
>
> 1. **`reconnect=1` 때문에 그냥 `Close()`만 하면 아무 일도 안 일어난다.** noVNC가
>    곧바로 재접속하므로 "끊기" 버튼이 무반응처럼 보인다. 그래서 끊긴 클라이언트를
>    15초 동안 재접속 거부하는 창(`vncKickWindow`)을 같이 넣었다.
> 2. **router-manager는 클라이언트 IP를 볼 수 없었다.** 유닉스 소켓으로만 listen
>    하는데(`main.go`의 `listen()`) nginx의 router-manager location들이
>    `X-Real-IP`/`X-Forwarded-For`를 안 넘기고 있었다 — 즉 `r.RemoteAddr`가 모든
>    클라이언트에 대해 동일한 무의미한 값이었고, 그 IP로 키를 잡은 kick 창은 한
>    명을 끊으면 **전원이 15초 막히는** 동작이 됐을 것이다. nginx 쪽에 헤더를
>    추가하고 `realClientIP()`를 새로 뒀다(`clientKey`는 그대로 — authgate의
>    per-IP 백오프도 같은 맹점을 갖고 있지만 그건 별개 결정이라 손대지 않았다).
>    kick 키도 IP + User-Agent로 바꿔서 같은 NAT 뒤의 다른 브라우저가 같이 끊기지
>    않게 했다.
>
> 사용자가 원래 요청한 것("그냥 브라우저가 나 켜져 있어 정도만 알려주는거",
> "브라우저를 죽이기 보단 그 안 뷰를 꺼주는거")과 정확히 맞는 동작이다 — 서버가
> 브릿지를 끊으면 그쪽 noVNC는 연결 해제 상태가 되고, 브라우저 창 자체는 그대로다.

# router VNC: list and disconnect connected clients

Raised 2026-08-29 by the user: two browser tabs (or a browser plus a native client)
end up on the same VNC target, the desktop starts fighting over its own size, and
there is no way to find out from the UI who else is attached — let alone to kick them.
Scoped as "check whether this is easy" first; the answer is **yes for router-mediated
clients, no for the rest** (see the limitation section), so it is worth doing but the
UI has to be honest about what it can see.

## Why nothing can be listed today

`router/backend/handlers_vnc.go`'s `handleVncSocket` dials the target's raw RFB port,
wires the browser WebSocket to it with a pair of `io.Copy` goroutines, and keeps **no
handle anywhere**. `upstream`, `sock` and the `context.CancelFunc` are all locals that
go out of scope when the HTTP request returns. The only trace a connection leaves is
two `log.Printf` lines (`vnc: %s -> %s connected` / `... closed`) — logs, not state,
so nothing is queryable at runtime. `internal/vnc`'s `Target`/`Info` carry no
last-connected time, remote address or connection count either.

The frontend already knows concurrent clients are a real problem — `Vnc.tsx`'s
"새 창으로 옮기기" flow tears down its own embed and waits `HANDOFF_DELAY_MS` before
opening the popup, with a comment explaining that two clients fight over the desktop
size in `remote` resize mode. But that only choreographs the two viewers this one page
opened itself; a client from another browser is invisible to it. That gap is exactly
the user's complaint.

## Shape of the fix

1. A small connection registry in `handlers_vnc.go`: `map[string][]*vncConn` keyed by
   target name behind a mutex (the same package-level-mutex idiom `internal/vnc`
   already uses), each entry holding remote address, connect time, and the connection
   itself. Register right after `websocket.Accept`, deregister via `defer`.
2. `GET /api/vnc/targets/{name}/clients` and
   `DELETE /api/vnc/targets/{name}/clients/{id}`, both behind `gate.RequirePassword`
   the way the `/ws` route already is — disconnecting someone is at least as sensitive
   as connecting.
3. Disconnecting is then just `Close()` on the stored connection from another
   goroutine: that unblocks the blocked `io.Copy` and the existing `cancel()`/`<-done`
   teardown path runs itself. No new teardown logic.
4. Frontend: a client-count badge per row in `Vnc.tsx`'s target table (next to the
   existing `routeMissing`/`routeDiverged` badges), expanding to a per-client list with
   a disconnect button using the `ConfirmDialog` already imported there.

Bounded work, but genuinely new state — this is a feature, not a config toggle.

## The limitation the UI has to state

A registry only sees connections that went through router's own bridge. wayvnc accepts
concurrent clients and its RFB port is reachable by other paths (Tailscale forwards, a
direct route), so a native client (TigerVNC and friends) connecting straight to the
target would still be invisible and unkickable. Anything claiming to be a complete
"who is connected" list would be lying.

Ground truth needs wayvnc's own control socket (`wayvncctl`), which nothing in
code-docker or roblox-studio-docker wires up today —
`roblox-studio-docker/config/supervisor/wayvnc-service.sh` passes only
`--output`/bind/port (plus optional `--gpu` and `-C`), no control-socket flag. That is
a separate, less certain piece of work: it needs a live wayvnc to confirm the command
surface for the installed version, and a decision about where to expose the socket so
router can reach it.

Suggested order: ship (1)–(4) with the panel labelled as router-mediated connections
only, and treat the `wayvncctl` integration as its own follow-up.


---

## 실제로 돌려서 확인한 것 (2026-09-06)

테스트 스택의 `studio-vnc` 대상에 WebSocket 두 개를 서로 다른 User-Agent로 붙이고
확인:

```
A: 101 Switching Protocols | B: 101 Switching Protocols
clients: [(4, 'KickTest/1.0', '100.64.0.14'), (5, 'OtherBrowser/2.0', '100.64.0.14')]
DELETE /clients/4 -> 200
after kick: [(5, 'OtherBrowser/2.0')]
kicked UA reconnect: 403 Forbidden
other UA connect:    101 Switching Protocols
```

읽을 것 세 가지:

1. `remoteIp`가 유닉스 소켓 피어가 아니라 **실제 클라이언트 IP**(tailscale CGNAT
   대역)로 나온다 — nginx `X-Real-IP` 추가 + `realClientIP()`가 실제로 동작한다는 뜻.
2. 끊긴 쪽만 목록에서 사라지고, **같은 IP의 다른 User-Agent는 영향을 안 받는다** —
   kick 키를 IP+UA로 바꾼 것의 효과.
3. 끊긴 쪽의 즉시 재접속은 403 — noVNC의 `reconnect=1` 자동 재연결을 실제로 막는다.

15초가 지나면 다시 붙는다. 이 창 길이는 판단값이지 측정값이 아니다(noVNC의 재연결
백오프는 몇 초 수준). 실사용에서 너무 길거나 짧으면 `vncKickWindow` 하나만 고치면 된다.
