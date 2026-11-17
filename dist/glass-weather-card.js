/*
 * Glass Weather Card for Home Assistant
 *
 * A glass weather card whose sky, ink, clouds and particles follow the weather.
 * Tap a day in the row below and the whole scene switches to that day.
 *
 * One dependency-free ES module: SVG + CSS for the sky, a canvas for rain /
 * snow / hail / droplets on the glass, Web Audio for the optional sound.
 * No network requests other than Home Assistant's own websocket.
 */

const VERSION = '1.0.0';
const TAG = 'glass-weather-card';

/* Typed colour properties so the sky gradient cross-fades. @property inside a
   shadow root is ignored, so register once per page; a second call throws. */
for (const [name, initialValue] of [['--sky-a', '#8298b6'], ['--sky-b', '#cfd8e4']]) {
    try {
        CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue });
    } catch (e) { /* already registered or unsupported: the gradient snaps instead of fading */ }
}

const FEATURE_DAILY = 1;
const FEATURE_TWICE_DAILY = 4;

/* ------------------------------------------------------------ scenes ------ */

// HA condition → scene + modifiers. Scenes own the palette; modifiers tweak it.
const CONDITIONS = {
    sunny: { scene: 'sunny' },
    partlycloudy: { scene: 'sunny', mods: ['partly'] },
    'clear-night': { scene: 'night' },
    cloudy: { scene: 'cloudy' },
    fog: { scene: 'cloudy', mods: ['fog'] },
    windy: { scene: 'cloudy', mods: ['windy'] },
    'windy-variant': { scene: 'cloudy', mods: ['windy'] },
    rainy: { scene: 'rain' },
    pouring: { scene: 'rain', mods: ['pouring'] },
    lightning: { scene: 'thunder', mods: ['dry'] },
    'lightning-rainy': { scene: 'thunder' },
    snowy: { scene: 'snow' },
    'snowy-rainy': { scene: 'snow', mods: ['sleet'] },
    hail: { scene: 'snow', mods: ['hail'] },
    exceptional: { scene: 'cloudy', mods: ['still'] },
};
const FALLBACK = { scene: 'cloudy', mods: ['still'] }; // unknown, unavailable, anything new

// Sound mix per scene / modifier.
const MIX = {
    sunny: { rain: 0, wind: 0.04 },
    night: { rain: 0, wind: 0.04 },
    cloudy: { rain: 0, wind: 0.12 },
    rain: { rain: 0.16, wind: 0.04 },
    thunder: { rain: 0.24, wind: 0.1 },
    snow: { rain: 0, wind: 0.22 },
};
const MOD_MIX = {
    pouring: { rain: 0.26, wind: 0.08 },
    windy: { wind: 0.3 },
    dry: { rain: 0 },
    sleet: { rain: 0.08 },
    still: { rain: 0, wind: 0.06 },
};

// Scenes that get darker sky tokens after sunset (current conditions only).
const NIGHT_TINTED = new Set(['cloudy', 'rain', 'snow']);

/* ------------------------------------------------------------- icons ------ */

const rays = (cx, cy, r1, r2, n = 8) =>
    Array.from({ length: n }, (_, i) => {
        const a = (i * 2 * Math.PI) / n;
        const p = (r) => `${(cx + Math.sin(a) * r).toFixed(2)} ${(cy - Math.cos(a) * r).toFixed(2)}`;
        return `M${p(r1)}L${p(r2)}`;
    }).join('');

// Small animated icons for the day pills: sun, moon, clouds, rain, bolt and
// snow composed per condition, in colour. They use the
// gradients and the cloud symbol defined once in the card's <defs>.
const M_SUN = () => `<g class="m-sun"><g class="m-rays" stroke="#f6c445" stroke-width="7" stroke-linecap="round"><path d="${HERO_RAYS}" fill="none"/></g><circle cx="60" cy="60" r="27" fill="url(#sunFill)"/></g>`;
const M_MOON = '<g class="m-moon"><circle cx="60" cy="58" r="28" fill="url(#moonFill)"/><circle cx="50" cy="50" r="6" fill="rgba(140,155,190,.3)"/><circle cx="69" cy="66" r="4.5" fill="rgba(140,155,190,.26)"/></g>';
const M_CLOUD = '<use class="m-cloud" href="#cloud" x="10" y="20" width="100" height="58"/>';
const M_CLOUD_LOW = '<use class="m-cloud" href="#cloud" x="10" y="38" width="100" height="58"/>';
const M_CLOUD2 = '<use class="m-cloud2" href="#cloud" x="0" y="8" width="74" height="43"/>';
const M_BEHIND = (body) => `<g transform="translate(-2 -10) scale(.8)">${body}</g>`; // smaller, up-left, behind a cloud
const M_RAIN = '<g class="m-rain"><line x1="38" y1="88" x2="34" y2="102"/><line x1="60" y1="88" x2="56" y2="102"/><line x1="82" y1="88" x2="78" y2="102"/></g>';
const M_BOLT = '<path class="m-bolt" d="M64 66 44 96h14l-7 22 26-33H63l9-19z"/>';
const M_SNOW = (r = 6) => `<g class="m-snow"><circle cx="38" cy="92" r="${r}"/><circle cx="60" cy="100" r="${r}"/><circle cx="82" cy="92" r="${r}"/></g>`;
const M_FOG = '<g class="m-fog"><path d="M22 92h76M34 106h52"/></g>';
const M_WIND = '<g class="m-wind"><path d="M18 90h58a10 10 0 1 0-10-10M26 104h44"/></g>';

function miniIcon(condition, night) {
    let body;
    switch (condition) {
        case 'sunny': body = night ? M_MOON : M_SUN(); break;
        case 'clear-night': body = M_MOON; break;
        case 'partlycloudy': body = M_BEHIND(night ? M_MOON : M_SUN()) + M_CLOUD_LOW; break;
        case 'fog': body = M_CLOUD + M_FOG; break;
        case 'windy': case 'windy-variant': body = M_CLOUD2 + M_CLOUD + M_WIND; break;
        case 'rainy': case 'pouring': body = M_CLOUD + M_RAIN; break;
        case 'lightning': case 'lightning-rainy': body = M_CLOUD + M_BOLT; break;
        case 'snowy': case 'snowy-rainy': body = M_CLOUD + M_SNOW(); break;
        case 'hail': body = M_CLOUD + M_SNOW(7.5); break;
        default: body = M_CLOUD2 + M_CLOUD;
    }
    return `<svg class="mini" viewBox="0 0 120 120" aria-hidden="true">${body}</svg>`;
}

const rand = (a, b) => a + Math.random() * (b - a);
const num = (n) => (n < 0 ? '−' + Math.abs(n) : String(n));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Feels-like when the integration doesn't report one (Met.no doesn't):
// Steadman's apparent temperature (shade), the formula the BoM uses.
const WIND_MS = { 'km/h': 1 / 3.6, 'm/s': 1, mph: 0.44704, kn: 0.514444, 'ft/s': 0.3048 };
function apparentTemperature(t, rh, wind, tUnit, wUnit) {
    if (!isNum(t) || !isNum(rh)) return null;
    const f = /F/i.test(tUnit || '');
    const c = f ? ((Number(t) - 32) * 5) / 9 : Number(t);
    const ms = isNum(wind) ? Number(wind) * (WIND_MS[wUnit] ?? 1 / 3.6) : 0;
    const e = (Number(rh) / 100) * 6.105 * Math.exp((17.27 * c) / (237.7 + c));
    const at = c + 0.33 * e - 0.7 * ms - 4.0;
    return f ? (at * 9) / 5 + 32 : at;
}
const isNum = (v) => v !== null && v !== undefined && v !== '' && !isNaN(v);

/* --------------------------------------------------------------- sky ------ */

