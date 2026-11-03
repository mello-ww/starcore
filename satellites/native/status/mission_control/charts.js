// Small, dependency-free SVG charts for the Status page.
//
// Line charts: 2px lines, a 10% accent wash under the first series, hairline
// solid gridlines, a crosshair that snaps to the nearest sample and one tooltip
// listing every series, keyboard stepping with the arrow keys, and gaps where
// no samples exist (StarCore was off) instead of a line drawn across them.
// The first series takes the accent; a second takes --sc-chart-2 and no wash.

import { DASH } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";
const PAD = { top: 10, right: 10, bottom: 24, left: 56 };

function svg(tag, attributes = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, value);
    }
    return node;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined && text !== null) {
        node.textContent = text;
    }
    return node;
}

/** A round upper bound for an axis, in the steps its unit reads naturally in. */
export function niceMaximum(value, scale) {
    if (scale === "percent") {
        return 100;
    }
    const steps = [1, 2, 5, 10];  // so the halfway gridline is round too
    const nice = (number, base) => {
        if (!(number > 0)) {
            return base === 1024 ? 1024 : 1;
        }
        let unit = 1;
        if (base === 1024) {
            while (number / unit >= 1024) {
                unit *= 1024;
            }
        }
        const scaled = number / unit;
        const magnitude = 10 ** Math.floor(Math.log10(scaled));
        const step = steps.find((candidate) => candidate * magnitude >= scaled) ?? 10;
        return step * magnitude * unit;
    };
    if (scale === "bytes") {
        return nice(value, 1024);
    }
    if (scale === "bits") {
        return nice(value * 8, 1000) / 8;
    }
    return nice(value, 10);
}

/** Splits points into runs, breaking wherever samples are missing. */
export function segments(points, resolution) {
    const runs = [];
    let current = [];
    for (const point of points) {
        const previous = current[current.length - 1];
        if (previous && point[0] - previous[0] > resolution * 2.5) {
            runs.push(current);
            current = [];
        }
        current.push(point);
    }
    if (current.length) {
        runs.push(current);
    }
    return runs;
}

