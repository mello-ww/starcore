// Units used everywhere on the Status page (the Android app uses the same rules):
// capacities in binary units (GiB), disk throughput in bytes per second (MiB/s),
// network throughput in bits per second (Mb/s) to match link speeds.

const BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const BITS = ["b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"];
export const DASH = "—";

function scaled(value, step, units) {
    let index = 0;
    let number = Math.abs(value);
    while (number >= step && index < units.length - 1) {
        number /= step;
        index += 1;
    }
    const digits = index === 0 ? 0 : number >= 100 ? 0 : 1;
    return `${value < 0 ? "-" : ""}${number.toFixed(digits)} ${units[index]}`;
}

export function bytes(value) {
    return value === null || value === undefined ? DASH : scaled(value, 1024, BINARY);
}

export function byteRate(value) {
    return value === null || value === undefined ? DASH : `${bytes(value)}/s`;
}

export function bitRate(bytesPerSecond) {
    return bytesPerSecond === null || bytesPerSecond === undefined ? DASH : scaled(bytesPerSecond * 8, 1000, BITS);
}

export function linkSpeed(mbps) {
    if (!mbps) {
        return DASH;
    }
    return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gb/s` : `${mbps} Mb/s`;
}

export function percent(value) {
    if (value === null || value === undefined) {
        return DASH;
    }
    // one decimal where it matters: small values, and near the 90% thresholds
    return `${value < 10 || (value >= 90 && value < 100) ? value.toFixed(1) : Math.round(value)}%`;
}

export function celsius(value) {
    return value === null || value === undefined ? DASH : `${Math.round(value)} °C`;
}

export function megahertz(value) {
    if (!value) {
        return DASH;
    }
    return value >= 1000 ? `${(value / 1000).toFixed(2)} GHz` : `${Math.round(value)} MHz`;
}

export function duration(seconds) {
    if (seconds === null || seconds === undefined) {
        return DASH;
    }
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) {
        return `${days}d ${hours}h`;
    }
    if (hours) {
        return `${hours}h ${minutes}m`;
    }
    return minutes ? `${minutes}m` : `${total}s`;
}

/** A fixed span in plain words: 10 s, 1 min, 1 hour, 24 hours, 7 days. */
export function span(seconds) {
    if (seconds % 86400 === 0 && seconds >= 2 * 86400) {
        return `${seconds / 86400} days`;
    }
    if (seconds % 3600 === 0) {
        return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
    }
    if (seconds % 60 === 0) {
        return `${seconds / 60} min`;
    }
    return `${seconds} s`;
}

export function count(value) {
    return value === null || value === undefined ? DASH : Number(value).toLocaleString();
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const TIME_SECONDS = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const FULL = new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

/** An axis label for an epoch second, at the detail the period needs. */
export function tick(epoch, period) {
    const date = new Date(epoch * 1000);
    if (period === "7d") {
        return DAY.format(date);
    }
    if (period === "30d") {
        return DATE.format(date);
    }
    return TIME.format(date);
}

/** A tooltip time: precise to the second for the last hour, otherwise to the minute. */
export function moment(epoch, period) {
    const date = new Date(epoch * 1000);
    return period === "1h" ? TIME_SECONDS.format(date) : FULL.format(date);
}

export function clock(epoch) {
    return epoch ? TIME_SECONDS.format(new Date(epoch * 1000)) : DASH;
}

/** How a history series is written: by its unit. */
export function formatterFor(name, unit) {
    if (name === "net_rx" || name === "net_tx") {
        return bitRate;
    }
    if (unit === "B/s") {
        return byteRate;
    }
    if (unit === "%") {
        return percent;
    }
    if (unit === "°C") {
        return celsius;
    }
    return (value) => (value === null || value === undefined ? DASH : value.toFixed(2));
}