// The animated sky, drawn on one canvas: gradient, sun, moon, stars, clouds,
// fog, wind streaks, rain, snow, hail and lightning. Values are 0..1 targets
// that the renderer eases toward, so scenes cross-fade.
const SKY_KEYS = ['sun', 'moon', 'stars', 'cloud', 'dark', 'rain', 'snow', 'hail', 'fog', 'storm', 'wind'];
const SKY = {
    sun:         { top: [38, 132, 226], bot: [140, 205, 255], sun: 1 },
    night:       { top: [8, 15, 40],    bot: [36, 52, 98],    moon: 1, stars: 1 },
    partly:      { top: [52, 128, 204], bot: [160, 205, 240], sun: 0.9, cloud: 0.55 },
    partlyNight: { top: [12, 20, 48],   bot: [44, 58, 100],   moon: 0.9, stars: 0.6, cloud: 0.5, dark: 0.55 },
    clouds:      { top: [90, 113, 140], bot: [170, 185, 202], cloud: 1, dark: 0.3 },
    still:       { top: [96, 112, 132], bot: [168, 180, 194], cloud: 0.8, dark: 0.35 },
    fog:         { top: [128, 140, 152], bot: [196, 204, 211], cloud: 0.4, dark: 0.15, fog: 1 },
    rain:        { top: [60, 78, 100],  bot: [122, 138, 156], cloud: 1, dark: 0.55, rain: 0.55 },
    pour:        { top: [40, 52, 68],   bot: [88, 102, 118],  cloud: 1, dark: 0.75, rain: 1, wind: 0.3 },
    storm:       { top: [26, 31, 46],   bot: [66, 74, 94],    cloud: 1, dark: 0.9, rain: 0.7, storm: 1, wind: 0.25 },
    dryStorm:    { top: [30, 35, 50],   bot: [70, 78, 98],    cloud: 1, dark: 0.85, storm: 1, wind: 0.2 },
    snow:        { top: [112, 136, 168], bot: [208, 220, 234], cloud: 0.8, dark: 0.2, snow: 1 },
    sleet:       { top: [88, 106, 128], bot: [164, 178, 194], cloud: 1, dark: 0.45, rain: 0.35, snow: 0.5 },
    hail:        { top: [80, 96, 118],  bot: [156, 170, 188], cloud: 1, dark: 0.5, hail: 1, wind: 0.15 },
    wind:        { top: [70, 128, 186], bot: [180, 208, 234], cloud: 0.6, dark: 0.1, wind: 1 },
};
const SKY_OF = {
    sunny: 'sun', 'clear-night': 'night', partlycloudy: 'partly', cloudy: 'clouds', exceptional: 'still',
    fog: 'fog', rainy: 'rain', pouring: 'pour', lightning: 'dryStorm', 'lightning-rainy': 'storm',
    snowy: 'snow', 'snowy-rainy': 'sleet', hail: 'hail', windy: 'wind', 'windy-variant': 'wind',
};
const NIGHT_TOP = [8, 15, 40];
const NIGHT_BOT = [36, 52, 98];
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function skyScene(condition, night) {
    let key = SKY_OF[condition] || 'still';
    if (night && key === 'sun') key = 'night';
    if (night && key === 'partly') key = 'partlyNight';
    const base = SKY[key];
    const t = { key };
    SKY_KEYS.forEach((k) => (t[k] = base[k] || 0));
    t.top = base.top.slice();
    t.bot = base.bot.slice();
    if (night && key !== 'night' && key !== 'partlyNight') {
        t.top = mixRgb(base.top, NIGHT_TOP, 0.6);
        t.bot = mixRgb(base.bot, NIGHT_BOT, 0.6);
        t.sun = 0;
        t.dark = Math.max(t.dark, 0.5);
        t.stars = Math.max(0, 0.5 - t.cloud * 0.5);
    }
    return t;
}

class SkyRenderer {
    constructor(canvas, onStrike) {
        this.canvas = canvas;
        this.g = canvas.getContext('2d');
        this.onStrike = onStrike;
        this.w = 0;
        this.h = 0;
        this.s = skyScene('cloudy', false);
        this.t = this.s;
        this.drops = [];
        this.flakes = [];
        this.stones = [];
        this.streaks = [];
        this.clouds = Array.from({ length: 7 }, (_, i) => this._cloud(i, true));
        this.stars = Array.from({ length: 70 }, () => ({
            x: Math.random(), y: Math.random() * 0.65, r: Math.random() * 1.1 + 0.3, p: Math.random() * 6.28,
        }));
        this.flash = 0;
        this.bolt = null;
        this.boltLife = 0;
        this.nextStrike = 1.2;
        this.time = 0;
        this.active = false;
        this.static = false;
        this.running = false;
        this.raf = 0;
        this._tick = this._tick.bind(this);
    }

    _cloud(idx, initial) {
        const n = 4 + Math.floor(Math.random() * 3);
        const puffs = [];
        for (let k = 0; k < n; k++) {
            const middle = k > 0 && k < n - 1;
            puffs.push({
                dx: (k - (n - 1) / 2) * 0.34 + (Math.random() - 0.5) * 0.12,
                dy: (Math.random() - 0.5) * 0.15 - (middle ? 0.22 : 0),
                r: (middle ? 0.42 : 0.3) + Math.random() * 0.18,
            });
        }
        return {
            idx,
            x: initial ? Math.random() * 1.5 - 0.25 : -0.4,
            y: 0.04 + Math.random() * 0.36,
            size: 0.6 + Math.random() * 0.6,
            speed: 0.005 + Math.random() * 0.01,
            puffs,
        };
    }

