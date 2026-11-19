// Tracks a Satellite's own page hands to the audio host (the UI contract's play action with
// `tracks` or `route`, 1.2): which of them can be played, how they join the queue, and how a
// long list a route answers page by page keeps the queue fed. Kept apart from host.js, which
// draws, so the rule is tested on its own; the Android app has the same rule in
// mobile/src/media/handover.ts.

/** When this many queued tracks or fewer are left, the next page is asked for. */
export const LOW_WATER = 25;
/** How many positions a shuffle draws at first, and then each time it runs low. */
export const SHUFFLE_AHEAD = 100;
export const SHUFFLE_REFILL = 50;
/** At most this many positions in one request. */
export const POSITIONS_PER_REQUEST = 50;

/** The tracks of a handed-over list that can be played: objects with an id, not missing. */
export function playable(tracks) {
    return (Array.isArray(tracks) ? tracks : [])
        .filter((track) => track && typeof track === "object" && typeof track.id === "string" && track.id && !track.missing);
}

/** Whether a route's answer is one page of a longer list ({tracks, count, cursor}). */
export function isPaged(answer) {
    if (!answer || typeof answer !== "object" || !Array.isArray(answer.tracks)) {
        return false;
    }
    const more = typeof answer.cursor === "string" && answer.cursor !== "";
    const larger = Number.isInteger(answer.count) && answer.count > answer.tracks.length;
    return more || larger;
}

/** A random order of the positions 0..count-1, drawn a few at a time: a partial Fisher-Yates
 * over the indexes, which only remembers the positions it swapped, so shuffling 10,000 tracks
 * costs what is drawn, not the whole list. */
export function lazyPositions(count, random = Math.random) {
    const swapped = new Map();
    let drawn = 0;
    const at = (index) => (swapped.has(index) ? swapped.get(index) : index);
    return {
        get left() {
            return count - drawn;
        },
        draw(wanted) {
            const out = [];
            while (out.length < wanted && drawn < count) {
                const other = drawn + Math.floor(random() * (count - drawn));
                const picked = at(other);
                swapped.set(other, at(drawn));
                swapped.delete(drawn);
                out.push(picked);
                drawn += 1;
            }
            return out;
        },
    };
}

/** The rest of a paged list, after its first page: `load(params)` GETs the same route with
 * `cursor` (the next page, in order) or `positions` (the tracks at those positions, in that
 * order). With `shuffle` and a `count`, positions are drawn lazily; the first page's tracks are
 * the positions 0 to its length. */
export function pagedSource(first, load, { shuffle = false, random = Math.random } = {}) {
    const known = playable(first.tracks);
    const count = Number.isInteger(first.count) ? first.count : null;
    if (shuffle && count !== null) {
        const positions = lazyPositions(count, random);
        const firstPage = Array.isArray(first.tracks) ? first.tracks : [];
        return {
            shuffled: true,
            get more() {
                return positions.left > 0;
            },
            async take(wanted) {
                const drawn = positions.draw(wanted);
                const found = new Map();
                const missing = [];
                for (const position of drawn) {
                    if (position < firstPage.length) {
                        found.set(position, firstPage[position]);
                    } else {
                        missing.push(position);
                    }
                }
                for (let index = 0; index < missing.length; index += POSITIONS_PER_REQUEST) {
                    const chunk = missing.slice(index, index + POSITIONS_PER_REQUEST);
                    const answer = await load({ positions: chunk.join(",") });
                    const tracks = answer && Array.isArray(answer.tracks) ? answer.tracks : [];
                    chunk.forEach((position, at) => found.set(position, tracks[at]));
                }
                return playable(drawn.map((position) => found.get(position)));
            },
        };
    }
    let cursor = typeof first.cursor === "string" && first.cursor ? first.cursor : null;
    return {
        shuffled: false,
        first: known,
        get more() {
            return cursor !== null;
        },
        async take() {
            if (cursor === null) {
                return [];
            }
            const answer = await load({ cursor });
            cursor = answer && typeof answer.cursor === "string" && answer.cursor ? answer.cursor : null;
            const tracks = playable(answer && answer.tracks);
            return shuffle ? shuffled(tracks, random) : tracks;
        },
    };
}

function shuffled(list, random) {
    const copy = list.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
}

/** Keeps the queue fed from `source` while it is still the one handed over: each time the
 * player changes, when `LOW_WATER` tracks or fewer are left, the next tracks are added at the
 * end. It stops once the queue was replaced (another context, or the first track handed over
 * gone) or the source is spent. `queue` adapts the player: {subscribe(listener) -> unsubscribe,
 * left(), still(), add(tracks)}. Returns the stop function. */
export function follow(queue, source) {
    let busy = false;
    let stopped = false;
    let unsubscribe = () => {};
    const stop = () => {
        stopped = true;
        unsubscribe();
    };
    const check = async () => {
        if (stopped || busy) {
            return;
        }
        if (!source.more || !queue.still()) {
            stop();
            return;
        }
        if (queue.left() > LOW_WATER) {
            return;
        }
        busy = true;
        try {
            const tracks = await source.take(SHUFFLE_REFILL);
            if (!stopped && queue.still() && tracks.length) {
                await queue.add(tracks);
            }
        } catch (error) {
            stop();  // the list ends here; what is queued still plays
        } finally {
            busy = false;
        }
        if (!stopped && !source.more) {
            stop();
        }
    };
    unsubscribe = queue.subscribe(() => { check(); });
    check();
    return stop;
}

let following = null;

function webQueue(player, first) {
    const context = player.context;
    return {
        subscribe(listener) {
            const offs = [player.on("track", listener), player.on("queue", listener)];
            return () => offs.forEach((off) => off());
        },
        left: () => player.queue.length - player.index - 1,
        still: () => player.context === context && player.queue.includes(first),
        add: (tracks) => player.addToQueue(tracks, { quiet: true }),
    };
}

/** Plays `tracks` on `player` as the action asks: `queue` ("next" or "end") adds them, `shuffle`
 * shuffles them, otherwise they replace the queue from `start` (an id; the first track when
 * absent or not in the list). `context` is cut to 80 characters. With `page` (a route's paged
 * answer, and `load` to ask for more), the queue is fed as it plays: in order, or with
 * `shuffle` from positions drawn lazily over the whole list. Resolves with how many tracks
 * were taken at first. */
export async function handOver(player, tracks, options = {}, random = Math.random) {
    const context = typeof options.context === "string" && options.context ? options.context.slice(0, 80) : null;
    const page = options.page && isPaged(options.page.answer) && !options.queue ? options.page : null;
    let source = null;
    let list = playable(tracks);
    if (page) {
        source = pagedSource(page.answer, page.load, { shuffle: options.shuffle === true, random });
        if (source.shuffled) {
            list = await source.take(SHUFFLE_AHEAD);
        }
    }
    if (!list.length) {
        return 0;
    }
    if (following) {
        following();
        following = null;
    }
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
    if (source && source.more && !player.remote) {
        const first = player.queue.find((track) => list.includes(track));
        if (first) {
            following = follow(webQueue(player, first), source);
        }
    }
    return list.length;
}
