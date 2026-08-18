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
    /* .titlebar-drag-region overlays the whole titlebar with
       -webkit-app-region:drag (workbench.css) - every other clickable
       titlebar widget (menubar, command-center, window-controls) opts back
       out with no-drag, but .window-appicon never needed to until this
       script made it clickable. Without this, clicks here move the window
       instead of firing, in installed-PWA/window-controls-overlay mode. */
    app-region: no-drag;
    -webkit-app-region: no-drag;
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
    opacity: 0;
    transition: opacity .15s ease;
}
/* .cd-webmanager-visible flips display (needed since opacity alone doesn't
   stop a hidden overlay from blocking clicks/being focusable) a frame before
   .cd-webmanager-open starts the opacity transition on show, and is removed
   only after the fade-out transition finishes on hide (see hide() below) -
   without that delay, display:none would cut the fade-out short instead of
   letting it animate. */
.cd-webmanager-overlay.cd-webmanager-visible {
    display: flex;
}
.cd-webmanager-overlay.cd-webmanager-open {
    opacity: 1;
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
    flex-direction: column;
}
.cd-webmanager-modal.cd-webmanager-modal-maximized {
    width: 100vw;
    height: 100dvh;
    border-radius: 0;
}
/* A dedicated header strip, not an absolutely-positioned button floating on
   top of the iframe - webmanager's own tabs (e.g. Terminal's settings
   button) can render their own controls anywhere in the top-right corner of
   their content, and an overlaid close button collided with them there.
   Reserving real layout space here means it can never overlap anything the
   iframe renders, no matter what that tab puts where. */
.cd-webmanager-modal-header {
    flex: none;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 6px;
    background: #1e1e1e;
}
.cd-webmanager-modal iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #1e1e1e;
}
.cd-webmanager-close,
.cd-webmanager-maximize {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 4px;
    background: rgba(255, 255, 255, .08);
    color: #f9fafb;
    font: 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
    transition: background .15s ease;
}
.cd-webmanager-close {
    font-size: 16px;
}
.cd-webmanager-close:hover,
.cd-webmanager-maximize:hover {
    background: rgba(255, 255, 255, .2);
}
.cd-webmanager-maximize.cd-webmanager-maximize-active {
    background: rgba(255, 255, 255, .22);
}
`;
        document.head.appendChild(style);
    }

    const MANAGER_URL = `${location.origin}/manager/`;
    const MAXIMIZE_STORAGE_KEY = "cd-webmanager-maximized";

    let overlay = null;
    // Read once at load, same as router-auth-notify.default.js/
    // tailscale-notify.default.js's own localStorage dismiss-flags - a
    // fresh page load re-reads it, a live toggle only needs to update this
    // plus the DOM (see toggleMaximize()).
    let maximized = localStorage.getItem(MAXIMIZE_STORAGE_KEY) === "1";

    function applyMaximized() {
        if (!overlay) return;
        overlay
            .querySelector(".cd-webmanager-modal")
            ?.classList.toggle("cd-webmanager-modal-maximized", maximized);
        const btn = overlay.querySelector(".cd-webmanager-maximize");
        if (btn) {
            btn.classList.toggle("cd-webmanager-maximize-active", maximized);
            btn.title = maximized ? "원래 크기로" : "최대화";
        }
    }

    function toggleMaximize() {
        maximized = !maximized;
        localStorage.setItem(MAXIMIZE_STORAGE_KEY, maximized ? "1" : "0");
        applyMaximized();
    }

    function buildOverlay() {
        overlay = document.createElement("div");
        overlay.className = "cd-webmanager-overlay";

        const modal = document.createElement("div");
        modal.className = "cd-webmanager-modal";

        const header = document.createElement("div");
        header.className = "cd-webmanager-modal-header";

        const maximize = document.createElement("button");
        maximize.type = "button";
        maximize.className = "cd-webmanager-maximize";
        maximize.textContent = "⛶";
        maximize.addEventListener("click", () => toggleMaximize());

        const close = document.createElement("button");
        close.type = "button";
        close.className = "cd-webmanager-close";
        close.textContent = "✕"; // ✕
        close.title = "닫기";
        close.addEventListener("click", () => hide());

        const iframe = document.createElement("iframe");
        iframe.src = MANAGER_URL;
        iframe.title = "webmanager";

        header.appendChild(maximize);
        header.appendChild(close);
        modal.appendChild(header);
        modal.appendChild(iframe);
        overlay.appendChild(modal);

        // Backdrop click closes, click inside the modal itself must not.
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) hide();
        });

        document.body.appendChild(overlay);
        applyMaximized();
    }

    let hideTimer = null;

    function isOpen() {
        return !!overlay && overlay.classList.contains("cd-webmanager-open");
    }

    function show() {
        if (!overlay) buildOverlay();
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        overlay.classList.add("cd-webmanager-visible");
        // Adding cd-webmanager-open in the same tick as cd-webmanager-visible
        // wouldn't transition (the browser coalesces both style changes into
        // one paint) - a rAF forces the "display:flex, opacity:0" state to
        // actually paint first, so the following opacity:1 is a real
        // transition rather than an instant jump.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                overlay.classList.add("cd-webmanager-open");
            });
        });
    }

    function hide() {
        if (!overlay) return;
        overlay.classList.remove("cd-webmanager-open");
        if (hideTimer) clearTimeout(hideTimer);
        // Fallback timeout (not just transitionend) in case the transition
        // never fires - e.g. the tab was backgrounded (rAF/transitions can
        // be throttled) or a future edit changes the CSS transition
        // duration without updating this value.
        hideTimer = setTimeout(() => {
            overlay.classList.remove("cd-webmanager-visible");
            hideTimer = null;
        }, 200);
    }

    function toggle() {
        if (isOpen()) hide();
        else show();
    }

    function openInNewTab() {
        window.open(MANAGER_URL, "_blank", "noopener");
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen()) hide();
    });

    // Escape pressed *inside* the iframe never reaches the listener above -
    // keydown doesn't bubble across an iframe boundary, even same-origin -
    // so webmanager's own frontend (src/utils/embedEscape.ts) asks for a
    // close this way instead, once it's confirmed none of its own dialogs
    // are open to consume Escape themselves first.
    window.addEventListener("message", (e) => {
        if (e.origin !== location.origin) return;
        if (e.source !== overlay?.querySelector("iframe")?.contentWindow) return;
        if (e.data?.type === "cd-webmanager-close-request" && isOpen()) hide();
    });

    function bind(icon) {
        if (icon.dataset.cdWebmanagerBound) return;
        icon.dataset.cdWebmanagerBound = "1";
        icon.classList.add("cd-webmanager-launcher");
        icon.title = "웹매니저 열기 (휠클릭/Ctrl+클릭: 새 탭)";
        // .window-appicon is a plain <div>, not a real link, so middle-click
        // and Ctrl/Cmd+click have no native "open in new tab" behavior to
        // fall back on - handle both explicitly instead of only the plain
        // left-click overlay-toggle path.
        icon.addEventListener("click", (e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                openInNewTab();
                return;
            }
            toggle();
        });
        icon.addEventListener("auxclick", (e) => {
            if (e.button === 1) openInNewTab();
        });
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