    resize() {
        const r = this.canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.w = r.width;
        this.h = r.height;
        this.canvas.width = Math.round(r.width * dpr);
        this.canvas.height = Math.round(r.height * dpr);
        this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!this.running) this.drawStatic();
    }

    setScene(target, immediate) {
        this.t = target;
        if (immediate || this.static) this.s = { ...target, top: target.top.slice(), bot: target.bot.slice() };
        if (!this.running) this.drawStatic();
    }

    setActive(on) {
        this.active = on;
        this._sync();
    }

    setStatic(on) {
        this.static = on;
        this._sync();
        if (on) this.drawStatic();
    }

    _sync() {
        if (this.active && !this.static) {
            if (this.running) return;
            this.running = true;
            this.last = performance.now();
            this.raf = requestAnimationFrame(this._tick);
        } else {
            this.running = false;
            if (this.raf) cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
    }

    _tick(now) {
        if (!this.running) return;
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this._step(dt);
        this._draw();
        this.raf = requestAnimationFrame(this._tick);
    }

    // One still frame. In static mode the scene is applied at once and the
    // particles are scattered in place.
    drawStatic() {
        if (!this.w || !this.h) return;
        if (this.static) {
            this.s = { ...this.t, top: this.t.top.slice(), bot: this.t.bot.slice() };
            this.drops = [];
            this.flakes = [];
            this.stones = [];
            this.flash = 0;
            this.boltLife = 0;
            for (let i = 0, n = Math.round(this.s.rain * this.w * 0.3); i < n; i++) this.drops.push(this._drop(Math.random() * this.h));
            for (let i = 0, n = Math.round(this.s.snow * this.w * 0.35); i < n; i++) this.flakes.push(this._flake(Math.random() * this.h));
            for (let i = 0, n = Math.round(this.s.hail * this.w * 0.12); i < n; i++) this.stones.push(this._stone(Math.random() * this.h));
        }
        this._draw();
    }

    _drop(y) {
        return { x: Math.random() * this.w * 1.3, y, vy: 700 + Math.random() * 350, vx: -90 - this.s.wind * 260 };
    }

    _flake(y) {
        return { x: Math.random() * this.w, y, r: 0.8 + Math.random() * 2.2, vy: 22 + Math.random() * 40, p: Math.random() * 6.28, sway: 8 + Math.random() * 18 };
    }

    _stone(y) {
        return { x: Math.random() * this.w * 1.15, y, r: 1.6 + Math.random() * 1.6, vy: 380 + Math.random() * 160, vx: -40 - this.s.wind * 160 };
    }

    _step(dt) {
        const s = this.s;
        const t = this.t;
        const f = 1 - Math.exp(-dt * 1.6);
        SKY_KEYS.forEach((k) => (s[k] += (t[k] - s[k]) * f));
        s.top = mixRgb(s.top, t.top, f);
        s.bot = mixRgb(s.bot, t.bot, f);
        this.time += dt;
        const { w, h } = this;
        const scale = w / 100;

        const cloudSpeed = 1 + s.wind * 4;
        for (const c of this.clouds) {
            c.x += c.speed * cloudSpeed * dt;
            if (c.x > 1.4) Object.assign(c, this._cloud(c.idx, false));
        }

        this._rainAcc = (this._rainAcc || 0) + s.rain * scale * 70 * dt;
        while (this._rainAcc >= 1 && this.drops.length < 700) {
            this.drops.push(this._drop(-20));
            this._rainAcc -= 1;
        }
        this._rainAcc %= 1;
        for (const d of this.drops) {
            d.x += d.vx * dt;
            d.y += d.vy * dt;
        }
        this.drops = this.drops.filter((d) => d.y < h + 20);

        this._snowAcc = (this._snowAcc || 0) + s.snow * scale * 8 * dt;
        while (this._snowAcc >= 1 && this.flakes.length < 450) {
            this.flakes.push(this._flake(-6));
            this._snowAcc -= 1;
        }
        this._snowAcc %= 1;
        for (const p of this.flakes) {
            p.y += p.vy * dt;
            p.p += dt * 1.3;
            p.x += (Math.cos(p.p) * p.sway - s.wind * 60) * dt;
        }
        this.flakes = this.flakes.filter((p) => p.y < h + 8);

        this._hailAcc = (this._hailAcc || 0) + s.hail * scale * 14 * dt;
        while (this._hailAcc >= 1 && this.stones.length < 250) {
            this.stones.push(this._stone(-8));
            this._hailAcc -= 1;
        }
        this._hailAcc %= 1;
        for (const st of this.stones) {
            st.x += st.vx * dt;
            st.y += st.vy * dt;
        }
        this.stones = this.stones.filter((st) => st.y < h + 8);

        if (s.wind > 0.2 && Math.random() < s.wind * dt * 3 && this.streaks.length < 10) {
            this.streaks.push({ x: w + 40, y: h * (0.15 + Math.random() * 0.7), len: 60 + Math.random() * 120, v: 380 + Math.random() * 260, amp: 4 + Math.random() * 8 });
        }
        for (const st of this.streaks) st.x -= st.v * dt;
        this.streaks = this.streaks.filter((st) => st.x + st.len > -20);

        this.flash = Math.max(0, this.flash - dt * 2.8);
        this.boltLife = Math.max(0, this.boltLife - dt);
        if (s.storm > 0.5) {
            this.nextStrike -= dt;
            if (this.nextStrike <= 0) {
                this._strike();
                this.nextStrike = 1.8 + Math.random() * 3.4;
            }
        } else {
            this.nextStrike = Math.min(this.nextStrike, 0.7);
        }
    }

    _strike() {
        const { w, h } = this;
        let x = w * (0.15 + Math.random() * 0.7);
        let y = h * 0.22;
        const pts = [[x, y]];
        while (y < h * 0.78) {
            x += (Math.random() - 0.5) * w * 0.09;
            y += h * (0.04 + Math.random() * 0.05);
            pts.push([x, y]);
        }
        this.bolt = pts;
        this.boltLife = 0.22;
        this.flash = 1;
        this.onStrike?.(0.6 + Math.random() * 0.4);
    }

    _draw() {
        const { g, w, h, s } = this;
        if (!w || !h) return;
        const unit = Math.min(w, h);

        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, rgb(s.top));
        sky.addColorStop(1, rgb(s.bot));
        g.fillStyle = sky;
        g.fillRect(0, 0, w, h);

        if (s.stars > 0.01) {
            for (const st of this.stars) {
                const tw = 0.55 + 0.45 * Math.sin(this.time * 1.7 + st.p);
                g.fillStyle = `rgba(255,255,255,${(s.stars * tw * 0.9).toFixed(3)})`;
                g.beginPath();
                g.arc(st.x * w, st.y * h, st.r, 0, 6.283);
                g.fill();
            }
        }

        if (s.sun > 0.01) {
            const cx = w * 0.78;
            const cy = h * 0.2;
            const r = unit * 0.1;
            const glow = g.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 4);
            glow.addColorStop(0, `rgba(255,236,170,${0.75 * s.sun})`);
            glow.addColorStop(0.35, `rgba(255,214,120,${0.25 * s.sun})`);
            glow.addColorStop(1, 'rgba(255,214,120,0)');
            g.fillStyle = glow;
            g.fillRect(cx - r * 4, cy - r * 4, r * 8, r * 8);
            g.save();
            g.translate(cx, cy);
            g.rotate(this.time * 0.08);
            g.strokeStyle = `rgba(255,240,200,${0.35 * s.sun})`;
            g.lineWidth = 2;
            g.lineCap = 'round';
            for (let i = 0; i < 12; i++) {
                g.rotate(Math.PI / 6);
                const pulse = 1 + 0.12 * Math.sin(this.time * 2 + i);
                g.beginPath();
                g.moveTo(r * 1.35, 0);
                g.lineTo(r * 1.35 + r * 0.55 * pulse, 0);
                g.stroke();
            }
            g.restore();
            g.fillStyle = `rgba(255,246,214,${s.sun})`;
            g.beginPath();
            g.arc(cx, cy, r, 0, 6.283);
            g.fill();
        }

        if (s.moon > 0.01) {
            const cx = w * 0.78;
            const cy = h * 0.2;
            const r = unit * 0.075;
            const glow = g.createRadialGradient(cx, cy, r, cx, cy, r * 3.5);
            glow.addColorStop(0, `rgba(200,215,255,${0.3 * s.moon})`);
            glow.addColorStop(1, 'rgba(200,215,255,0)');
            g.fillStyle = glow;
            g.fillRect(cx - r * 3.5, cy - r * 3.5, r * 7, r * 7);
            g.fillStyle = `rgba(238,242,255,${s.moon})`;
            g.beginPath();
            g.arc(cx, cy, r, 0, 6.283);
            g.fill();
            g.fillStyle = `rgba(190,200,225,${0.45 * s.moon})`;
            [[-0.3, -0.2, 0.22], [0.25, 0.25, 0.16], [0.1, -0.4, 0.1]].forEach(([dx, dy, rr]) => {
                g.beginPath();
                g.arc(cx + dx * r, cy + dy * r, rr * r, 0, 6.283);
                g.fill();
            });
        }

        if (s.cloud > 0.01) {
            const shade = mixRgb([255, 255, 255], [92, 100, 116], clamp(s.dark, 0, 1));
            const under = mixRgb(shade, [60, 66, 80], 0.25 + s.dark * 0.3);
            const n = this.clouds.length;
            for (const c of this.clouds) {
                const a = clamp(s.cloud * n - c.idx, 0, 1) * 0.92;
                if (a <= 0.01) continue;
                const base = unit * 0.2 * c.size;
                const cx = c.x * w;
                const cy = c.y * h;
                const grad = g.createLinearGradient(0, cy - base * 0.7, 0, cy + base * 0.5);
                grad.addColorStop(0, rgb(shade, a));
                grad.addColorStop(1, rgb(under, a));
                g.fillStyle = grad;
                g.beginPath();
                for (const p of c.puffs) {
                    g.moveTo(cx + p.dx * base * 2 + p.r * base, cy + p.dy * base * 2);
                    g.arc(cx + p.dx * base * 2, cy + p.dy * base * 2, p.r * base, 0, 6.283);
                }
                g.fill();
            }
        }

        if (s.fog > 0.01) {
            for (let i = 0; i < 4; i++) {
                const y = h * (0.35 + i * 0.17);
                const x = ((this.time * (8 + i * 5) + i * 140) % (w + 400)) - 200;
                const band = g.createRadialGradient(x, y, 0, x, y, w * 0.6);
                band.addColorStop(0, `rgba(235,238,242,${0.42 * s.fog})`);
                band.addColorStop(1, 'rgba(235,238,242,0)');
                g.save();
                g.translate(x, y);
                g.scale(1, 0.28);
                g.translate(-x, -y);
                g.fillStyle = band;
                g.fillRect(x - w * 0.6, y - w * 0.6, w * 1.2, w * 1.2);
                g.restore();
            }
            g.fillStyle = `rgba(225,230,236,${0.18 * s.fog})`;
            g.fillRect(0, 0, w, h);
        }

        if (this.streaks.length) {
            g.strokeStyle = `rgba(255,255,255,${0.35 * s.wind})`;
            g.lineWidth = 1.4;
            g.lineCap = 'round';
            for (const st of this.streaks) {
                g.beginPath();
                g.moveTo(st.x, st.y);
                g.bezierCurveTo(st.x + st.len * 0.33, st.y - st.amp, st.x + st.len * 0.66, st.y + st.amp, st.x + st.len, st.y);
                g.stroke();
            }
        }

        if (this.drops.length) {
            g.strokeStyle = 'rgba(210,225,255,0.55)';
            g.lineWidth = 1.1;
            g.lineCap = 'round';
            g.beginPath();
            for (const d of this.drops) {
                g.moveTo(d.x, d.y);
                g.lineTo(d.x - d.vx * 0.022, d.y - d.vy * 0.022);
            }
            g.stroke();
        }

        if (this.flakes.length) {
            g.fillStyle = 'rgba(255,255,255,0.9)';
            g.beginPath();
            for (const p of this.flakes) {
                g.moveTo(p.x + p.r, p.y);
                g.arc(p.x, p.y, p.r, 0, 6.283);
            }
            g.fill();
        }

        if (this.stones.length) {
            g.fillStyle = 'rgba(240,246,255,0.95)';
            g.beginPath();
            for (const st of this.stones) {
                g.moveTo(st.x + st.r, st.y);
                g.arc(st.x, st.y, st.r, 0, 6.283);
            }
            g.fill();
        }

        if (this.boltLife > 0 && this.bolt) {
            g.save();
            g.strokeStyle = 'rgba(255,255,255,0.95)';
            g.shadowColor = 'rgba(190,210,255,1)';
            g.shadowBlur = 14;
            g.lineWidth = 2.4;
            g.lineJoin = 'round';
            g.beginPath();
            this.bolt.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
            g.stroke();
            g.restore();
        }
        if (this.flash > 0) {
            const flicker = this.flash > 0.6 ? 1 : Math.sin(this.flash * 30) > 0 ? 0.7 : 0.3;
            g.fillStyle = `rgba(230,236,255,${(this.flash * 0.55 * flicker).toFixed(3)})`;
            g.fillRect(0, 0, w, h);
        }
    }
}

/* ------------------------------------------------------------- sound ------ */

class Ambience {
    constructor() {
        this.ctx = null;
        this.on = false;
        this.mix = { rain: 0, wind: 0 };
    }

    _build() {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = (this.ctx = new AC());
        this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;

        this.master = ctx.createGain();
        this.master.gain.value = 0;
        this.master.connect(ctx.destination);

        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 7000;
        this.rainGain = ctx.createGain();
        this.rainGain.gain.value = 0;
        src.connect(hp).connect(lp).connect(this.rainGain).connect(this.master);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 420;
        bp.Q.value = 0.8;
        this.windGain = ctx.createGain();
        this.windGain.gain.value = 0;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13;
        const lfoAmt = ctx.createGain();
        lfoAmt.gain.value = 180;
        lfo.connect(lfoAmt).connect(bp.frequency);
        src.connect(bp).connect(this.windGain).connect(this.master);

        src.start();
        lfo.start();
    }

