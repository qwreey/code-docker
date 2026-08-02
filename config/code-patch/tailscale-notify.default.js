(() => {
    const script = document.currentScript;
    if (!script || !script.src) return;

    const statusUrl = new URL("tailscale/status.json", script.src);
    const BANNER_ID = "tailscale-signin";

    let dismissedUrl = null;
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

        if (authUrl) {
            if (authUrl !== dismissedUrl) {
                window.CDDialog.banner(BANNER_ID, {
                    title: "Tailscale sign-in required",
                    lines: [backendState, authUrl],
                    actions: [{ label: "Open sign-in page", href: authUrl }],
                });
            }
            if (authUrl !== notifiedUrl) {
                notifiedUrl = authUrl;
                window.CDDialog.notify({
                    title: "Tailscale sign-in required",
                    body: authUrl,
                    onClick: () => window.open(authUrl, "_blank", "noopener"),
                });
            }
        } else {
            window.CDDialog.hide(BANNER_ID);
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
