(() => {
    const script = document.currentScript;
    if (!script || !script.src) return;

    const statusUrl = new URL("tailscale/status.json", script.src);
    const BANNER_ID = "tailscale-signin";
    const MANAGER_URL = `${location.origin}/manager/`;

    // Persists which sign-in "state" the user already dismissed, so ignoring
    // the banner actually sticks (across polls *and* page reloads) instead
    // of the old dead `dismissedUrl` variable, which was never assigned and
    // let the banner reappear on literally the next 4s poll. The signature
    // is the authUrl when one exists, else a fixed string for the "not
    // logged in yet, no attempt pending" state (now the common case, since
    // tailscale-service.default.sh's automatic `tailscale up` only fires
    // once ever, not on every restart - see that script). A *new* signature
    // (a fresh authUrl, or the no-URL -> URL transition) always re-prompts
    // once; the same signature repeated does not.
    const IGNORE_KEY = "cd-tailscale-ignored-state";
    const NEEDS_LOGIN_SIGNATURE = "needs-login";

    function getIgnoredSignature() {
        try {
            return localStorage.getItem(IGNORE_KEY);
        } catch {
            return null;
        }
    }
    function setIgnoredSignature(sig) {
        try {
            localStorage.setItem(IGNORE_KEY, sig);
        } catch {
            // Private browsing / storage disabled - the banner will just
            // re-nag on the next poll, no worse than before this change.
        }
    }
    function clearIgnoredSignature() {
        try {
            localStorage.removeItem(IGNORE_KEY);
        } catch {
            // Nothing to clean up if storage isn't available in the first place.
        }
    }

    // Shared closing line on every banner variant - the actual fix for
    // repeated sign-in prompts piling up is not using tailscale at all.
    const disableHintLine = "Tailscale를 사용하지 않으실 거면 .env의 TAILSCALE_ENABLED=false로 끄실 수 있습니다.";

    let notifiedUrl = null;
    // null = not known yet, so the first poll never fires a false
    // "just connected" toast for a session that was already up.
    let wasConnected = null;

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

        const authUrl = data && data.authUrl;
        const backendState = (data && data.backendState) || "Unknown";
        const connected = backendState === "Running";

        if (!connected) {
            const signature = authUrl || NEEDS_LOGIN_SIGNATURE;
            const ignore = () => {
                setIgnoredSignature(signature);
                window.CDDialog.hide(BANNER_ID);
            };

            if (signature !== getIgnoredSignature()) {
                if (authUrl) {
                    window.CDDialog.banner(BANNER_ID, {
                        title: "Tailscale sign-in required",
                        lines: [backendState, authUrl, disableHintLine],
                        actions: [{ label: "Open sign-in page", href: authUrl }, { label: "Ignore", onClick: ignore }],
                        dismissible: false,
                    });
                } else {
                    window.CDDialog.banner(BANNER_ID, {
                        title: "Tailscale sign-in required",
                        lines: [backendState, "webmanager의 Tailscale 탭에서 로그인을 시도할 수 있습니다.", disableHintLine],
                        actions: [{ label: "Open webmanager", href: MANAGER_URL }, { label: "Ignore", onClick: ignore }],
                        dismissible: false,
                    });
                }
            } else {
                window.CDDialog.hide(BANNER_ID);
            }

            if (authUrl && authUrl !== notifiedUrl) {
                notifiedUrl = authUrl;
                window.CDDialog.notify({
                    title: "Tailscale sign-in required",
                    body: authUrl,
                    onClick: () => window.open(authUrl, "_blank", "noopener"),
                });
            }
        } else {
            window.CDDialog.hide(BANNER_ID);
            clearIgnoredSignature();
        }

        if (connected && wasConnected === false) {
            window.CDDialog.toast({ title: "Tailscale connected", kind: "success" });
            window.CDDialog.notify({
                title: "Tailscale connected",
                body: "This code-docker instance is now reachable on your tailnet.",
            });
        }
        wasConnected = connected;
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