    _apply() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.rainGain.gain.setTargetAtTime(this.mix.rain, t, 0.35);
        this.windGain.gain.setTargetAtTime(this.mix.wind, t, 0.35);
    }

    setMix(mix) {
        this.mix = mix;
        this._apply();
    }

    thunder() {
        if (!this.on || !this.ctx) return;
        const ctx = this.ctx;
        const t = ctx.currentTime + 0.25;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = rand(90, 150);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1.4, t + 0.06);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
        src.connect(lp).connect(g).connect(this.master);
        src.start(t);
        src.stop(t + 2);
    }

    // Must be called from a user gesture (click).
    async toggle() {
        try {
            if (!this.ctx) this._build();
            this.on = !this.on;
            if (this.on) {
                await this.ctx.resume();
                this._apply();
            }
            this.master.gain.setTargetAtTime(this.on ? 1 : 0, this.ctx.currentTime, 0.15);
        } catch (err) {
            this.on = false;
        }
        return this.on;
    }

    close() {
        this.on = false;
        if (this.ctx) this.ctx.close().catch(() => {});
        this.ctx = null;
    }
}

/* -------------------------------------------------------------- card ------ */

const SUN_RAYS = rays(100, 100, 72, 94);
const HERO_RAYS = rays(60, 60, 37, 47);

const TEMPLATE = (style) => `
<style>${style}</style>
<ha-card>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <symbol id="cloud" viewBox="0 0 120 70">
        <circle cx="38" cy="42" r="22"/>
        <circle cx="64" cy="30" r="28"/>
        <circle cx="90" cy="44" r="20"/>
        <rect x="20" y="40" width="88" height="26" rx="13"/>
      </symbol>
      <radialGradient id="sunFill" cx="38%" cy="34%" r="75%">
        <stop offset="0" stop-color="#fff3c9"/>
        <stop offset=".55" stop-color="#fbd166"/>
        <stop offset="1" stop-color="#f1b23a"/>
      </radialGradient>
      <radialGradient id="moonFill" cx="38%" cy="34%" r="75%">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset=".6" stop-color="#e4eaf7"/>
        <stop offset="1" stop-color="#b9c4dc"/>
      </radialGradient>
    </defs>
  </svg>
  <div class="card" data-weather="cloudy" data-mods="">
    <canvas class="sky" aria-hidden="true"></canvas>

    <header class="top">
      <button class="place" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.2 6.2 11.4 6.8 12a1 1 0 0 0 1.4 0c.6-.6 6.8-6.8 6.8-12A7.5 7.5 0 0 0 12 2zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4z"/></svg>
        <span class="name"></span>
      </button>
      <div class="right">
        <button class="snd" type="button" aria-pressed="false" aria-label="Weather sound" hidden>
          <svg class="off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6a1 1 0 0 0 1.7-.77V5.67a1 1 0 0 0-1.7-.77L8 8.5H5a1 1 0 0 0-1 1z"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <svg class="on" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6a1 1 0 0 0 1.7-.77V5.67a1 1 0 0 0-1.7-.77L8 8.5H5a1 1 0 0 0-1 1z"/><path d="M16.8 9a4.2 4.2 0 0 1 0 6M19 6.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
    </header>

    <section class="now" aria-live="polite">
      <p class="temp"><span class="t">–</span><span class="deg">°</span><span class="lo" hidden></span></p>
      <p class="cond"></p>
      <time class="clock"></time>
      <span class="date"></span>
    </section>

    <dl class="stats">
      <div class="stat"><dt class="l-feels"></dt><dd><span class="v-feels">–</span><span class="u-feels">°</span></dd></div>
      <div class="stat"><dt class="l-hum"></dt><dd><span class="v-hum">–</span><span class="u-hum">%</span></dd></div>
      <div class="stat"><dt class="l-wind"></dt><dd><span class="v-wind">–</span><small class="u-wind"></small></dd></div>
    </dl>

    <div class="days" role="group" hidden></div>
  </div>
</ha-card>`;

