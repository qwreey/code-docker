(() => {
    const script = document.currentScript;
    if (!script || !script.src) return;

    const statusUrl = new URL("tailscale/status.json", script.src);

    const STYLE_ID = "qwreey-tailscale-notify-style";
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.qwreey-ts-banner {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 999999;
    max-width: 340px;
    padding: 12px 14px;
    border-radius: 6px;
    background: #1f2937;
    color: #f9fafb;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.qwreey-ts-banner .qwreey-ts-row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}
.qwreey-ts-banner a, .qwreey-ts-banner button {
    border: 0;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
}
.qwreey-ts-banner a {
    background: #0ea5e9;
    color: #fff;
}
.qwreey-ts-banner button {
    background: transparent;
    color: #d1d5db;
}
`;
        document.head.appendChild(style);
    }

    let banner = null;
    let dismissedUrl = null;
    let notifiedUrl = null;

    function hideBanner() {
        if (!banner) return;
        banner.remove();
        banner = null;
    }

    function showBanner(authUrl) {
        if (banner) {
            banner.querySelector("a").href = authUrl;
            return;
        }
        banner = document.createElement("div");
        banner.className = "qwreey-ts-banner";

        const text = document.createElement("div");
        text.textContent = "Tailscale sign-in required for this code-docker instance.";
        banner.appendChild(text);

        const row = document.createElement("div");
        row.className = "qwreey-ts-row";

        const open = document.createElement("a");
        open.href = authUrl;
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "Open sign-in page";
        row.appendChild(open);

        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.textContent = "Dismiss";
        dismiss.addEventListener("click", () => {
            dismissedUrl = authUrl;
            hideBanner();
        });
        row.appendChild(dismiss);

        banner.appendChild(row);
        document.body.appendChild(banner);
    }

    function notify(authUrl) {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        if (notifiedUrl === authUrl) return;
        notifiedUrl = authUrl;
        const n = new Notification("Tailscale sign-in required", {
            body: "Click to open the code-docker sign-in page.",
        });
        n.onclick = () => window.open(authUrl, "_blank", "noopener");
    }

    async function poll() {
        let data;
        try {
            const res = await fetch(`${statusUrl}?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`status ${res.status}`);
            data = await res.json();
        } catch {
            hideBanner();
            return;
        }

        const authUrl = data && data.authUrl;
        if (!authUrl) {
            hideBanner();
            return;
        }
        if (authUrl === dismissedUrl) return;
        showBanner(authUrl);
        notify(authUrl);
    }

    poll();
    setInterval(poll, 4000);
})();
