export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = text;
    }
    return node;
}

export function button(label, className, onClick, title) {
    const node = el("button", className || "button", label);
    node.type = "button";
    if (title) {
        node.title = title;
        node.setAttribute("aria-label", title);
    }
    if (onClick) {
        node.addEventListener("click", (event) => {
            event.stopPropagation();
            onClick(event);
        });
    }
    return node;
}

const ICONS = {
    play: "M7 4.5v15l12-7.5z",
    pause: "M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z",
    next: "M5 5l10 7-10 7zM17 5h2.5v14H17z",
    previous: "M19 5L9 12l10 7zM4.5 5H7v14H4.5z",
    shuffle: "M4 7h3.5l9 10H20M4 17h3.5l2.6-2.9M14 9.9 16.5 7H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5",
    repeat: "M5 11V9a2 2 0 0 1 2-2h11M15.5 4.5 18 7l-2.5 2.5M19 13v2a2 2 0 0 1-2 2H6M8.5 19.5 6 17l2.5-2.5",
    heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
    queue: "M4 6h12M4 11h12M4 16h7M16 14v6l5-3z",
    lyrics: "M5 5h14v10H9l-4 4z",
    devices: "M3 5h13v9H3zM6.5 18h6M19 8h2v11h-2z",
    volume: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
    mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
    expand: "M5 14v5h5M19 10V5h-5M5 19l6-6M19 5l-6 6",
    collapse: "M10 19v-5H5M14 5v5h5M4 20l6-6M20 4l-6 6",
    retract: "M6 9.5l6 6 6-6",
    more: "M6 12h.01M12 12h.01M18 12h.01",
    search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20",
    home: "M4 11 12 4l8 7v9h-5v-6H9v6H4z",
    library: "M5 4v16M10 4v16M15 4l4.5 15.5",
    stats: "M5 19V11M10 19V5M15 19v-6M20 19V8",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6 6 18",
    timer: "M12 8v5l3 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM9.5 2.5h5",
    info: "M12 11v6M12 7.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    radio: "M5 9h14v10H5zM8 5.5l8-2.5M9 14a2 2 0 1 0 4 0 2 2 0 0 0-4 0",
    pin: "M9 4h6l-1 5 3 3H7l3-3zM12 12v8",
    drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
};

export function icon(name, size = 18) {
    if (name === "settings") {
        // StarCore's one Settings gear (.sc-gear in Mission Control's core.css)
        const gear = el("i", "sc-gear mu-icon");
        gear.setAttribute("aria-hidden", "true");
        gear.style.width = `${size}px`;
        gear.style.height = `${size}px`;
        return gear;
    }
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("mu-icon");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name] || ICONS.info);
    if (name === "play" || name === "pause" || name === "next" || name === "previous") {
        path.setAttribute("fill", "currentColor");
    } else {
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.7");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
    return svg;
}

export function iconButton(name, title, onClick, className = "mu-icon-button") {
    const node = button(null, className, onClick, title);
    node.appendChild(icon(name));
    return node;
}

export function duration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function longDuration(seconds) {
    const total = Math.round((Number(seconds) || 0) / 60);
    if (total >= 60) {
        return `${Math.floor(total / 60)} h ${total % 60} min`;
    }
    return `${total} min`;
}

export function size(bytes) {
    let value = Number(bytes) || 0;
    for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
        if (value < 1024 || unit === "TB") {
            return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`;
        }
        value /= 1024;
    }
    return "";
}

export function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

export function skeletonRows(count, className = "mu-skeleton-row") {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
        fragment.appendChild(el("div", `mu-skeleton ${className}`));
    }
    return fragment;
}

export function emptyState(title, detail, action) {
    const node = el("div", "mu-empty");
    node.append(el("h3", null, title));
    if (detail) {
        node.append(el("p", null, detail));
    }
    if (action) {
        node.append(action);
    }
    return node;
}

export function errorState(error, retry) {
    const node = el("div", "mu-empty mu-error");
    node.append(el("h3", null, "Something went wrong"), el("p", null, error && error.message ? error.message : String(error)));
    if (retry) {
        node.append(button("Try again", "button", retry));
    }
    return node;
}

export function isTyping(event) {
    const target = event.target;
    if (!target || !target.tagName) {
        return false;
    }
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function slug(text) {
    return String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "x";
}