const STYLE = `
:host { display: block; height: 100%; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; text-align: inherit; }
:focus-visible { outline: 2px solid #9cc2ff; outline-offset: 3px; }

/* Size is never forced: in sections view the card fills the cell the user picks,
   in masonry it follows its content (or the optional \`height\`). Everything inside
   scales with --u (1 = the 340 px reference design), which JS sets from the real size. */
ha-card {
  display: block;
  height: var(--gwc-height, 100%);
  overflow: hidden;
  border: none;
  background: none;
  border-radius: var(--gwc-radius, var(--ha-card-border-radius, 12px));
}

/* ---------- card + scene tokens ---------- */
.card {
  --u: 1;
  --sky-a: #8298b6; --sky-b: #cfd8e4;
  --ink: #18243d; --ink-soft: rgba(24, 36, 61, .7);
  --cloud: rgba(255, 255, 255, .66);
  --tile: rgba(255, 255, 255, .22); --tile-line: rgba(255, 255, 255, .42);
  --pin: #f2b632;
  --sel-ink: #1b2231;
  --drift: 1;

  position: relative;
  width: 100%;
  height: 100%;
  padding: calc(var(--u) * 18px);
  display: flex;
  flex-direction: column;
  gap: calc(var(--u) * 12px);
  color: var(--ink);
  font-family: var(--ha-font-family-body, inherit);
  background: linear-gradient(180deg, var(--sky-a), var(--sky-b));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .16) inset;
  border-radius: inherit;
  overflow: hidden;
  isolation: isolate;
  -webkit-font-smoothing: antialiased;
  transition: --sky-a .8s ease, --sky-b .8s ease, color .5s ease;
}
.card[data-weather="sunny"] {
  --sky-a: #4d83e4; --sky-b: #b4cdf3;
  --ink: #17233f; --ink-soft: rgba(23, 35, 63, .7);
  --cloud: rgba(255, 255, 255, .34);
  --tile: rgba(255, 255, 255, .2); --tile-line: rgba(255, 255, 255, .38);
  --pin: #f2b632;
}
.card[data-weather="sunny"][data-mods~="partly"] { --cloud: rgba(255, 255, 255, .62); }
.card[data-weather="rain"] {
  --sky-a: #5b6370; --sky-b: #30353f;
  --ink: #ffffff; --ink-soft: rgba(255, 255, 255, .72);
  --cloud: rgba(158, 164, 186, .52);
  --tile: rgba(255, 255, 255, .1); --tile-line: rgba(255, 255, 255, .2);
  --pin: #8fb6ff;
}
.card[data-weather="rain"][data-mods~="pouring"] { --sky-a: #4d5461; --sky-b: #262a33; }
.card[data-weather="thunder"] {
  --sky-a: #414652; --sky-b: #1c1f27;
  --ink: #ffffff; --ink-soft: rgba(255, 255, 255, .72);
  --cloud: rgba(134, 139, 160, .46);
  --tile: rgba(255, 255, 255, .08); --tile-line: rgba(255, 255, 255, .17);
  --pin: #f6c445;
}
.card[data-weather="snow"] {
  --sky-a: #a9b7cd; --sky-b: #e7ecf3;
  --ink: #1a2640; --ink-soft: rgba(26, 38, 64, .68);
  --cloud: rgba(255, 255, 255, .9);
  --tile: rgba(255, 255, 255, .3); --tile-line: rgba(255, 255, 255, .55);
  --pin: #f2b632;
}
.card[data-weather="night"] {
  --sky-a: #2a3658; --sky-b: #0e1322;
  --ink: #ffffff; --ink-soft: rgba(255, 255, 255, .7);
  --cloud: rgba(140, 150, 185, .2);
  --tile: rgba(255, 255, 255, .08); --tile-line: rgba(255, 255, 255, .16);
  --pin: #c9d6ff;
}
.card[data-weather="night"][data-mods~="partly"] { --cloud: rgba(150, 160, 195, .45); }
.card[data-mods~="windy"] { --drift: .33; }

/* after sunset: darker variants of the day scenes */
.card[data-night][data-weather="cloudy"] {
  --sky-a: #4a5874; --sky-b: #222a3c;
  --ink: #ffffff; --ink-soft: rgba(255, 255, 255, .72);
  --cloud: rgba(165, 175, 200, .42);
  --tile: rgba(255, 255, 255, .1); --tile-line: rgba(255, 255, 255, .2);
  --pin: #c9d6ff;
}
.card[data-night][data-weather="rain"] { --sky-a: #3d4452; --sky-b: #1a1d25; }
.card[data-night][data-weather="snow"] {
  --sky-a: #5f6d8a; --sky-b: #a3aec3;
  --ink: #ffffff; --ink-soft: rgba(255, 255, 255, .75);
  --cloud: rgba(225, 230, 242, .7);
  --tile: rgba(255, 255, 255, .14); --tile-line: rgba(255, 255, 255, .3);
  --pin: #c9d6ff;
}

/* ---------- sky ---------- */
canvas.sky { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; display: block; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- header ---------- */
.top { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 12px); min-width: 0; flex: none; }
.place {
  display: flex; align-items: center; gap: calc(var(--u) * 7px); min-width: 0;
  font-weight: 600; font-size: max(12px, calc(var(--u) * 15px)); letter-spacing: .01em;
  border-radius: 8px;
}
.place .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.place svg { width: .95em; height: .95em; fill: var(--pin); transition: fill .6s; flex: none; }
.right { display: flex; align-items: center; gap: calc(var(--u) * 8px); flex: none; }
.place[hidden], .top[hidden] { display: none; }
.top .right { margin-left: auto; }
.snd {
  width: max(24px, calc(var(--u) * 30px)); height: max(24px, calc(var(--u) * 30px));
  border-radius: 50%;
  display: grid; place-items: center;
  background: var(--tile);
  box-shadow: 0 0 0 1px var(--tile-line) inset;
  color: var(--ink);
  transition: background .2s, color .2s, transform .15s;
}
.snd[hidden] { display: none; }
.snd:active { transform: scale(.94); }
.snd[aria-pressed="true"] { background: #fff; color: var(--sel-ink); }
.snd svg { width: 55%; height: 55%; fill: currentColor; }
.snd .on, .snd[aria-pressed="true"] .off { display: none; }
.snd[aria-pressed="true"] .on { display: block; }

/* ---------- current ---------- */
.now {
  position: relative; flex: 1 1 auto;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: end;
  column-gap: calc(var(--u) * 12px);
  min-height: calc(var(--u) * 190px);
}
.now .temp { grid-column: 1; grid-row: 1; }
.now .cond { grid-column: 1; grid-row: 2; }
/* clock on the right of the temperature, the date under it beside the condition */
.clock {
  grid-column: 2; grid-row: 1; align-self: start; justify-self: end;
  margin-top: calc(var(--u) * 6px);
  font-size: calc(var(--u) * 34px); font-weight: 600; line-height: 1; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.clock .ampm { font-size: .42em; font-weight: 600; letter-spacing: .02em; margin-left: .2em; color: var(--ink-soft); transition: color .5s; }
.date {
  grid-column: 2; grid-row: 2; align-self: baseline; justify-self: end;
  margin: calc(var(--u) * 10px) 0 calc(var(--u) * 2px);
  font-size: max(11px, calc(var(--u) * 13px)); font-weight: 500; white-space: nowrap;
  color: var(--ink-soft); transition: color .5s;
}
.clock[hidden], .date[hidden] { display: none; }
.card.tappable .now, .card.tappable .place { cursor: pointer; }
.card:not(.tappable) .place { cursor: default; }
.temp {
  display: flex; align-items: flex-start;
  font-size: calc(var(--u) * 78px); font-weight: 700; line-height: .95; letter-spacing: -.035em;
  font-variant-numeric: tabular-nums;
  margin: 0;
}
.temp .deg { font-size: .385em; font-weight: 500; letter-spacing: 0; margin: .05em 0 0 .03em; }
.temp .lo {
  align-self: flex-end;
  font-size: .3em; font-weight: 600; letter-spacing: 0;
  color: var(--ink-soft);
  margin: 0 0 .25em .35em;
  transition: color .5s;
}
.temp .lo[hidden] { display: none; }
.cond {
  margin: calc(var(--u) * 10px) 0 calc(var(--u) * 2px);
  font-size: max(13px, calc(var(--u) * 20px)); font-weight: 600;
}

@keyframes drop {
  0% { transform: translateY(-5px); opacity: 0; }
  25% { opacity: 1; }
  100% { transform: translateY(12px); opacity: 0; }
}
@keyframes flake {
  0% { transform: translate(0, -5px); opacity: 0; }
  30% { opacity: 1; }
  100% { transform: translate(3px, 12px); opacity: 0; }
}

/* ---------- stats ---------- */
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--u) * 8px); margin: 0; flex: none; }
.stat {
  padding: calc(var(--u) * 11px) calc(var(--u) * 12px) calc(var(--u) * 12px);
  border-radius: calc(var(--u) * 16px);
  background: var(--tile);
  box-shadow: 0 0 0 1px var(--tile-line) inset;
  transition: background .6s, box-shadow .6s;
  min-width: 0;
}
.stat dt {
  font-size: max(8px, calc(var(--u) * 9px)); font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
  color: var(--ink-soft); transition: color .5s;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stat dd { margin: calc(var(--u) * 5px) 0 0; font-size: max(12px, calc(var(--u) * 16px)); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat small { font-size: max(8px, calc(var(--u) * 9px)); font-weight: 500; margin-left: 2px; color: var(--ink-soft); }

/* ---------- days ---------- */
.days { display: grid; grid-template-columns: repeat(var(--n, 5), 1fr); gap: calc(var(--u) * 6px); flex: none; }
.days[hidden] { display: none; }
.day {
  display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 5px);
  padding: calc(var(--u) * 10px) 0 calc(var(--u) * 9px);
  border-radius: calc(var(--u) * 15px);
  background: var(--tile);
  color: var(--ink);
  min-width: 0;
  text-align: center;
  transition: background .35s ease, color .35s ease, transform .35s cubic-bezier(.3, 1.4, .5, 1), box-shadow .35s ease;
}
.day:hover { background: var(--tile-line); }
.day .d-name { font-size: max(9.5px, calc(var(--u) * 11px)); font-weight: 500; white-space: nowrap; overflow: hidden; max-width: 100%; }
.day .d-temp { font-size: max(10px, calc(var(--u) * 11.5px)); font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.day svg.mini {
  width: max(22px, calc(var(--u) * 30px)); height: max(22px, calc(var(--u) * 30px));
  overflow: visible;
  filter: drop-shadow(0 2px 3px rgba(10, 16, 32, .28));
}
.mini .m-rays { transform-box: fill-box; transform-origin: center; animation: spin 24s linear infinite; }
.mini .m-cloud { fill: #fff; transition: fill .35s; }
.mini .m-cloud2 { fill: #dfe6f0; transition: fill .35s; }
.mini .m-rain line { stroke: #fff; stroke-width: 6; stroke-linecap: round; animation: drop 1.1s linear infinite; }
.mini .m-rain line:nth-child(2) { animation-delay: -.4s; }
.mini .m-rain line:nth-child(3) { animation-delay: -.75s; }
.mini .m-bolt { fill: #f6c445; animation: flicker 2.6s ease-in-out infinite; }
.mini .m-snow circle { fill: #fff; animation: flake 2.4s ease-in-out infinite; }
.mini .m-snow circle:nth-child(2) { animation-delay: -.8s; }
.mini .m-snow circle:nth-child(3) { animation-delay: -1.6s; }
.mini .m-fog path, .mini .m-wind path { fill: none; stroke: #fff; stroke-width: 7; stroke-linecap: round; animation: sway 3.2s ease-in-out infinite alternate; }
/* on the white selected pill, white parts get a soft tint so they stay visible */
.day[aria-pressed="true"] .mini .m-cloud { fill: #e2e8f1; }
.day[aria-pressed="true"] .mini .m-cloud2 { fill: #c9d3e1; }
.day[aria-pressed="true"] .mini .m-rain line { stroke: #6f9fe8; }
.day[aria-pressed="true"] .mini .m-snow circle { fill: #b4c3d8; }
.day[aria-pressed="true"] .mini .m-fog path, .day[aria-pressed="true"] .mini .m-wind path { stroke: #b4c3d8; }
@keyframes flicker { 0%, 40%, 48%, 56%, 100% { opacity: 1; } 44%, 52% { opacity: .35; } }
@keyframes sway { from { transform: translateX(-4px); } to { transform: translateX(4px); } }
.day[aria-pressed="true"] {
  background: #fff;
  color: var(--sel-ink);
  transform: translateY(calc(var(--u) * -5px));
  box-shadow: 0 10px 18px -8px rgba(8, 12, 24, .55);
}

/* ---------- too little height: drop parts instead of clipping ---------- */
.card.tight-1 .stats { display: none; }
.card.tight-2 .days { display: none; }
.card.tight-1 .now, .card.tight-2 .now { min-height: 0; }

/* ---------- compact view ----------
   Temperature and icon at about half size, the card starts at the temperature
   (no empty sky above it) and the tiles and pills are tighter. With a fixed
   height (sections view) any spare room goes below the condition, not above. */
.card.compact { padding: calc(var(--u) * 14px); gap: calc(var(--u) * 9px); }
.card.compact .now { min-height: 0; align-content: start; }
.card.compact .clock { font-size: calc(var(--u) * 22px); margin-top: calc(var(--u) * 3px); }
.card.compact .date { margin-top: calc(var(--u) * 4px); font-size: max(10.5px, calc(var(--u) * 11.5px)); }
.card.compact .temp { font-size: calc(var(--u) * 40px); }
.card.compact .cond { margin: calc(var(--u) * 4px) 0 0; font-size: max(12px, calc(var(--u) * 15px)); }
.card.compact .stats { gap: calc(var(--u) * 6px); }
.card.compact .stat {
  display: flex; align-items: baseline; justify-content: space-between; gap: 4px;
  padding: calc(var(--u) * 7px) calc(var(--u) * 9px);
  border-radius: calc(var(--u) * 12px);
}
.card.compact .stat dt { font-size: max(8px, calc(var(--u) * 7.5px)); letter-spacing: .04em; flex: 0 1 auto; min-width: 0; }
.card.compact .stat dd { margin: 0; font-size: max(12px, calc(var(--u) * 14px)); flex: none; }
.card.compact .days { gap: calc(var(--u) * 5px); }
.card.compact .day { gap: calc(var(--u) * 3px); padding: calc(var(--u) * 6px) 0 calc(var(--u) * 6px); border-radius: calc(var(--u) * 12px); }
.card.compact .day svg.mini { width: max(18px, calc(var(--u) * 24px)); height: max(18px, calc(var(--u) * 24px)); }
.card.compact .day[aria-pressed="true"] { transform: translateY(calc(var(--u) * -3px)); }

/* ---------- static / reduced motion ---------- */
.card.static, .card.static *, .card.static *::before, .card.static *::after {
  animation: none !important;
  transition-duration: .01ms !important;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition-duration: .01ms !important; }
}
`;

