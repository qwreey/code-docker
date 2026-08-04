(() => {
    // Turns the titlebar's top-left ".window-appicon" (a real code-server /
    // vscode-web DOM class - see code-server-autoinstall's
    // write_window_appicon(), which already repaints its background-image)
    // into a button that opens webmanager as a full-screen overlay iframe.
    // nginx (config/nginx.default.conf) serves webmanager same-origin under
    // /manager/, so the iframe just works with no CORS setup needed.

    const STYLE_ID = "cd-webmanager-launcher-style";
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.window-appicon.cd-webmanager-launcher {
    cursor: pointer;
    transition: filter .15s ease, box-shadow .15s ease;
    border-radius: 4px;
}
.window-appicon.cd-webmanager-launcher:hover {
    filter: brightness(1.4);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .3) inset;
}
.cd-webmanager-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000000;
    background: rgba(0, 0, 0, .6);
    display: none;
    align-items: center;
    justify-content: center;
}
.cd-webmanager-overlay.cd-webmanager-open {
    display: flex;
}
.cd-webmanager-modal {
    position: relative;
    width: 90vw;
    height: 90vh;
    background: #1e1e1e;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
    overflow: hidden;
    display: flex;
}
.cd-webmanager-modal iframe {
    flex: 1;
    width: 100%;
    height: 100%;
    border: 0;
    background: #1e1e1e;
}
.cd-webmanager-close {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 4px;
    background: rgba(255, 255, 255, .08);
    color: #f9fafb;
    font: 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
    transition: background .15s ease;
}
.cd-webmanager-close:hover {
    background: rgba(255, 255, 255, .2);
}
`;
        document.head.appendChild(style);
    }

    const MANAGER_URL = `${location.origin}/manager/`;

    let overlay = null;

    function buildOverlay() {
        overlay = document.createElement("div");
        overlay.className = "cd-webmanager-overlay";

        const modal = document.createElement("div");
        modal.className = "cd-webmanager-modal";

        const close = document.createElement("button");
        close.type = "button";
        close.className = "cd-webmanager-close";
        close.textContent = "✕"; // ✕
        close.title = "닫기";
        close.addEventListener("click", () => hide());

        const iframe = document.createElement("iframe");
        iframe.src = MANAGER_URL;
        iframe.title = "webmanager";

        modal.appendChild(close);
        modal.appendChild(iframe);
        overlay.appendChild(modal);

        // Backdrop click closes, click inside the modal itself must not.
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) hide();
        });

        document.body.appendChild(overlay);
    }

    function isOpen() {
        return !!overlay && overlay.classList.contains("cd-webmanager-open");
    }

    function show() {
        if (!overlay) buildOverlay();
        overlay.classList.add("cd-webmanager-open");
    }

    function hide() {
        if (overlay) overlay.classList.remove("cd-webmanager-open");
    }

    function toggle() {
        if (isOpen()) hide();
        else show();
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen()) hide();
    });

    function bind(icon) {
        if (icon.dataset.cdWebmanagerBound) return;
        icon.dataset.cdWebmanagerBound = "1";
        icon.classList.add("cd-webmanager-launcher");
        icon.title = "웹매니저 열기";
        icon.addEventListener("click", toggle);
    }

    // .window-appicon is part of the workbench titlebar and rendered once
    // early in boot, but the exact timing relative to this script's
    // injection isn't guaranteed - poll for it the same way
    // tailscale-notify.default.js polls for window.CDDialog.
    function start() {
        const icon = document.querySelector(".window-appicon");
        if (!icon) {
            setTimeout(start, 200);
            return;
        }
        bind(icon);
    }
    start();
})();