export function createChart({ height = 168, label = "Chart" } = {}) {
    const root = el("figure", "status-chart");
    const head = el("figcaption", "status-chart-head");
    const plot = el("div", "status-chart-plot");
    const canvas = svg("svg", { class: "status-chart-svg", role: "img" });
    const tooltip = el("div", "status-tooltip");
    tooltip.hidden = true;
    plot.append(canvas, tooltip);
    root.append(head, plot);

    let model = null;
    let index = null;   // the hovered sample, as an index into the base timeline
    let geometry = null;

    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => draw()) : null;
    if (observer) {
        observer.observe(plot);
    }

    function render(next) {
        model = next;
        draw();
    }

    function draw() {
        if (!model) {
            return;
        }
        const focused = canvas.contains(document.activeElement);
        const width = Math.max(plot.clientWidth || 0, 240);
        const total = height + PAD.bottom;
        canvas.setAttribute("viewBox", `0 0 ${width} ${total}`);
        canvas.setAttribute("width", String(width));
        canvas.setAttribute("height", String(total));
        canvas.setAttribute("aria-label", `${model.title || label}: ${summary()}`);
        canvas.replaceChildren();
        renderHead();

        const series = model.series.filter((line) => line.points.length);
        const span = Math.max(model.to - model.from, 1);
        const innerWidth = width - PAD.left - PAD.right;
        const innerHeight = height - PAD.top;
        // scaled to what is drawn - the averages; a brief peak would flatten them,
        // and every peak is still in the tooltip and the table
        const highest = Math.max(0, ...series.flatMap((line) => line.points.map((point) => point[1])));
        const maximum = model.max ?? niceMaximum(highest * 1.08, model.scale);
        const x = (time) => PAD.left + ((time - model.from) / span) * innerWidth;
        const y = (value) => PAD.top + (1 - Math.min(value, maximum) / maximum) * innerHeight;
        geometry = { x, y, width, innerWidth, span };

        // gridlines and y labels: 0, half and the top - recessive hairlines
        for (const fraction of [0, 0.5, 1]) {
            const value = maximum * fraction;
            const position = y(value);
            canvas.appendChild(svg("line", { class: "status-grid", x1: PAD.left, x2: width - PAD.right,
                y1: position, y2: position }));
            const text = svg("text", { class: "status-axis", x: PAD.left - 8, y: position + 4, "text-anchor": "end" });
            text.textContent = (model.tickFormat || model.format)(value);
            canvas.appendChild(text);
        }

        // time labels, spaced to the width available
        const ticks = Math.max(2, Math.min(6, Math.floor(innerWidth / 110)));
        for (let step = 0; step <= ticks; step += 1) {
            const time = model.from + (span * step) / ticks;
            const anchor = step === 0 ? "start" : step === ticks ? "end" : "middle";
            const text = svg("text", { class: "status-axis", x: x(time), y: height + 16, "text-anchor": anchor });
            text.textContent = model.tick(time);
            canvas.appendChild(text);
        }

        if (!series.length) {
            const empty = svg("text", { class: "status-chart-empty", x: PAD.left + innerWidth / 2,
                y: PAD.top + innerHeight / 2, "text-anchor": "middle" });
            empty.textContent = model.empty || "No samples in this period yet";
            canvas.appendChild(empty);
            tooltip.hidden = true;
            return;
        }

        const baseline = y(0);
        model.series.forEach((line, position) => {
            const tone = position === 0 ? "accent" : "second";
            for (const run of segments(line.points, model.resolution)) {
                if (run.length === 1) {
                    canvas.appendChild(svg("circle", { class: `status-point status-${tone}`,
                        cx: x(run[0][0]), cy: y(run[0][1]), r: 2.5 }));
                    continue;
                }
                const path = run.map((point, at) => `${at ? "L" : "M"}${x(point[0]).toFixed(1)} ${y(point[1]).toFixed(1)}`)
                    .join(" ");
                if (position === 0) {
                    const first = x(run[0][0]).toFixed(1);
                    const last = x(run[run.length - 1][0]).toFixed(1);
                    canvas.appendChild(svg("path", { class: "status-area",
                        d: `${path} L${last} ${baseline} L${first} ${baseline} Z` }));
                }
                canvas.appendChild(svg("path", { class: `status-line status-${tone}`, d: path }));
            }
        });

        const crosshair = svg("line", { class: "status-crosshair", y1: PAD.top, y2: height, visibility: "hidden" });
        canvas.appendChild(crosshair);
        const markers = model.series.map((_, position) => {
            const marker = svg("circle", { class: `status-marker status-${position === 0 ? "accent" : "second"}`,
                r: 4, visibility: "hidden" });
            canvas.appendChild(marker);
            return marker;
        });
        const overlay = svg("rect", { class: "status-overlay", x: PAD.left, y: 0, width: innerWidth,
            height, tabindex: "0", "aria-label": `${model.title || label}: use the arrow keys to read values` });
        canvas.appendChild(overlay);
        geometry.crosshair = crosshair;
        geometry.markers = markers;
        if (focused) {
            overlay.focus({ preventScroll: true });  // a refresh must not drop keyboard focus
        }

        overlay.addEventListener("pointermove", (event) => {
            const box = canvas.getBoundingClientRect();
            const scale = box.width ? width / box.width : 1;
            const time = model.from + (((event.clientX - box.left) * scale - PAD.left) / innerWidth) * span;
            index = nearest(timeline(), time);
            showHover();
        });
        overlay.addEventListener("pointerleave", hideHover);
        overlay.addEventListener("blur", hideHover);
        overlay.addEventListener("keydown", (event) => {
            const times = timeline();
            if (!times.length) {
                return;
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const move = event.key === "ArrowLeft" ? -1 : 1;
                index = index === null ? times.length - 1 : Math.max(0, Math.min(times.length - 1, index + move));
                showHover();
            } else if (event.key === "Escape") {
                hideHover();
            }
        });
        if (index !== null) {
            showHover();  // keep the reader's place across a refresh
        }
    }

    function timeline() {
        const longest = model.series.reduce((best, line) => (line.points.length > best.length ? line.points : best), []);
        return longest.map((point) => point[0]);
    }

    function nearest(times, time) {
        if (!times.length) {
            return null;
        }
        let low = 0;
        let high = times.length - 1;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (times[middle] < time) {
                low = middle;
            } else {
                high = middle;
            }
        }
        return Math.abs(times[low] - time) <= Math.abs(times[high] - time) ? low : high;
    }

    function showHover() {
        const times = timeline();
        if (index === null || !times.length || !geometry || !geometry.crosshair) {
            return;
        }
        index = Math.min(index, times.length - 1);
        const time = times[index];
        const position = geometry.x(time);
        geometry.crosshair.setAttribute("x1", position);
        geometry.crosshair.setAttribute("x2", position);
        geometry.crosshair.setAttribute("visibility", "visible");

        tooltip.replaceChildren(el("p", "status-tooltip-time", model.moment(time)));
        model.series.forEach((line, at) => {
            const point = line.points.find((candidate) => candidate[0] === time);
            const marker = geometry.markers[at];
            if (point) {
                marker.setAttribute("cx", position);
                marker.setAttribute("cy", geometry.y(point[1]));
                marker.setAttribute("visibility", "visible");
            } else {
                marker.setAttribute("visibility", "hidden");
            }
            const row = el("p", "status-tooltip-row");
            const key = el("i", `status-key status-${at === 0 ? "accent" : "second"}`);
            key.setAttribute("aria-hidden", "true");
            const value = el("strong", null, point ? model.format(point[1]) : DASH);
            row.append(key, value, el("span", null, line.label));
            if (point && point[2] !== undefined && model.showPeak !== false && point[2] > point[1]) {
                row.appendChild(el("small", null, `peak ${model.format(point[2])}`));
            }
            tooltip.appendChild(row);
        });
        tooltip.hidden = false;
        const flip = position > geometry.width * 0.62;
        tooltip.style.left = flip ? "" : `${position + 12}px`;
        tooltip.style.right = flip ? `${geometry.width - position + 12}px` : "";
    }

    function hideHover() {
        index = null;
        tooltip.hidden = true;
        if (geometry && geometry.crosshair) {
            geometry.crosshair.setAttribute("visibility", "hidden");
            geometry.markers.forEach((marker) => marker.setAttribute("visibility", "hidden"));
        }
    }

    function latest(line) {
        const point = line.points[line.points.length - 1];
        return point ? model.format(point[1]) : DASH;
    }

    function summary() {
        return model.series.map((line) => `${line.label} ${latest(line)}`).join(", ");
    }

    function renderHead() {
        const title = el("span", "status-chart-title", model.title || label);
        const legend = el("span", "status-legend");
        model.series.forEach((line, at) => {
            const item = el("span", "status-legend-item");
            const key = el("i", `status-key status-${at === 0 ? "accent" : "second"}`);
            key.setAttribute("aria-hidden", "true");
            // one series needs no key: the title already names it
            if (model.series.length > 1) {
                item.append(key, el("span", null, line.label));
            }
            item.appendChild(el("strong", null, latest(line)));
            legend.appendChild(item);
        });
        head.replaceChildren(title, legend);
    }

    return {
        element: root,
        render,
        destroy() {
            if (observer) {
                observer.disconnect();
            }
        },
    };
}

