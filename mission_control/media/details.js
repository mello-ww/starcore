// A track's credits and file facts, with how it is being streamed: for the full player's
// Info panel and a provider's own "Credits and file info". Reads only the track and plan.
import { duration, el, size } from "./dom.js";

function row(list, label, value) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
        return;
    }
    list.append(el("dt", null, label), el("dd", null, Array.isArray(value) ? value.join(", ") : String(value)));
}

export function trackDetails(track, plan) {
    const node = el("div", "mu-details");
    const technical = el("dl", "mu-facts");
    row(technical, "Quality", track.quality && track.quality.label);
    row(technical, "Format", `${(track.format || "").toUpperCase()}${track.codec && track.codec !== track.format ? ` (${track.codec})` : ""}`);
    row(technical, "Sample rate", track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)} kHz` : null);
    row(technical, "Bit depth", track.bit_depth ? `${track.bit_depth}-bit` : null);
    row(technical, "Bitrate", track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null);
    row(technical, "Channels", track.channels);
    row(technical, "Duration", duration(track.duration));
    row(technical, "File size", track.size ? size(track.size) : null);
    row(technical, "File", track.folder ? `${track.folder}/${track.filename}` : track.filename);
    if (plan) {
        row(technical, "Streaming as", plan.delivery === "original"
            ? `Original file${plan.reason ? ` (${plan.reason})` : ""}`
            : `Transcoded ${plan.codec} ${Math.round(plan.bitrate / 1000)} kbps`);
    }
    const gain = track.replaygain || {};
    row(technical, "ReplayGain", [gain.track_gain !== null && gain.track_gain !== undefined ? `track ${gain.track_gain} dB` : null,
        gain.album_gain !== null && gain.album_gain !== undefined ? `album ${gain.album_gain} dB` : null].filter(Boolean));
    const credits = el("dl", "mu-facts");
    row(credits, "Artists", (track.artists || []).map((artist) => artist.name));
    row(credits, "Album artist", track.album_artist);
    row(credits, "Album", track.album);
    row(credits, "Track", track.track ? `${track.track}${track.track_total ? ` of ${track.track_total}` : ""}${track.disc ? `, disc ${track.disc}` : ""}` : null);
    row(credits, "Released", track.date || track.year);
    row(credits, "Genre", track.genres && track.genres.length ? track.genres : track.genre);
    const extra = track.credits || {};
    row(credits, "Composer", extra.composer);
    row(credits, "Producer", extra.producer);
    row(credits, "Label", extra.label);
    row(credits, "Copyright", extra.copyright);
    row(credits, "ISRC", extra.isrc);
    row(credits, "MusicBrainz", track.musicbrainz && track.musicbrainz.track);
    row(credits, "Added", (track.added_at || "").slice(0, 10));
    node.append(el("h4", null, "Credits"), credits, el("h4", null, "File and quality"), technical);
    return node;
}

