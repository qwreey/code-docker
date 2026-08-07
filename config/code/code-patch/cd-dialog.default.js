(() => {
    if (window.CDDialog) return;

    const STYLE_ID = "cd-dialog-style";
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.cd-dialog-stack {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 999999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
}
.cd-dialog-card {
    padding: 12px 14px;
    border-radius: 6px;
    background: #1f2937;
    color: #f9fafb;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cd-dialog-card.cd-dialog-success { background: #14532d; }
.cd-dialog-card.cd-dialog-warning { background: #78350f; }
.cd-dialog-title { font-weight: 600; margin-bottom: 4px; }
.cd-dialog-line { word-break: break-all; opacity: .85; margin-top: 2px; }
.cd-dialog-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.cd-dialog-card a, .cd-dialog-card button {
    border: 0;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
}
.cd-dialog-card .cd-dialog-primary { background: #0ea5e9; color: #fff; }
.cd-dialog-card .cd-dialog-secondary { background: transparent; color: #d1d5db; }
`;
        document.head.appendChild(style);
    }

    function stack() {
        let el = document.querySelector(".cd-dialog-stack");
        if (!el) {
            el = document.createElement("div");
            el.className = "cd-dialog-stack";
            document.body.appendChild(el);
        }
        return el;
    }

    const cards = new Map();

    function buildCard(opts, dismissId) {
        const card = document.createElement("div");
        card.className = "cd-dialog-card" + (opts.kind ? ` cd-dialog-${opts.kind}` : "");

        if (opts.title) {
            const title = document.createElement("div");
            title.className = "cd-dialog-title";
            title.textContent = opts.title;
            card.appendChild(title);
        }
        (opts.lines || []).forEach((text) => {
            const line = document.createElement("div");
            line.className = "cd-dialog-line";
            line.textContent = text;
            card.appendChild(line);
        });
        if (opts.body) {
            const body = document.createElement("div");
            body.textContent = opts.body;
            card.appendChild(body);
        }

        const actions = opts.actions || [];
        const showDismiss = dismissId && opts.dismissible !== false;
        if (actions.length || showDismiss) {
            const row = document.createElement("div");
            row.className = "cd-dialog-row";
            actions.forEach((action, i) => {
                const el = action.href ? document.createElement("a") : document.createElement("button");
                el.className = i === 0 ? "cd-dialog-primary" : "cd-dialog-secondary";
                el.textContent = action.label;
                if (action.href) {
                    el.href = action.href;
                    el.target = "_blank";
                    el.rel = "noopener";
                } else {
                    el.type = "button";
                }
                if (action.onClick) el.addEventListener("click", action.onClick);
                row.appendChild(el);
            });
            if (showDismiss) {
                const dismiss = document.createElement("button");
                dismiss.type = "button";
                dismiss.className = "cd-dialog-secondary";
                dismiss.textContent = "Dismiss";
                dismiss.addEventListener("click", () => window.CDDialog.hide(dismissId));
                row.appendChild(dismiss);
            }
            card.appendChild(row);
        }
        return card;
    }

    window.CDDialog = {
        // Persistent card keyed by id - a second call with the same id
        // replaces the previous one in place instead of stacking a duplicate.
        banner(id, opts) {
            this.hide(id);
            const card = buildCard(opts, id);
            cards.set(id, card);
            stack().appendChild(card);
        },
        hide(id) {
            const card = cards.get(id);
            if (card) {
                card.remove();
                cards.delete(id);
            }
        },
        // Unkeyed, self-dismissing card.
        toast(opts) {
            const card = buildCard(opts, null);
            stack().appendChild(card);
            setTimeout(() => card.remove(), opts.duration || 5000);
        },
        // Best-effort native browser notification - silently does nothing
        // unless the user already granted permission (never prompts).
        notify(opts) {
            if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
            const n = new Notification(opts.title, { body: opts.body });
            if (opts.onClick) n.onclick = opts.onClick;
        },
    };
})();