/** A tiny trend line for a stat tile: muted line, the latest point in the accent. */
export function sparkline(values, { width = 112, height = 30 } = {}) {
    const known = values.filter((value) => value !== null && value !== undefined);
    const node = svg("svg", { class: "status-spark", viewBox: `0 0 ${width} ${height}`, width, height,
        "aria-hidden": "true" });
    if (known.length < 2) {
        return node;
    }
    const low = Math.min(...known);
    const high = Math.max(...known);
    const range = high - low || 1;
    const step = width / (known.length - 1);
    const points = known.map((value, at) => [at * step, height - 3 - ((value - low) / range) * (height - 6)]);
    node.appendChild(svg("polyline", { class: "status-spark-line",
        points: points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ") }));
    const [lastX, lastY] = points[points.length - 1];
    node.appendChild(svg("circle", { class: "status-spark-dot", cx: Math.min(lastX, width - 4), cy: lastY, r: 3 }));
    return node;
}

/** A horizontal meter whose fill carries severity: accent, then warning, then danger. */
export function meter(value, { warn = 90, critical = 97, label = "" } = {}) {
    const node = el("div", "status-meter");
    node.setAttribute("role", "meter");
    node.setAttribute("aria-valuemin", "0");
    node.setAttribute("aria-valuemax", "100");
    if (label) {
        node.setAttribute("aria-label", label);
    }
    const fill = el("span", "status-meter-fill");
    if (value === null || value === undefined) {
        node.classList.add("unknown");
        node.setAttribute("aria-valuetext", "unavailable");
    } else {
        const clamped = Math.max(0, Math.min(100, value));
        fill.style.width = `${clamped}%`;
        node.setAttribute("aria-valuenow", String(Math.round(clamped)));
        if (value >= critical) {
            node.classList.add("critical");
        } else if (value >= warn) {
            node.classList.add("warning");
        }
    }
    node.appendChild(fill);
    return node;
}
