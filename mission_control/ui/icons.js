// The shared icon set (contracts/ui/vocabulary.json "icons") drawn as inline
// SVG. Shapes from Feather (https://feathericons.com, MIT licence) - the same
// set the Android app draws through react-native-vector-icons, so a name
// looks the same on both clients.

const SVG = "http://www.w3.org/2000/svg";

const line = (x1, y1, x2, y2) => ["line", { x1, y1, x2, y2 }];
const poly = (points) => ["polyline", { points }];
const path = (d) => ["path", { d }];
const circle = (cx, cy, r) => ["circle", { cx, cy, r }];
const rect = (x, y, width, height, rx) => ["rect", rx ? { x, y, width, height, rx } : { x, y, width, height }];

const SHAPES = {
    activity: [poly("22 12 18 12 15 21 9 3 6 12 2 12")],
    box: [path("M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"),
        poly("3.27 6.96 12 12.01 20.73 6.96"), line(12, 22.08, 12, 12)],
    camera: [path("M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"), circle(12, 13, 4)],
    check: [poly("20 6 9 17 4 12")],
    circle: [circle(12, 12, 10)],
    clock: [circle(12, 12, 10), poly("12 6 12 12 16 14")],
    cpu: [rect(4, 4, 16, 16, 2), rect(9, 9, 6, 6), line(9, 1, 9, 4), line(15, 1, 15, 4), line(9, 20, 9, 23),
        line(15, 20, 15, 23), line(20, 9, 23, 9), line(20, 14, 23, 14), line(1, 9, 4, 9), line(1, 14, 4, 14)],
    file: [path("M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"), poly("13 2 13 9 20 9")],
    "file-text": [path("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"), poly("14 2 14 8 20 8"),
        line(16, 13, 8, 13), line(16, 17, 8, 17), poly("10 9 9 9 8 9")],
    folder: [path("M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z")],
    grid: [rect(3, 3, 7, 7), rect(14, 3, 7, 7), rect(14, 14, 7, 7), rect(3, 14, 7, 7)],
    "hard-drive": [line(22, 12, 2, 12),
        path("M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"),
        line(6, 16, 6.01, 16), line(10, 16, 10.01, 16)],
    home: [path("M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"), poly("9 22 9 12 15 12 15 22")],
    image: [rect(3, 3, 18, 18, 2), circle(8.5, 8.5, 1.5), poly("21 15 16 10 5 21")],
    info: [circle(12, 12, 10), line(12, 16, 12, 12), line(12, 8, 12.01, 8)],
    layers: [["polygon", { points: "12 2 2 7 12 12 22 7 12 2" }], poly("2 17 12 22 22 17"), poly("2 12 12 17 22 12")],
    list: [line(8, 6, 21, 6), line(8, 12, 21, 12), line(8, 18, 21, 18), line(3, 6, 3.01, 6), line(3, 12, 3.01, 12),
        line(3, 18, 3.01, 18)],
    lock: [rect(3, 11, 18, 11, 2), path("M7 11V7a5 5 0 0 1 10 0v4")],
    music: [path("M9 18V5l12-2v13"), circle(6, 18, 3), circle(18, 16, 3)],
    plus: [line(12, 5, 12, 19), line(5, 12, 19, 12)],
    settings: [circle(12, 12, 3), path("M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z")],
    sliders: [line(4, 21, 4, 14), line(4, 10, 4, 3), line(12, 21, 12, 12), line(12, 8, 12, 3), line(20, 21, 20, 16),
        line(20, 12, 20, 3), line(1, 14, 7, 14), line(9, 8, 15, 8), line(17, 16, 23, 16)],
    star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]],
    zap: [["polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" }]],
    // 1.2
    "chevron-left": [poly("15 18 9 12 15 6")],
    "chevron-right": [poly("9 18 15 12 9 6")],
    "edit-2": [path("M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z")],
    heart: [path("M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z")],
    play: [["polygon", { points: "5 3 19 12 5 21 5 3" }]],
    "rotate-ccw": [poly("1 4 1 10 7 10"), path("M3.51 15a9 9 0 1 0 2.13-9.36L1 10")],
    "trash-2": [poly("3 6 5 6 21 6"), path("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
        line(10, 11, 10, 17), line(14, 11, 14, 17)],
    x: [line(18, 6, 6, 18), line(6, 6, 18, 18)],
};

export const ICON_NAMES = Object.keys(SHAPES);

/** An <svg> for a shared icon name, or null for a name outside the set. */
export function icon(name, size = 18) {
    const shapes = SHAPES[name];
    if (!shapes) {
        return null;
    }
    const svg = document.createElementNS(SVG, "svg");
    for (const [attribute, value] of Object.entries({
        viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
        "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) {
        svg.setAttribute(attribute, String(value));
    }
    for (const [tag, attributes] of shapes) {
        const node = document.createElementNS(SVG, tag);
        for (const [attribute, value] of Object.entries(attributes)) {
            node.setAttribute(attribute, String(value));
        }
        svg.appendChild(node);
    }
    return svg;
}