const DEFAULTS = {
    forecast_type: 'daily',
    days: 5,
    show_clock: true,
    show_location: true,
    compact_view: false,
    animations: true,
    sound: false,
};

class GlassWeatherCard extends HTMLElement {
    /* ---------- editor / picker ---------- */

    static getStubConfig(hass, entities, entitiesFallback) {
        const pick = (list) => (list || []).find((e) => typeof e === 'string' && e.startsWith('weather.'));
        const entity = pick(entities) || pick(entitiesFallback) || Object.keys(hass?.states || {}).find((e) => e.startsWith('weather.')) || '';
        return { entity, days: 5, show_clock: true, show_location: true, compact_view: false, animations: true, sound: false };
    }

    static getConfigForm() {
        const LABELS = {
            entity: 'Weather entity',
            name: 'Name',
            forecast_type: 'Forecast',
            days: 'Days in the row (0 hides it)',
            show_clock: 'Show clock',
            show_location: 'Show location',
            compact_view: 'Compact view',
            temperature_entity: 'Current temperature sensor (optional)',
            animations: 'Animations',
            sound: 'Sound button',
            border_radius: 'Corner radius',
            height: 'Height (optional, e.g. 480px)',
            tap_action: 'Tap action',
        };
        return {
            schema: [
                { name: 'entity', required: true, selector: { entity: { domain: 'weather' } } },
                { name: 'name', selector: { text: {} } },
                { name: 'temperature_entity', selector: { entity: { domain: ['sensor', 'input_number', 'number'] } } },
                {
                    type: 'grid',
                    name: '',
                    schema: [
                        {
                            name: 'forecast_type',
                            selector: {
                                select: {
                                    mode: 'dropdown',
                                    options: [
                                        { value: 'daily', label: 'Daily' },
                                        { value: 'twice_daily', label: 'Twice daily' },
                                    ],
                                },
                            },
                        },
                        { name: 'days', selector: { number: { min: 0, max: 7, mode: 'box' } } },
                    ],
                },
                {
                    type: 'grid',
                    name: '',
                    schema: [
                        { name: 'show_clock', default: true, selector: { boolean: {} } },
                        { name: 'show_location', default: true, selector: { boolean: {} } },
                        { name: 'compact_view', default: false, selector: { boolean: {} } },
                        { name: 'animations', default: true, selector: { boolean: {} } },
                        { name: 'sound', default: false, selector: { boolean: {} } },
                        { name: 'border_radius', selector: { number: { min: 0, max: 48, mode: 'box', unit_of_measurement: 'px' } } },
                    ],
                },
                { name: 'height', selector: { text: {} } },
                { name: 'tap_action', selector: { ui_action: {} } },
            ],
            computeLabel: (schema) => LABELS[schema.name],
            computeHelper: (schema) =>
                schema.name === 'sound' ? 'Shows a button that plays synthesised rain, wind and thunder. Audio starts only on click.'
                    : schema.name === 'temperature_entity' ? 'Shown as the current temperature instead of the weather entity\'s value. Forecast days are unchanged.'
                    : schema.name === 'compact_view' ? 'Smaller temperature and icon, about half size.'
                    : schema.name === 'height' ? 'Leave empty to size with the dashboard. In sections view, resize the card instead.'
                    : undefined,
            assertConfig: (config) => GlassWeatherCard._validate(config),
        };
    }

    static _validate(config) {
        if (!config || typeof config.entity !== 'string' || !config.entity.startsWith('weather.')) {
            throw new Error('glass-weather-card: `entity` must be a weather entity, e.g. weather.home');
        }
        if (config.forecast_type && !['daily', 'twice_daily'].includes(config.forecast_type)) {
            throw new Error('glass-weather-card: `forecast_type` must be daily or twice_daily');
        }
        if (config.temperature_entity !== undefined && config.temperature_entity !== '' &&
            (typeof config.temperature_entity !== 'string' || !config.temperature_entity.includes('.'))) {
            throw new Error('glass-weather-card: `temperature_entity` must be an entity id, e.g. sensor.outdoor_temperature');
        }
    }

    /* ---------- lifecycle ---------- */

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = TEMPLATE(STYLE);
        const $ = (s) => root.querySelector(s);
        this._els = {
            card: $('.card'),
            name: $('.name'),
            place: $('.place'),
            top: $('.top'),
            clock: $('.clock'),
            date: $('.date'),
            snd: $('.snd'),
            now: $('.now'),
            temp: $('.temp .t'),
            lo: $('.temp .lo'),
            cond: $('.cond'),
            days: $('.days'),
            lFeels: $('.l-feels'),
            lHum: $('.l-hum'),
            lWind: $('.l-wind'),
            feels: $('.v-feels'),
            hum: $('.v-hum'),
            wind: $('.v-wind'),
            uFeels: $('.u-feels'),
            uWind: $('.u-wind'),
        };
        this._sky = new SkyRenderer($('canvas.sky'), () => this._onStrike());
        this._audio = new Ambience();
        this._shown = {};           // values currently on screen, for tweens
        this._slots = [];
        this._index = 0;
        this._selKey = 'now';
        this._visible = true;
        this._reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');

        this._onVisibility = () => this._syncActive();
        this._onReducedChange = () => this._applyStatic();

