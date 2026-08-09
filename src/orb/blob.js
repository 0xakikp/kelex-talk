// ── Simplex Noise (compact implementation) ──
class SimplexNoise {
    constructor() {
        this.p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) this.p[i] = i;
        for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[this.p[i], this.p[j]] = [this.p[j], this.p[i]]; }
        this.perm = new Uint8Array(512);
        for (let i = 0; i < 512; i++) this.perm[i] = this.p[i & 255];
    }
    noise2D(x, y) {
        const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
        const s = (x + y) * F2; let i = Math.floor(x + s), j = Math.floor(y + s);
        const t = (i + j) * G2, X0 = i - t, Y0 = j - t, x0 = x - X0, y0 = y - Y0;
        let i1, j1; if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
        const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
        i &= 255; j &= 255;
        const grad = (h, gx, gy) => { h &= 7; const u = h < 4 ? gx : gy, v = h < 4 ? gy : gx; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
        let n0 = 0, n1 = 0, n2 = 0;
        let t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * grad(this.perm[i + this.perm[j]], x0, y0); }
        let t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * grad(this.perm[i + i1 + this.perm[j + j1]], x1, y1); }
        let t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * grad(this.perm[i + 1 + this.perm[j + 1]], x2, y2); }
        return 70 * (n0 + n1 + n2);
    }
    noise3D(x, y, z) {
        return (this.noise2D(x, y) + this.noise2D(y, z) + this.noise2D(x, z)) / 3;
    }
}

// ── Blob Renderer ──
const canvas = document.getElementById('blobCanvas');
const ctx = canvas.getContext('2d');
const noise = new SimplexNoise();

let width, height, cx, cy, baseRadius;
let blobState = 'standby';
let targetIntensity = 0.3;
let currentIntensity = 0.3;
let audioLevel = 0;
let time = 0;

function resize() {
    // Read from the canvas's CSS box first so the renderer respects
    // whatever container it's mounted in. Falls back to the viewport
    // when clientWidth/Height return 0 (e.g. the canvas is in a
    // display:none ancestor before first paint, or the legacy HUD page
    // mounts the canvas with `position: fixed; width: 100%; height:
    // 100%` and the layout hasn't computed yet).
    //
    // This shape lets the same blob.js power both the legacy standalone
    // HUD page (full viewport) and the Mission Control "Talk" panel
    // (right pane only — left side is the MC nav). For the merge, see
    // docs/jarvis/09-mission-control.md.
    // DPR-aware: keep width/height in *logical* (CSS) pixels for all the
    // drawing math below, but back the canvas with a device-pixel buffer
    // and scale the context so the orb stays crisp on Retina displays.
    // (kelex-talk addition — the legacy HUD ran 1:1 in a browser tab.)
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = width / 2;
    cy = height / 2;
    baseRadius = Math.min(width, height) * 0.18;
}
window.addEventListener('resize', resize);
resize();

const palettes = {
    standby: { inner: [0, 20, 60], outer: [0, 80, 180], glow: 'rgba(0,100,255,0.08)', accent: '#0066cc' },
    listening: { inner: [0, 60, 120], outer: [0, 200, 255], glow: 'rgba(0,212,255,0.15)', accent: '#00d4ff' },
    processing: { inner: [80, 0, 160], outer: [200, 0, 255], glow: 'rgba(140,0,255,0.12)', accent: '#aa44ff' },
    speaking: { inner: [120, 0, 80], outer: [255, 0, 170], glow: 'rgba(255,0,170,0.15)', accent: '#ff00aa' },
};

