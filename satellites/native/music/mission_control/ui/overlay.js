import * as store from "../store.js";
import { button, el, iconButton } from "./dom.js";
import { register } from "../theme.js";

let openMenu = null;

function closeMenu() {
    if (openMenu) {
        openMenu.remove();
        openMenu = null;
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", escape, true);
    }
}

function outside(event) {
    if (openMenu && !openMenu.contains(event.target)) {
        closeMenu();
    }
}

function escape(event) {
    if (event.key === "Escape") {
        closeMenu();
    }
}

// items: [{label, action, danger, disabled}] or "-" for a separator
export function menu(items, anchor) {
    closeMenu();
    const node = el("div", "mu-menu");
    node.setAttribute("role", "menu");
    register(node);
    for (const item of items) {
        if (item === "-") {
            node.appendChild(el("div", "mu-menu-separator"));
            continue;
        }
        if (!item) {
            continue;
        }
        const entry = button(item.label, `mu-menu-item${item.danger ? " danger" : ""}`, () => {
            closeMenu();
            item.action();
        });
        entry.setAttribute("role", "menuitem");
        entry.disabled = Boolean(item.disabled);
        node.appendChild(entry);
    }
    document.body.appendChild(node);
    let x;
    let y;
    if (anchor instanceof MouseEvent && anchor.type === "contextmenu") {
        x = anchor.clientX;
        y = anchor.clientY;
    } else {
        const target = anchor && anchor.currentTarget ? anchor.currentTarget : anchor;
        const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 100, bottom: 100 };
        x = rect.left;
        y = rect.bottom + 4;
    }
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    node.style.top = `${Math.max(8, y + height > window.innerHeight - 8 ? y - height - 8 : y)}px`;
    openMenu = node;
    setTimeout(() => {
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", escape, true);
        const first = node.querySelector("button:not([disabled])");
        if (first) {
            first.focus();
        }
    });
    node.addEventListener("keydown", (event) => {
        const entries = [...node.querySelectorAll("button:not([disabled])")];
        const index = entries.indexOf(document.activeElement);
        if (event.key === "ArrowDown") {
            event.preventDefault();
            entries[(index + 1) % entries.length].focus();
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            entries[(index - 1 + entries.length) % entries.length].focus();
        }
    });
}

export function modal(title, body, actions = []) {
    closeMenu();
    const backdrop = el("div", "mu-modal-backdrop");
    const dialog = el("div", "mu-modal");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", title);
    register(backdrop);
    const head = el("div", "mu-modal-head");
    const close = () => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        if (previous && previous.focus) {
            previous.focus();
        }
    };
    const onKey = (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            close();
        }
    };
    const previous = document.activeElement;
    head.append(el("h3", null, title), iconButton("close", "Close", close));
    const foot = el("div", "mu-modal-foot");
    for (const action of actions) {
        foot.appendChild(button(action.label, action.primary ? "button button-primary" : action.danger ? "button button-stop" : "button", async () => {
            const result = await action.action();
            if (result !== false) {
                close();
            }
        }));
    }
    dialog.append(head, body, foot);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) {
            close();
        }
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    const focusable = dialog.querySelector("input, select, textarea, button:not(.mu-icon-button)");
    if (focusable) {
        focusable.focus();
    }
    return { close, dialog };
}

export function prompt(title, label, value = "") {
    return new Promise((resolve) => {
        const body = el("label", "mu-field");
        const input = el("input", "mu-input");
        input.value = value;
        body.append(el("span", null, label), input);
        let done = false;
        const handle = modal(title, body, [
            { label: "Cancel", action: () => { done = true; resolve(null); } },
            { label: "Save", primary: true, action: () => { done = true; resolve(input.value.trim() || null); } },
        ]);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                done = true;
                resolve(input.value.trim() || null);
                handle.close();
            }
        });
        const observer = new MutationObserver(() => {
            if (!handle.dialog.isConnected) {
                observer.disconnect();
                if (!done) {
                    resolve(null);
                }
            }
        });
        observer.observe(document.body, { childList: true });
    });
}

export function confirm(title, message, label = "Delete") {
    return new Promise((resolve) => {
        modal(title, el("p", "mu-modal-text", message), [
            { label: "Cancel", action: () => resolve(false) },
            { label, danger: true, action: () => resolve(true) },
        ]);
    });
}

let toastHost = null;

function toastLayer() {
    if (!toastHost || !toastHost.isConnected) {
        toastHost = el("div", "mu-toasts");
        toastHost.setAttribute("role", "status");
        toastHost.setAttribute("aria-live", "polite");
        register(toastHost);
        document.body.appendChild(toastHost);
    }
    return toastHost;
}

store.on("toast", ({ message, kind }) => {
    const node = el("div", `mu-toast mu-toast-${kind}`, message);
    toastLayer().appendChild(node);
    setTimeout(() => node.classList.add("leaving"), 3600);
    setTimeout(() => node.remove(), 4000);
});
