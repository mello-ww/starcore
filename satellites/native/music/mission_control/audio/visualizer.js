// Draws from the AnalyserNode the real playback runs through - never synthetic data.
export function visualizer(canvas, effects, getMode) {
    let frame = null;
    let spectrum = null;
    let wave = null;
    const context = canvas.getContext("2d");

    function draw() {
        frame = requestAnimationFrame(draw);
        const mode = getMode();
        const analyser = effects.analyser;
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth * ratio;
        const height = canvas.clientHeight * ratio;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        context.clearRect(0, 0, width, height);
        if (!analyser || mode === "off" || !width) {
            return;
        }
        const color = getComputedStyle(canvas).color || "#ee444b";
        context.fillStyle = color;
        context.strokeStyle = color;
        if (mode === "wave") {
            wave = wave && wave.length === analyser.fftSize ? wave : new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(wave);
            context.lineWidth = 2 * ratio;
            context.beginPath();
            for (let index = 0; index < wave.length; index += 4) {
                const x = (index / wave.length) * width;
                const y = (wave[index] / 255) * height;
                if (index === 0) {
                    context.moveTo(x, y);
                } else {
                    context.lineTo(x, y);
                }
            }
            context.stroke();
            return;
        }
        spectrum = spectrum && spectrum.length === analyser.frequencyBinCount ? spectrum : new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(spectrum);
        const bars = 48;
        const gap = 2 * ratio;
        const barWidth = (width - gap * (bars - 1)) / bars;
        for (let bar = 0; bar < bars; bar += 1) {
            // logarithmic bins, so bass doesn't take one bar and treble forty
            const start = Math.floor(Math.pow(spectrum.length, bar / bars));
            const end = Math.max(start + 1, Math.floor(Math.pow(spectrum.length, (bar + 1) / bars)));
            let peak = 0;
            for (let index = start; index < end && index < spectrum.length; index += 1) {
                peak = Math.max(peak, spectrum[index]);
            }
            const barHeight = Math.max(2 * ratio, (peak / 255) * height);
            context.globalAlpha = 0.35 + (peak / 255) * 0.65;
            context.fillRect(bar * (barWidth + gap), height - barHeight, barWidth, barHeight);
        }
        context.globalAlpha = 1;
    }

    return {
        start() {
            if (frame === null) {
                draw();
            }
        },
        stop() {
            if (frame !== null) {
                cancelAnimationFrame(frame);
                frame = null;
            }
        },
    };
}