function lerpColor(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

let currentPalette = { ...palettes.standby };
let targetPalette = palettes.standby;

function drawBlob() {
    // MODIFIED: Base speed + dynamic speed based on audio volume
    // This makes the blob undulate and rings spin faster when noise hits
    time += 0.005 + (audioLevel * 0.05);

    currentIntensity += (targetIntensity - currentIntensity) * 0.05;
    currentPalette.inner = lerpColor(currentPalette.inner, targetPalette.inner, 0.03);
    currentPalette.outer = lerpColor(currentPalette.outer, targetPalette.outer, 0.03);

    ctx.clearRect(0, 0, width, height);

    const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 3);
    bgGrad.addColorStop(0, targetPalette.glow);
    bgGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    drawRings();

    const layers = [
        { scale: 1.15, alpha: 0.08, noiseScale: 1.2, speed: 0.7 },
        { scale: 1.0, alpha: 0.25, noiseScale: 1.5, speed: 1.0 },
        { scale: 0.85, alpha: 0.5, noiseScale: 2.0, speed: 1.3 },
        { scale: 0.65, alpha: 0.8, noiseScale: 2.5, speed: 1.6 },
    ];

    for (const layer of layers) {
        drawBlobLayer(layer);
    }

    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 0.4);
    const [ir, ig, ib] = currentPalette.inner;
    coreGrad.addColorStop(0, `rgba(${ir + 100},${ig + 100},${ib + 100},0.3)`);
    coreGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${currentPalette.outer.join(',')},0.4)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
    ctx.stroke();

    ctx.fillStyle = targetPalette.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();

    requestAnimationFrame(drawBlob);
}

function drawBlobLayer(layer) {
    const points = 120;
    const r = baseRadius * layer.scale;
    const noiseAmp = currentIntensity * r * 0.5 + audioLevel * r * 0.4;
    const t = time * layer.speed;

    const [or, og, ob] = currentPalette.outer;
    const [ir, ig, ib] = currentPalette.inner;

    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const nx = Math.cos(angle) * layer.noiseScale;
        const ny = Math.sin(angle) * layer.noiseScale;
        const n = noise.noise3D(nx + t, ny + t, t * 0.5);
        const radius = r + n * noiseAmp;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.3);
    grad.addColorStop(0, `rgba(${ir},${ig},${ib},${layer.alpha})`);
    grad.addColorStop(0.7, `rgba(${or},${og},${ob},${layer.alpha * 0.6})`);
    grad.addColorStop(1, `rgba(${or},${og},${ob},0)`);
    ctx.fillStyle = grad;
    ctx.fill();

    if (layer.alpha > 0.3) {
        ctx.strokeStyle = `rgba(${or},${og},${ob},${layer.alpha * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = `rgb(${or},${og},${ob})`;
        ctx.shadowBlur = 15;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }
}

function drawRings() {
    const [r, g, b] = currentPalette.outer;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.15);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.2)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-time * 0.1);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.12)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius * 1.7, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < 72; i++) {
        const angle = (i / 72) * Math.PI * 2;
        const len = i % 6 === 0 ? 10 : 4;
        const r1 = baseRadius * 1.7;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
        ctx.lineTo(Math.cos(angle) * (r1 + len), Math.sin(angle) * (r1 + len));
        ctx.strokeStyle = `rgba(${r},${g},${b},${i % 6 === 0 ? 0.3 : 0.1})`;
        ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.05);
    for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * baseRadius * 1.3, Math.sin(angle) * baseRadius * 1.3);
        ctx.lineTo(Math.cos(angle) * baseRadius * 1.45, Math.sin(angle) * baseRadius * 1.45);
        ctx.strokeStyle = `rgba(${r},${g},${b},0.08)`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }
    ctx.restore();

    for (let i = 0; i < 3; i++) {
        const angle = time * (0.3 + i * 0.15) + i * 2.094;
        const orbitR = baseRadius * (1.5 + i * 0.1);
        const dx = cx + Math.cos(angle) * orbitR;
        const dy = cy + Math.sin(angle) * orbitR;
        ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
        ctx.beginPath();
        ctx.arc(dx, dy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${r},${g},${b},0.15)`;
        ctx.beginPath();
        ctx.arc(dx, dy, 6, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ── Public API for the app JS ──
window.blobAPI = {
    setState(state) {
        blobState = state;
        switch (state) {
            case 'standby':
                targetIntensity = 0.25;
                targetPalette = palettes.standby;
                break;
            case 'listening':
                targetIntensity = 0.5;
                targetPalette = palettes.listening;
                break;
            case 'processing':
                targetIntensity = 0.6;
                targetPalette = palettes.processing;
                break;
            case 'speaking':
                targetIntensity = 0.7;
                targetPalette = palettes.speaking;
                break;
        }
    },
    setAudioLevel(level) {
        // MODIFIED: Increased modifier from 0.3 to 0.6 so it reacts snappier to voice peaks
        audioLevel += (level - audioLevel) * 0.6;
    }
};

drawBlob();