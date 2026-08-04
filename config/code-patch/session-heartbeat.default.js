(() => {
    // Captured immediately, at top-of-script execution — this patch is
    // injected before </head> (code-server-autoinstall's
    // apply_resource_inject) so it runs before workbench boot, but the
    // workbench is expected to eventually history.replaceState() the query
    // string away. Reading it now rather than lazily inside heartbeat() is
    // what keeps this value from becoming undefined once that happens.
    const folder = new URLSearchParams(location.search).get("folder");

    // sessionStorage (not localStorage) so the id is scoped to this tab: a
    // refresh keeps the same id (still "the same open tab"), a new tab or a
    // closed-and-reopened one gets a fresh id, matching what "currently open
    // tabs" is meant to mean.
    const ID_KEY = "cd-session-heartbeat-id";
    let id;
    try {
        id = sessionStorage.getItem(ID_KEY);
        if (!id) {
            id = crypto.randomUUID();
            sessionStorage.setItem(ID_KEY, id);
        }
    } catch {
        // Private browsing / storage disabled - fall back to an id that's
        // stable for this script instance at least, so a burst of heartbeats
        // before the tab closes still coalesces into one entry server-side.
        id = crypto.randomUUID();
    }

    const HEARTBEAT_URL = `${location.origin}/manager/api/sessions/heartbeat`;
    const INTERVAL_MS = 30000;

    // Zero user-facing surface by design (unlike tailscale-notify.js) - a
    // missing webmanager (older code-docker without this endpoint, or a
    // network hiccup) just means this tab silently doesn't show up in the
    // session list, nothing more.
    async function heartbeat() {
        try {
            await fetch(HEARTBEAT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, folder, userAgent: navigator.userAgent }),
            });
        } catch {
            return;
        }
    }

    heartbeat();
    setInterval(heartbeat, INTERVAL_MS);
})();
