// Which shortcut a key press asks for, kept free of the page so it can be tested alone
// (mission_control/tests/media.test.mjs). `state`: {typing, blocked, hasTrack, onBody,
// ownPage, fullscreen} - what the page looks like when the key goes down.

/** The shortcut for this key event, or null when the key is left to the page. */
export function shortcut(event, state) {
    if (event.ctrlKey || event.metaKey || event.altKey || state.typing || state.blocked) {
        return null;
    }
    // shortcuts apply wherever the player has something loaded, and on its own page / full player
    if (!state.hasTrack && !state.ownPage && !state.fullscreen) {
        return null;
    }
    const key = event.key;
    if (key === " " && !state.onButton) {
        return "toggle";
    }
    if (event.shiftKey && key === "ArrowRight") {
        return "next";
    }
    if (event.shiftKey && key === "ArrowLeft") {
        return "previous";
    }
    if (key === "ArrowRight" && state.hasTrack && state.onBody) {
        return "forward";
    }
    if (key === "ArrowLeft" && state.hasTrack && state.onBody) {
        return "back";
    }
    if (key === "m" || key === "M") {
        return "mute";
    }
    if ((key === "l" || key === "L") && state.hasTrack) {
        return "like";
    }
    if (key === "q" || key === "Q") {
        return "queue";
    }
    if (key === "/") {
        return "search";
    }
    return null;
}
