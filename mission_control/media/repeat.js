// What the repeat button moves to next. A radio (a context starting with "radio:") never runs
// out, so repeating all of it means nothing: there it moves between off and one only. The
// Android app has the same rule in mobile/src/media/queue.ts.

const CYCLE = { off: "all", all: "one", one: "off" };
const ENDLESS = { off: "one", all: "off", one: "off" };

export function isEndless(context) {
    return typeof context === "string" && context.startsWith("radio:");
}

export function nextRepeat(mode, context) {
    return (isEndless(context) ? ENDLESS : CYCLE)[mode] || "off";
}