        this._els.days.addEventListener('click', (e) => {
            const b = e.target.closest('button.day');
            if (!b) return;
            this._select(Number(b.dataset.i), true);
        });
        this._els.days.addEventListener('keydown', (e) => this._onDaysKey(e));
        this._els.place.addEventListener('click', () => this._fireTap());
        this._els.now.addEventListener('click', () => this._fireTap());
        this._els.snd.addEventListener('click', async (e) => {
            e.stopPropagation();
            const on = await this._audio.toggle();
            this._els.snd.setAttribute('aria-pressed', String(on));
        });
    }

    connectedCallback() {
        this._connected = true;
        this._ro = new ResizeObserver(() => {
            cancelAnimationFrame(this._layoutRaf);
            this._layoutRaf = requestAnimationFrame(() => {
                this._layout();
                this._sky.resize();
            });
        });
        this._ro.observe(this._els.card);
        this._io = new IntersectionObserver((entries) => {
            this._visible = entries.some((e) => e.isIntersecting);
            this._syncActive();
        });
        this._io.observe(this);
        document.addEventListener('visibilitychange', this._onVisibility);
        this._reduced?.addEventListener?.('change', this._onReducedChange);
        this._startClock();
        this._applyStatic();
        if (this._hass && this._config) {
            this._ensureSubscription();
            this._render();
        }
        this._syncActive();
    }

    disconnectedCallback() {
        this._connected = false;
        this._unsubscribe();
        this._ro?.disconnect();
        this._io?.disconnect();
        this._ro = this._io = null;
        document.removeEventListener('visibilitychange', this._onVisibility);
        this._reduced?.removeEventListener?.('change', this._onReducedChange);
        cancelAnimationFrame(this._layoutRaf);
        clearInterval(this._clockTimer);
        clearTimeout(this._idleTimer);
        this._clockTimer = this._idleTimer = 0;
        this._sky.setActive(false);
        this._audio.close();
        this._els.snd.setAttribute('aria-pressed', 'false');
    }

    setConfig(config) {
        GlassWeatherCard._validate(config);
        const days = Math.max(0, Math.min(7, Math.round(Number(config.days ?? DEFAULTS.days)) || 0));
        this._config = { ...DEFAULTS, ...config, days };

        const radius = Number(this._config.border_radius);
        if (this._config.border_radius !== undefined && this._config.border_radius !== '' && !isNaN(radius)) {
            this.style.setProperty('--gwc-radius', `${radius}px`);
        } else {
            this.style.removeProperty('--gwc-radius');
        }
        const h = this._config.height;
        if (h !== undefined && h !== null && h !== '') {
            this.style.setProperty('--gwc-height', isNum(h) ? `${h}px` : String(h));
        } else {
            this.style.removeProperty('--gwc-height');
        }
        this._els.clock.hidden = !this._config.show_clock;
        this._els.date.hidden = !this._config.show_clock;
        this._els.place.hidden = this._config.show_location === false;
        this._els.top.hidden = this._config.show_location === false && !this._config.sound;
        this._els.card.classList.toggle('compact', !!this._config.compact_view);
        this._els.snd.hidden = !this._config.sound;
        if (!this._config.sound && this._audio.on) {
            this._audio.close();
            this._els.snd.setAttribute('aria-pressed', 'false');
        }
        this._els.card.classList.toggle('tappable', (this._config.tap_action?.action ?? 'more-info') !== 'none');
        this._applyStatic();

        if (this._hass) {
            if (this._connected) this._ensureSubscription();
            this._lastSig = null;
            this._render();
            this._tickClock();
        }
        if (this._connected) this._layout();
    }

    set hass(hass) {
        const prev = this._hass;
        this._hass = hass;
        if (!this._config) return;
        const id = this._config.entity;
        if (this._connected) this._ensureSubscription();
        if (
            !prev ||
            prev.states[id] !== hass.states[id] ||
            (this._config.temperature_entity && prev.states[this._config.temperature_entity] !== hass.states[this._config.temperature_entity]) ||
            prev.states['sun.sun']?.state !== hass.states['sun.sun']?.state ||
            prev.locale !== hass.locale ||
            prev.localize !== hass.localize
        ) {
            if (!prev || prev.locale !== hass.locale) this._tickClock();
            this._render();
        }
    }

    get hass() {
        return this._hass;
    }

    getCardSize() {
        const h = this._els.card.offsetHeight;
        return h ? Math.max(1, Math.ceil(h / 50)) : 9;
    }

    // Default: full section width. No min/max, the user can resize it to anything.
    // Compact view has no fixed height: it is as tall as its content.
    getGridOptions() {
        if (this._config?.compact_view) return { columns: 12, rows: 'auto' };
        return { columns: 12, rows: 8 };
    }

    /* Scale everything from the real width (340 px = 1). When the height is set
       from outside (sections view, \`height\` option) and the content doesn't fit,
       shrink; below the smallest scale drop the stat tiles, then the day row. */
    _layout() {
        const card = this._els.card;
        const w = card.clientWidth;
        if (!w) return;
        let u = Math.min(1.6, Math.max(0.7, w / 340));
        card.style.setProperty('--u', u.toFixed(3));
        card.classList.remove('tight-1', 'tight-2');
        for (let pass = 0; pass < 5; pass++) {
            const over = card.scrollHeight - card.clientHeight;
            if (over <= 1) break;
            if (u > 0.701) {
                u = Math.max(0.7, u * (card.clientHeight / card.scrollHeight) * 0.98);
                card.style.setProperty('--u', u.toFixed(3));
            } else if (!card.classList.contains('tight-1')) {
                card.classList.add('tight-1');
            } else {
                card.classList.add('tight-2');
            }
        }
    }

    /* ---------- running state ---------- */

    get _static() {
        return this._config?.animations === false || !!this._reduced?.matches;
    }

    _live() {
        return this._connected && this._visible && !document.hidden && !this._static;
    }

    _applyStatic() {
        const s = this._static;
        this._els.card.classList.toggle('static', s);
        this._sky.setStatic(s);
        this._syncActive();
    }

    _syncActive() {
        this._sky.setActive(!!(this._connected && this._visible && !document.hidden));
    }

    /* ---------- forecast subscription ---------- */

    _forecastType(stateObj) {
        if (!stateObj) return null;
        const f = Number(stateObj.attributes?.supported_features) || 0;
        const order = this._config.forecast_type === 'twice_daily' ? ['twice_daily', 'daily'] : ['daily', 'twice_daily'];
        const bit = { daily: FEATURE_DAILY, twice_daily: FEATURE_TWICE_DAILY };
        return order.find((t) => f & bit[t]) || null;
    }

    _ensureSubscription() {
        if (!this._hass || !this._config) return;
        const type = this._config.days > 0 ? this._forecastType(this._hass.states[this._config.entity]) : null;
        const key = `${this._config.entity}|${type}`;
        if (key === this._subKey) return;
        this._unsubscribe();
        this._subKey = key;
        this._forecast = null;
        this._fcType = type;
        if (!type) return;
        const token = {};
        this._subToken = token;
        const p = this._hass.connection.subscribeMessage(
            (ev) => {
                if (this._subToken !== token) return;
                this._forecast = Array.isArray(ev?.forecast) ? ev.forecast : [];
                this._render();
            },
            { type: 'weather/subscribe_forecast', forecast_type: type, entity_id: this._config.entity },
        );
        this._unsubP = p;
        p.catch((err) => {
            if (this._subToken !== token) return;
            console.warn(`${TAG}: forecast subscription failed for ${this._config.entity}`, err);
            this._forecast = [];
            this._render();
        });
    }

    _unsubscribe() {
        if (this._unsubP) this._unsubP.then((unsub) => typeof unsub === 'function' && unsub()).catch(() => {});
        this._unsubP = null;
        this._subKey = null;
        this._subToken = null;
    }

    /* ---------- locale helpers ---------- */

    _lang() {
        return this._hass?.locale?.language || this._hass?.language || navigator.language;
    }

    _timeZone() {
        const l = this._hass?.locale;
        return l?.time_zone === 'server' ? this._hass?.config?.time_zone : undefined;
    }

    _fmt(opts) {
        try {
            return new Intl.DateTimeFormat(this._lang(), { ...opts, timeZone: this._timeZone() });
        } catch (e) {
            return new Intl.DateTimeFormat(undefined, opts);
        }
    }

    _dayKey(date) {
        // yyyy-mm-dd in the display time zone (sortable, independent of locale part order)
        const parts = {};
        for (const p of this._fmt({ year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn' }).formatToParts(date)) {
            parts[p.type] = p.value;
        }
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    _labels() {
        const hass = this._hass;
        const st = hass.states[this._config.entity];
        const lang = this._lang();
        if (!st || !hass.formatEntityAttributeName || /^en\b/i.test(lang)) {
            return { feels: 'Feels', hum: 'Humidity', wind: 'Wind' };
        }
        return {
            feels: hass.formatEntityAttributeName(st, 'apparent_temperature') || 'Feels',
            hum: hass.formatEntityAttributeName(st, 'humidity') || 'Humidity',
            wind: hass.formatEntityAttributeName(st, 'wind_speed') || 'Wind',
        };
    }

    _condLabel(st, condition) {
        const hass = this._hass;
        if (st && hass.formatEntityState) {
            try {
                return condition === undefined ? hass.formatEntityState(st) : hass.formatEntityState(st, condition);
            } catch (e) { /* fall through */ }
        }
        const key = condition ?? st?.state;
        return hass.localize?.(`component.weather.entity_component._.state.${key}`) ||
            String(key || '').replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
    }

    /* ---------- clock ---------- */

    _startClock() {
        clearInterval(this._clockTimer);
        this._tickClock();
        this._clockTimer = setInterval(() => this._tickClock(), 15000);
    }

    _tickClock() {
        if (!this._config?.show_clock) return;
        const tf = this._hass?.locale?.time_format;
        const opts = { hour: 'numeric', minute: '2-digit' };
        if (tf === '12') opts.hour12 = true;
        else if (tf === '24') opts.hour12 = false;
        let f;
        try {
            f = tf === 'system'
                ? new Intl.DateTimeFormat(undefined, { ...opts, timeZone: this._timeZone() })
                : this._fmt(opts);
        } catch (e) {
            f = new Intl.DateTimeFormat(undefined, opts);
        }
        const now = new Date();
        // hour:minute big, the AM/PM marker (12 h) small
        let main = '';
        let period = '';
        for (const part of f.formatToParts(now)) {
            if (part.type === 'dayPeriod') period += part.value;
            else main += part.value;
        }
        this._els.clock.innerHTML = `${esc(main.trim())}${period ? `<span class="ampm">${esc(period)}</span>` : ''}`;
        this._els.clock.dateTime = now.toISOString();
    }

    /* ---------- data → slots ---------- */

    // Current temperature: the optional sensor if it has a number, else the weather entity.
    // Converted to the weather entity's unit when the two differ (°C ↔ °F).
    _currentTemp(a) {
        const id = this._config.temperature_entity;
        const ext = id ? this._hass.states[id] : null;
        if (!ext || !isNum(ext.state)) return a.temperature;
        let v = Number(ext.state);
        const from = ext.attributes?.unit_of_measurement || '';
        const to = a.temperature_unit || '';
        if (/F/i.test(from) && /C/i.test(to)) v = ((v - 32) * 5) / 9;
        else if (/C/i.test(from) && /F/i.test(to)) v = (v * 9) / 5 + 32;
        return v;
    }

    _buildSlots(st) {
        const a = st?.attributes || {};
        const sunDown = this._hass.states['sun.sun']?.state === 'below_horizon';
        const now = new Date();
        const temp = this._currentTemp(a);
        const slots = [{
            key: 'now',
            date: now,
            condition: st?.state,
            temp,
            lo: null,
            feels: isNum(a.apparent_temperature)
                ? a.apparent_temperature
                : apparentTemperature(temp, a.humidity, a.wind_speed, a.temperature_unit, a.wind_speed_unit),
            hum: a.humidity,
            wind: a.wind_speed,
            night: sunDown,
            current: true,
        }];
        const fc = this._forecast;
        const want = this._config.days;
        if (!fc || !fc.length || want < 2 || !st || st.state === 'unavailable') return slots;

        const today = this._dayKey(now);
        const seen = new Set([today]);
        for (let i = 0; i < fc.length && slots.length < want; i++) {
            const f = fc[i];
            if (!f || !f.datetime) continue;
            if (this._fcType === 'twice_daily' && f.is_daytime === false) continue;
            const d = new Date(f.datetime);
            const key = this._dayKey(d);
            if (seen.has(key) || key < today) continue;
            seen.add(key);
            let lo = f.templow;
            if (!isNum(lo) && this._fcType === 'twice_daily') {
                const night = fc[i + 1];
                if (night && night.is_daytime === false && isNum(night.temperature)) lo = night.temperature;
            }
            slots.push({
                key,
                date: d,
                condition: f.condition,
                temp: f.temperature,
                lo,
                feels: isNum(f.apparent_temperature)
                    ? f.apparent_temperature
                    : apparentTemperature(f.temperature, f.humidity, f.wind_speed, a.temperature_unit, a.wind_speed_unit),
                hum: f.humidity,
                wind: f.wind_speed,
                night: false,
                current: false,
            });
        }
        return slots;
    }

    /* ---------- render ---------- */

    _render() {
        if (!this._hass || !this._config) return;
        const hass = this._hass;
        const st = hass.states[this._config.entity];
        const a = st?.attributes || {};

        this._els.name.textContent = this._config.name || a.friendly_name || this._config.entity;
        const labels = this._labels();
        this._els.lFeels.textContent = labels.feels;
        this._els.lHum.textContent = labels.hum;
        this._els.lWind.textContent = labels.wind;
        this._els.uWind.textContent = a.wind_speed_unit || '';
        this._els.uFeels.textContent = '°';
        this._els.uFeels.title = this._els.temp.title = a.temperature_unit || '';

        const slots = this._buildSlots(st);
        this._slots = slots;
        let index = slots.findIndex((s) => s.key === this._selKey);
        if (index < 0) index = 0;

        // Day row: only when there is a forecast to choose from.
        const daysEl = this._els.days;
        const showRow = slots.length > 1;
        daysEl.hidden = !showRow;
        if (showRow) {
            const dayFmt = this._fmt({ weekday: 'short' });
            const sig = slots.map((s) => `${s.key}|${s.condition}|${s.night}|${isNum(s.temp) ? Math.round(s.temp) : '-'}`).join(',') + dayFmt.resolvedOptions().locale;
            if (sig !== this._rowSig) {
                this._rowSig = sig;
                daysEl.style.setProperty('--n', slots.length);
                daysEl.setAttribute('aria-label', 'Choose a day');
                daysEl.innerHTML = slots.map((s, i) => {
                    const name = dayFmt.format(s.date);
                    const t = isNum(s.temp) ? `${num(Math.round(s.temp))}°` : '–';
                    const label = `${name}: ${this._condLabel(st, s.condition)}, ${t}`;
                    return `<button type="button" class="day" data-i="${i}" aria-pressed="false" tabindex="-1" aria-label="${esc(label)}">` +
                        `<span class="d-name">${esc(name)}</span>` +
                        miniIcon(s.condition, s.night) +
                        `<span class="d-temp">${esc(t)}</span></button>`;
                }).join('');
            }
        } else {
            this._rowSig = null;
            daysEl.innerHTML = '';
        }

        this._show(index, false);
        if (this._connected && showRow !== this._rowShown) {
            this._rowShown = showRow;
            this._layout();
        }
    }

    _select(index, user) {
        const n = this._slots.length;
        if (!n) return;
        index = ((index % n) + n) % n;
        this._selKey = this._slots[index].key;
        this._show(index, true);
        if (user) {
            clearTimeout(this._idleTimer);
            this._idleTimer = index === 0 ? 0 : setTimeout(() => {
                this._idleTimer = 0;
                this._select(0, false);
            }, 30000);
        }
    }

    _onDaysKey(e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const n = this._slots.length;
        let i = this._index;
        if (e.key === 'ArrowRight') i += 1;
        else if (e.key === 'ArrowLeft') i -= 1;
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = n - 1;
        else return;
        e.preventDefault();
        this._select(i, true);
        this._els.days.querySelectorAll('button.day')[this._index]?.focus();
    }

    _show(index, fromUser) {
        const slot = this._slots[index];
        if (!slot) return;
        const st = this._hass.states[this._config.entity];
        const first = this._lastSig == null;
        this._index = index;

        // pills (roving tabindex: one tab stop for the whole row)
        this._els.days.querySelectorAll('button.day').forEach((b, i) => {
            b.setAttribute('aria-pressed', String(i === index));
            b.tabIndex = i === index ? 0 : -1;
        });

        // scene
        const def = CONDITIONS[slot.condition] || FALLBACK;
        let scene = def.scene;
        const mods = [...(def.mods || [])];
        let nightTint = false;
        if (slot.night) {
            if (scene === 'sunny') scene = 'night';
            else if (NIGHT_TINTED.has(scene)) nightTint = true;
        }
        const card = this._els.card;
        card.dataset.weather = scene;
        card.dataset.mods = mods.join(' ');
        card.toggleAttribute('data-night', nightTint);

        const mix = { ...MIX[scene] };
        for (const m of mods) Object.assign(mix, MOD_MIX[m] || {});

        const sceneSig = `${slot.condition}|${slot.night}`;
        if (sceneSig !== this._sceneSig) {
            this._sceneSig = sceneSig;
            this._scene = scene;
            this._sky.setScene(skyScene(slot.condition, slot.night), first);
            this._audio.setMix(mix);
        }

        // numbers
        const animate = !first && !this._static;
        this._tween('temp', this._els.temp, slot.temp, animate);
        this._tween('feels', this._els.feels, slot.feels, animate);
        this._tween('hum', this._els.hum, slot.hum, animate);
        this._tween('wind', this._els.wind, slot.wind, animate);
        // date beside the condition: the selected day (today for "now")
        this._els.date.textContent = this._fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(slot.date);
        const lo = this._els.lo;
        lo.hidden = slot.current || !isNum(slot.lo);
        lo.textContent = isNum(slot.lo) ? `/ ${num(Math.round(slot.lo))}°` : '';

        // condition label
        const label = st ? this._condLabel(st, slot.current ? undefined : slot.condition) : this._condLabel(null, 'unavailable');
        if (label !== this._els.cond.textContent) {
            this._els.cond.textContent = label;
            if (fromUser && animate && this._els.cond.animate) {
                this._els.cond.animate(
                    [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
                    { duration: 380, easing: 'cubic-bezier(.2,.8,.3,1)' },
                );
            }
        }

        this._lastSig = `${index}|${sceneSig}`;
    }

    _tween(key, el, value, animate) {
        const to = isNum(value) ? Math.round(Number(value)) : null;
        const from = this._shown[key];
        this._shown[key] = to;
        if (to === null) {
            el.textContent = '–';
            return;
        }
        if (!animate || from === null || from === undefined || from === to) {
            el.textContent = num(to);
            return;
        }
        const t0 = performance.now();
        const dur = 480;
        const step = (now) => {
            if (this._shown[key] !== to) return; // a newer tween took over
            const p = Math.min(1, (now - t0) / dur);
            const e = 1 - Math.pow(1 - p, 3);
            el.textContent = num(Math.round(from + (to - from) * e));
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /* ---------- lightning ---------- */

    // Called by the sky on every strike: play thunder (when sound is on).
    _onStrike() {
        this._audio.thunder();
    }

    /* ---------- tap action ---------- */

    _fireTap() {
        const action = this._config?.tap_action || { action: 'more-info' };
        if (action.action === 'none') return;
        this.dispatchEvent(new CustomEvent('hass-action', {
            bubbles: true,
            composed: true,
            detail: { config: { entity: this._config.entity, tap_action: action }, action: 'tap' },
        }));
    }
}

if (!customElements.get(TAG)) {
    customElements.define(TAG, GlassWeatherCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: TAG,
        name: 'Glass Weather Card',
        description: 'A glass weather card whose sky follows the weather. Tap a day to switch the scene to its forecast.',
        preview: true,
        getEntitySuggestion: (hass, entityId) =>
            typeof entityId === 'string' && entityId.startsWith('weather.')
                ? { config: { type: `custom:${TAG}`, entity: entityId } }
                : null,
    });
    console.info(`%c GLASS-WEATHER-CARD %c v${VERSION} `, 'color:#fff;background:#4d83e4;font-weight:700', 'color:#4d83e4;background:#fff');
}
