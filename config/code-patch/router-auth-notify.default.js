(() => {
    // Nags until router-manager's own admin-API password is set up - see
    // router/.claude/router-nginx-hardening-plan.md Phase 6. Before this
    // exists, router-manager's mutating routes (Dev Proxy expose CRUD,
    // tailscale config/forwards/publish/login writes) are reachable with
    // zero credentials from anything on code-docker-internal, including a
    // compromised code-docker - the whole point is to get this seen and
    // acted on before an agent (or anything else) starts running.
    const statusUrl = `${location.origin}/router/api/auth/status`;
    const SETUP_URL = `${location.origin}/router/`;
    const BANNER_ID = "router-auth-setup";
    const IGNORE_KEY = "cd-router-auth-ignored";

    function getIgnored() {
        try {
            return localStorage.getItem(IGNORE_KEY) === "1";
        } catch {
            return false;
        }
    }
    function setIgnored() {
        try {
            localStorage.setItem(IGNORE_KEY, "1");
        } catch {
            // Private browsing / storage disabled - the banner just
            // re-nags on the next poll, no worse than before this existed.
        }
    }
    function clearIgnored() {
        try {
            localStorage.removeItem(IGNORE_KEY);
        } catch {
            // Nothing to clean up if storage isn't available in the first place.
        }
    }

    async function poll() {
        let data;
        try {
            const res = await fetch(`${statusUrl}?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`status ${res.status}`);
            data = await res.json();
        } catch {
            window.CDDialog.hide(BANNER_ID);
            return;
        }

        const configured = data && data.required;

        if (configured) {
            // Set up (via /router/ or ROUTER_MANAGER_AUTH_PASSWORD_HASH) -
            // nothing to nag about anymore, and if it gets unset again
            // later (shouldn't normally happen) the banner should come
            // back rather than staying silently dismissed forever.
            window.CDDialog.hide(BANNER_ID);
            clearIgnored();
            return;
        }

        if (getIgnored()) {
            window.CDDialog.hide(BANNER_ID);
            return;
        }

        window.CDDialog.banner(BANNER_ID, {
            title: "router 관리자 비밀번호가 설정되지 않았습니다",
            lines: [
                "Dev Proxy/Tailscale 설정을 아무나(같은 네트워크의 다른 컨테이너 포함) 바꿀 수 있는 상태입니다.",
                "에이전트를 돌리기 전에 지금 설정하는 걸 권장합니다.",
            ],
            actions: [
                { label: "지금 설정하기", href: SETUP_URL },
                { label: "Ignore", onClick: () => { setIgnored(); window.CDDialog.hide(BANNER_ID); } },
            ],
            dismissible: false,
        });
    }

    // cd-dialog.default.js sorts before this file alphabetically so it's
    // already loaded in practice, but don't rely on injection order.
    function start() {
        if (!window.CDDialog) {
            setTimeout(start, 50);
            return;
        }
        poll();
        setInterval(poll, 4000);
    }
    start();
})();
