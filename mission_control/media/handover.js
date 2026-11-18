// Tracks a Satellite's own page hands to the audio host (the UI contract's play action with
// `tracks` or `route`, 1.2): which of them can be played, and how they join the queue. Kept
// apart from host.js, which draws, so the rule is tested on its own.

/** The tracks of a handed-over list that can be played: objects with an id, not missing. */
export function playable(tracks) {
    return (Array.isArray(tracks) ? tracks : [])
        .filter((track) => track && typeof track === "object" && typeof track.id === "string" && track.id && !track.missing);
}

/** Plays `tracks` on `player` as the action asks: `queue` ("next" or "end") adds them, `shuffle`
 * shuffles them, otherwise they replace the queue from `start` (an id; the first track when
 * absent or not in the list). `context` is cut to 80 characters. Resolves with how many tracks
 * were taken. */
export async function handOver(player, tracks, options = {}) {
    const list = playable(tracks);
    if (!list.length) {
        return 0;
    }
    const context = typeof options.context === "string" && options.context ? options.context.slice(0, 80) : null;
    if (options.queue === "next") {
        await player.playNext(list);
    } else if (options.queue === "end") {
        await player.addToQueue(list);
    } else if (options.shuffle) {
        await player.shufflePlay(list, context);
    } else {
        const at = options.start == null ? -1 : list.findIndex((track) => track.id === String(options.start));
        await player.play(list, Math.max(0, at), context);
    }
    return list.length;
}
