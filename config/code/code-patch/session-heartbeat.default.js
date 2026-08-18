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

    // localStorage (not sessionStorage) - identifies the browser/device
    // itself rather than one tab, so every tab open in the same browser
    // profile reports the same value and the Sessions UI can group them
    // under one device with a user-assigned friendly name.
    const BROWSER_ID_KEY = "cd-session-heartbeat-browser-id";
    let browserId = "";
    try {
        browserId = localStorage.getItem(BROWSER_ID_KEY) || "";
        if (!browserId) {
            browserId = crypto.randomUUID();
            localStorage.setItem(BROWSER_ID_KEY, browserId);
        }
    } catch {
        // Private browsing / storage disabled - leave empty rather than
        // minting a per-load id, which would just create a fresh "device"
        // in the Sessions UI on every heartbeat instead of grouping.
    }

    const HEARTBEAT_URL = `${location.origin}/manager/api/sessions/heartbeat`;
    const INTERVAL_MS = 30000;

    // Zero user-facing surface by design (unlike tailscale-notify.js) - a
    // missing webmanager (older code-docker without this endpoint, or a
    // network hiccup) just means this tab silently doesn't show up in the
    // session list, nothing more.
    async function heartbeat() {
        try {
            const res = await fetch(HEARTBEAT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, browserId, folder, userAgent: navigator.userAgent }),
            });
            const body = await res.json();
            if (body && body.shouldClose) {
                // Best-effort only: most browsers refuse to script-close a tab
                // that wasn't itself opened via window.open() from a script,
                // and silently no-op instead of throwing. That's an accepted
                // limitation of this convenience feature, not a bug to work
                // around - see the Sessions UI's "닫기 시도" note.
                window.close();
            }
        } catch {
            return;
        }
    }

    heartbeat();
    setInterval(heartbeat, INTERVAL_MS);
})();
