// Procedural starfield behind the HUD.
//
// One <canvas id="starfield"> fixed at z-index -1 (see main.css), drawn
// from a small fixed set of "star" objects. Each star has a base
// opacity, a per-star twinkle frequency + phase, and a very slow
// vertical drift so the field feels alive without ever competing for
// attention with the blob.
//
// Costs ~300 sin() + 300 arc() per frame at 60Hz on a typical desktop —
// trivial. No WebGL needed.

(function () {
    const canvas = document.getElementById('starfield');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Star count scales with viewport area so dense wide monitors stay
    // populated and small viewports don't get cluttered.
    function targetStarCount() {
        // Sparser than the legacy full-screen HUD — kelex-talk runs in a small
        // floating/windowed frame where the original 180+ minimum looked like
        // static. Scales with area but stays tasteful.
        const area = window.innerWidth * window.innerHeight;
        return Math.min(90, Math.max(18, Math.round(area / 18000)));
    }

    let stars = [];
    let width = 0, height = 0;

    function seedStars() {
        const n = targetStarCount();
        stars = new Array(n);
        for (let i = 0; i < n; i++) {
            stars[i] = {
                x: Math.random() * width,
                y: Math.random() * height,
                r: Math.random() * 1.4 + 0.3,
                baseOpacity: Math.random() * 0.7 + 0.2,
                twinkleSpeed: Math.random() * 0.0015 + 0.0004,
                twinklePhase: Math.random() * Math.PI * 2,
                // Slow downward drift, 0.5–1.5px/sec at 60fps. Off-screen
                // stars wrap to the top.
                vy: Math.random() * 0.025 + 0.008,
                // 85% white, 15% cool-blue. The cool tint catches the eye
                // without being aggressive.
                blue: Math.random() < 0.15,
            };
        }
    }

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seedStars();
    }

    function draw(t) {
        ctx.clearRect(0, 0, width, height);
        // Single beginPath per color keeps the GPU happy — one fill
        // call per group rather than 300 individual fills.
        const whiteStars = [];
        const blueStars = [];
        for (const s of stars) {
            const twinkle = Math.sin(t * s.twinkleSpeed + s.twinklePhase) * 0.35 + 0.65;
            (s.blue ? blueStars : whiteStars).push([s.x, s.y, s.r, s.baseOpacity * twinkle]);
            s.y += s.vy;
            if (s.y > height) {
                s.y = 0;
                s.x = Math.random() * width;
            }
        }
        for (const [x, y, r, op] of whiteStars) {
            ctx.fillStyle = `rgba(255,255,255,${op.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        for (const [x, y, r, op] of blueStars) {
            ctx.fillStyle = `rgba(180,220,255,${op.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        requestAnimationFrame(draw);
    }

    resize();
    // Debounce resize so dragging the window doesn't reseed on every
    // intermediate pixel.
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 150);
    });
    requestAnimationFrame(draw);
})();
