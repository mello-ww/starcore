export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const PRESETS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
    vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
    rock: [4, 3, 2, 0, -1, 0, 2, 3, 4, 4],
    electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
    jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
    acoustic: [4, 4, 3, 1, 1, 1, 2, 3, 3, 2],
    loudness: [5, 3, 0, 0, -1, 0, -1, 0, 3, 5],
    "late night": [-2, -1, 0, 1, 2, 2, 1, 0, -2, -3],
};

const dbToGain = (db) => Math.pow(10, (Number(db) || 0) / 20);

// Created only once something needs processing: until then each <audio> plays directly, and once a
// MediaElementSource exists the browser routes that element through the graph for the rest of the session.
export class Effects {
    constructor() {
        this.context = null;
        this.inputs = new Map();
        this.equalizer = { enabled: false, bands: PRESETS.flat.slice(), preamp: 0 };
        this.bass = 0;
        this.normalize = false;
        this.volume = 1;
        this.analyser = null;
    }

    get active() {
        return this.context !== null;
    }

    get sampleRate() {
        return this.context ? this.context.sampleRate : null;
    }

    ensure(elements) {
        if (!this.context) {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) {
                return false;
            }
            this.context = new Context({ latencyHint: "playback" });
            this.build();
        }
        for (const element of elements) {
            this.input(element);
        }
        return true;
    }

    build() {
        const ctx = this.context;
        this.preamp = ctx.createGain();
        this.filters = BANDS.map((frequency, index) => {
            const filter = ctx.createBiquadFilter();
            filter.type = index === 0 ? "lowshelf" : index === BANDS.length - 1 ? "highshelf" : "peaking";
            filter.frequency.value = frequency;
            filter.Q.value = 1.1;
            return filter;
        });
        this.bassFilter = ctx.createBiquadFilter();
        this.bassFilter.type = "lowshelf";
        this.bassFilter.frequency.value = 110;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.8;
        this.output = ctx.createGain();
        this.normalizer = ctx.createDynamicsCompressor();
        this.normalizer.threshold.value = -24;
        this.normalizer.knee.value = 12;
        this.normalizer.ratio.value = 3;
        this.normalizer.attack.value = 0.02;
        this.normalizer.release.value = 0.4;
        this.makeup = ctx.createGain();
        this.makeup.gain.value = dbToGain(4);
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -1;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.1;
        this.analyser.connect(this.output);
        this.output.connect(ctx.destination);
        this.rewire();
        this.apply();
    }

    input(element) {
        if (this.inputs.has(element)) {
            return this.inputs.get(element);
        }
        const source = this.context.createMediaElementSource(element);
        const gain = this.context.createGain();
        source.connect(gain);
        gain.connect(this.preamp);
        element.volume = 1;
        const entry = { source, gain, level: 1, fade: 1 };
        this.inputs.set(element, entry);
        return entry;
    }

    // DSP stages are only in the path while they do something
    rewire() {
        if (!this.context) {
            return;
        }
        const chain = [this.preamp];
        if (this.equalizer.enabled) {
            chain.push(...this.filters);
        }
        if (this.bass > 0) {
            chain.push(this.bassFilter);
        }
        if (this.normalize) {
            chain.push(this.normalizer, this.makeup);
        }
        const boosting = (this.equalizer.enabled && (this.equalizer.preamp > 0 || this.equalizer.bands.some((band) => band > 0)))
            || this.bass > 0 || this.normalize;
        if (boosting) {
            chain.push(this.limiter);
        }
        for (const node of [this.preamp, ...this.filters, this.bassFilter, this.normalizer, this.makeup, this.limiter]) {
            node.disconnect();
        }
        for (let index = 0; index < chain.length - 1; index += 1) {
            chain[index].connect(chain[index + 1]);
        }
        chain[chain.length - 1].connect(this.analyser);
        this.processing = chain.length > 1;
    }

    apply() {
        if (!this.context) {
            return;
        }
        const now = this.context.currentTime;
        this.preamp.gain.setTargetAtTime(this.equalizer.enabled ? dbToGain(this.equalizer.preamp) : 1, now, 0.02);
        this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(this.equalizer.bands[index] || 0, now, 0.02));
        this.bassFilter.gain.setTargetAtTime(this.bass, now, 0.02);
        this.output.gain.setTargetAtTime(this.volume, now, 0.02);
    }

    setEqualizer(equalizer) {
        this.equalizer = {
            enabled: Boolean(equalizer && equalizer.enabled),
            bands: (equalizer && Array.isArray(equalizer.bands) ? equalizer.bands : PRESETS.flat).slice(0, 10),
            preamp: Number(equalizer && equalizer.preamp) || 0,
        };
        this.rewire();
        this.apply();
    }

    setBass(db) {
        this.bass = Math.max(0, Math.min(Number(db) || 0, 12));
        this.rewire();
        this.apply();
    }

    setNormalize(on) {
        this.normalize = Boolean(on);
        this.rewire();
    }

    setVolume(value) {
        this.volume = Math.max(0, Math.min(Number(value), 1));
        this.apply();
    }

    setLevel(element, level, fade) {
        const entry = this.inputs.get(element);
        if (!entry) {
            return false;
        }
        if (level !== undefined) {
            entry.level = level;
        }
        if (fade !== undefined) {
            entry.fade = fade;
        }
        entry.gain.gain.setTargetAtTime(entry.level * entry.fade, this.context.currentTime, 0.03);
        return true;
    }

    async resume() {
        if (this.context && this.context.state !== "running") {
            try {
                await this.context.resume();
            } catch (error) {
                return false;
            }
        }
        return !this.context || this.context.state === "running";
    }

    describe() {
        if (!this.context) {
            return "Direct playback, no browser processing";
        }
        const stages = [];
        if (this.equalizer.enabled) {
            stages.push("equalizer");
        }
        if (this.bass > 0) {
            stages.push("bass boost");
        }
        if (this.normalize) {
            stages.push("loudness normalization");
        }
        const rate = `${(this.context.sampleRate / 1000).toFixed(1)} kHz float`;
        return stages.length
            ? `Processed by Web Audio (${stages.join(", ")}) at ${rate}: not bit-perfect`
            : `Routed through Web Audio at ${rate} for gain and visualizer`;
    }
}

export { dbToGain };
