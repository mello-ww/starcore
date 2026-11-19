// A row's menu (UI contract 1.2 `menu`): a small floating list of actions beside the row's More
// button, or where the row was right-clicked. One open at a time; arrow keys move, Enter runs,
// Escape, Tab or a click elsewhere closes it and focus goes back where it was.

let open = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = String(text);
    }
    return node;
}

export function closeMenu() {
    if (!open) {
        return;
    }
    const { menu, back, cleanup } = open;
    open = null;
    cleanup();
    menu.remove();
    if (back && back.isConnected && typeof back.focus === "function") {
        back.focus({ preventScroll: true });
    }
}

/**
 * entries: [{label, glyph (an element or null), danger, run()}]. `at`: the element the menu
 * opens beside, or {x, y} in the viewport. `back`: where focus returns.
 */
export function openMenu(entries, at, { back = null, label = "Actions" } = {}) {
    closeMenu();
    if (!entries.length) {
        return;
    }
    const menu = el("div", "ui-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    const items = entries.map((entry) => {
        const item = el("button", `ui-menu-item${entry.danger ? " is-danger" : ""}`);
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        const holder = el("span", "ui-menu-icon");
        if (entry.glyph) {
            holder.appendChild(entry.glyph);
        }
        item.append(holder, el("span", "ui-menu-label", entry.label));
        item.addEventListener("click", (event) => {
            event.stopPropagation();
            closeMenu();
            entry.run();
        });
        menu.appendChild(item);
        return item;
    });
    document.body.appendChild(menu);

    // beside the anchor (or the pointer), kept inside the viewport
    const box = menu.getBoundingClientRect();
    let x;
    let y;
    if (at && typeof at.getBoundingClientRect === "function") {
        const rect = at.getBoundingClientRect();
        x = rect.right - box.width;
        y = rect.bottom + 4;
        if (y + box.height > window.innerHeight - 8) {
            y = rect.top - box.height - 4;
        }
    } else {
        x = (at && at.x) || 0;
        y = (at && at.y) || 0;
    }
    x = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;

    const move = (step) => {
        const index = items.indexOf(document.activeElement);
        const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
        items[next].focus();
    };
    const onKey = (event) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
        } else if (event.key === "Home") {
            event.preventDefault();
            items[0].focus();
        } else if (event.key === "End") {
            event.preventDefault();
            items[items.length - 1].focus();
        } else if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            closeMenu();
        }
    };
    const onPointer = (event) => {
        if (!menu.contains(event.target)) {
            closeMenu();
        }
    };
    const onAway = () => closeMenu();
    menu.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("hashchange", onAway);
    document.addEventListener("scroll", onAway, { capture: true, passive: true });
    open = {
        menu,
        back,
        cleanup: () => {
            document.removeEventListener("pointerdown", onPointer, true);
            window.removeEventListener("resize", onAway);
            window.removeEventListener("hashchange", onAway);
            document.removeEventListener("scroll", onAway, { capture: true });
        },
    };
    items[0].focus({ preventScroll: true });
}
