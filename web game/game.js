/* =============================================================================
   FLY SOULS · Boss fight cliente (Three.js r128)  ·  v2
   -----------------------------------------------------------------------------
   Índice
     1. CONFIG ............ todos los números ajustables
     2. Utilidades
     3. Input ............. teclado y ratón (incluye clic derecho = escudo)
     4. NeuralLink ........ WebSocket, lectura de mean_activity / boss_action_trigger,
                            umbrales de voltaje y modo simulación
     5. HUD
     6. Escena, texturas procedurales (piedra / ladrillo) y partículas
     7. Jugador ........... escudo, Estus, rodar con i-frames, ataque
     8. Jefe .............. 6 ataques, agresividad, poise, reacción al golpe
     9. Proyectiles y ondas expansivas
    10. Sincronización .... estímulo sensorial hacia el backend
    11. Bucle principal ... 60 FPS
   ============================================================================= */
(() => {
"use strict";

/* =============================================================================
   1. CONFIG
   ============================================================================= */
const CONFIG = {
  WS_URL: "ws://localhost:8000/ws",
  RECONNECT_MS: 2000,
  AUTO_MOCK_AFTER_MS: 4000,      // sin datos reales tras este tiempo → simulación local
  ACTION_MAX_AGE_MS: 1500,       // las órdenes de movimiento (approach/retreat) caducan

  SEND_HZ_ACTIVE: 20,
  SEND_HZ_IDLE: 4,
  TARGET_FPS: 60,
  ARENA_RADIUS: 16,
  WALL_RADIUS: 19.5,

  /* ---- Lectura de la red neuronal (700 neuronas) ---- */
  NEURAL: {
    // "auto": normaliza mean_activity a 0..1 con un rango adaptativo (recomendado si el valor
    //         real es pequeño, p. ej. 0.02–0.15, o está en mV).  "unit": ya viene en 0..1.
    ACTIVITY_MODE: "auto",
    MIN_SPAN: 0.05,              // rango mínimo (en unidades crudas) para no amplificar ruido
    RANGE_TAU_S: 20,             // el rango adaptativo "olvida" extremos en ~20 s
    // Umbrales de actividad (ya normalizada). Al CRUZARLOS hacia arriba se dispara un ataque
    // aunque el backend no mande boss_action_trigger. tier = nº de umbrales superados (0..4).
    TIERS: [0.25, 0.45, 0.65, 0.82],
    TIER_HYST: 0.06,             // histéresis para no oscilar en el borde de un umbral
    // boss_action_trigger numérico: "generic" → cualquier valor > 0 = disparo, el ataque lo elige
    // la actividad.  "index" → 1..6 = slash, claws, charge, slam, swarm, nova.
    TRIGGER_NUMBER_MODE: "generic",
    TRIGGER_REPEAT_MS: 1200,     // si el trigger se queda en true, se re-dispara cada 1.2 s
    TRIGGER_TTL_MS: 1500,        // un disparo no atendido caduca
    SPIKE_NORMALIZER: 200,       // compat.: "spikes": N → N / 200
  },

  PLAYER: {
    maxHp: 100, maxStamina: 100,
    speed: 5.2, radius: 0.45,
    roll: { time: 0.45, iFrames: 0.32, speed: 11, cost: 25 },
    staminaRegen: 24, staminaDelay: 0.6,
    attackCost: 18, attackTime: 0.38, attackDamage: 15, attackRange: 3.6, attackPoise: 18,
    staggerTime: 0.35,
    block: {
      cone: 1.25,                // ± 72° frente al jugador
      chip: 0.10,                // 10 % del daño se cuela por el escudo
      staminaPerDmg: 1.3,        // coste de estamina por punto de daño absorbido
      perfectWindow: 0.15,       // "guardia perfecta": bloquear justo al subir el escudo = 0 estamina
      breakStagger: 0.9,         // si la estamina no alcanza → guardia rota
      moveMul: 0.5, regenMul: 0.4,
    },
    estus: { flasks: 3, heal: 45, time: 1.1, healAt: 0.55, moveMul: 0.35 },
  },

  BOSS: {
    maxHp: 650, radius: 2.3,
    approachSpeed: 3.2, retreatSpeed: 2.6, strafeSpeed: 1.4,
    poise: 100, poiseRegen: 14, poiseDelay: 2.2, staggerTime: 1.15,
    enrageAt: 0.5,               // por debajo del 50 % de vida entra en fase 2
    enrageDamageMul: 1.15,
  },

  /* ---- Ataques del jefe (tiempos en segundos; windup = aviso visible) ---- */
  ATTACKS: {
    slash:  { windup: 0.55, strike: 0.20, recover: 0.65, range: 6.4, damage: 22 },                // tajo con embestida corta
    claws:  { windup: 0.42, strike: 0.70, recover: 0.60, range: 5.0, damage: 10, pulses: 3, pulseGap: 0.22 }, // ráfaga de garras
    charge: { windup: 0.75, strike: 0.60, recover: 1.00, minDist: 4, speed: 24, damage: 30 },     // embestida rápida
    slam:   { windup: 0.95, strike: 0.12, recover: 0.95, maxDist: 11, damage: 30, waveSpeed: 14, waveMax: 8.5 }, // golpe de área frontal
    swarm:  { windup: 0.65, strike: 0.10, recover: 0.90, minDist: 5, damage: 8, count: 7, speed: 11 },          // ráfaga de moscas
    nova:   { windup: 1.05, strike: 0.25, recover: 1.10, damage: 22, waveSpeed: 13, waveMax: 10.5, echoDelay: 0.4 }, // explosión de plaga (área total)
  },

  /* ---- Texturas: procedurales por defecto. Para usar imágenes propias pon la ruta
          (se sirven por HTTP, p. ej. "textures/floor.jpg"). Si fallan, se mantiene la procedural. ---- */
  TEXTURES: { floor: null, wall: null, pillar: null },
};
const ATTACK_ORDER = ["slash", "claws", "charge", "slam", "swarm", "nova"];
const DEBUG = /[?&]debug/.test(location.search);   // abre index.html?debug → teclas 1-6 fuerzan ataques

/* =============================================================================
   2. UTILIDADES
   ============================================================================= */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const damp  = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));      // suavizado independiente del FPS
const rand  = (a, b) => a + Math.random() * (b - a);
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const $ = (id) => document.getElementById(id);
const flatNumbers = (x) => {
  if (typeof x === "number") return Number.isFinite(x) ? [x] : [];
  if (Array.isArray(x)) return x.flatMap(flatNumbers);
  if (x && typeof x === "object") return Object.values(x).flatMap(flatNumbers);
  return [];
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

const game = { started: false, t: 0, hitStop: 0 };

/* =============================================================================
   3. INPUT
   ============================================================================= */
const Input = (() => {
  const down = new Set(), pressed = new Set();
  const BLOCK = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  addEventListener("keydown", (e) => {
    if (BLOCK.has(e.code)) e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    down.add(e.code);
  });
  addEventListener("keyup", (e) => down.delete(e.code));
  addEventListener("blur", () => { down.clear(); pressed.clear(); });
  addEventListener("mousedown", (e) => { const c = "Mouse" + e.button; pressed.add(c); down.add(c); });
  addEventListener("mouseup", (e) => down.delete("Mouse" + e.button));
  addEventListener("contextmenu", (e) => e.preventDefault());           // clic derecho = escudo, sin menú

  const any = (...codes) => codes.some((c) => down.has(c));
  return {
    axis() {
      return {
        x: (any("KeyD", "ArrowRight") ? 1 : 0) - (any("KeyA", "ArrowLeft") ? 1 : 0),
        y: (any("KeyW", "ArrowUp") ? 1 : 0) - (any("KeyS", "ArrowDown") ? 1 : 0),
      };
    },
    isDown: any,
    consume(...codes) { let hit = false; for (const c of codes) if (pressed.delete(c)) hit = true; return hit; },
    endFrame() { pressed.clear(); },
  };
})();

/* =============================================================================
   4. NEURALLINK · WebSocket con el servidor Python (conectoma de 700 neuronas)
   -----------------------------------------------------------------------------
   Backend → Frontend (JSON). Solo hace falta mean_activity; el resto es opcional:
     {
       "mean_activity": 0.37,              // actividad media de las 700 neuronas
       "boss_action_trigger": true,        // true/1 = "ataca ya" (el ataque lo elige la actividad)
                                           // o un nombre: "slash" | "claws" | "charge" |
                                           //              "slam" | "swarm" | "nova"
                                           // o "approach" | "retreat" | "idle" (orden de movimiento)
       "voltages": [ ...700 números... ]   // opcional: aporta "caos" (desviación entre neuronas)
     }
   Además, el jefe reacciona SOLO a mean_activity: al cruzar los umbrales CONFIG.NEURAL.TIERS
   hacia arriba se dispara un ataque, y cuanto más alta/volátil es la actividad, más agresivo,
   más variado y más encadenado ataca.
   ============================================================================= */
const ACTION_ALIASES = {
  slash: "slash", swing: "slash", tajo: "slash",
  claws: "claws", claw: "claws", flurry: "claws", garras: "claws",
  charge: "charge", rush: "charge", dash: "charge", embestida: "charge",
  slam: "slam", smash: "slam", stomp: "slam",
  swarm: "swarm", ranged: "swarm", shoot: "swarm", fire: "swarm",
  nova: "nova", aoe: "nova", area: "nova", burst: "nova", explosion: "nova",
  attack: "any", trigger: "any", strike: "any", true: "any", on: "any", "1": "any",
  approach: "approach", chase: "approach", advance: "approach",
  retreat: "retreat", flee: "retreat", back: "retreat",
  idle: "idle", rest: "idle", wait: "idle",
};
const MOVES = new Set(["approach", "retreat", "idle"]);

/** boss_action_trigger → {fire, attack, move} | null */
function parseTrigger(v) {
  if (v == null || v === false || v === 0 || v === "" || v === "none" || v === "null") return null;
  if (v === true) return { fire: true, attack: null, move: null };
  if (typeof v === "number") {
    if (!(v > 0)) return null;
    if (CONFIG.NEURAL.TRIGGER_NUMBER_MODE === "index") return { fire: true, attack: ATTACK_ORDER[Math.round(v) - 1] ?? null, move: null };
    return { fire: true, attack: null, move: null };
  }
  if (typeof v === "object") return parseTrigger(v.attack ?? v.name ?? v.action ?? v.type ?? true);
  const k = ACTION_ALIASES[String(v).toLowerCase()];
  if (k === undefined || k === "any") return { fire: true, attack: null, move: null };   // desconocido → disparo genérico
  if (MOVES.has(k)) return { fire: false, attack: null, move: k };
  return { fire: true, attack: k, move: null };
}

/** Mensaje del backend → {mean, std, trigger} | null (si no trae nada útil) */
function normalizeNeural(msg) {
  const arr = [msg.voltages, msg.neuron_activity, msg.neurons, msg.activations].find((x) => Array.isArray(x) && x.length >= 50);
  const neurons = arr ? flatNumbers(arr) : null;

  let m = Number.isFinite(msg.mean_activity) ? msg.mean_activity : Number.isFinite(msg.meanActivity) ? msg.meanActivity : null;
  if (m === null && neurons && neurons.length) m = mean(neurons);
  if (m === null) {                                                   // compatibilidad con el formato v1
    const vals = flatNumbers(msg.activations ?? msg.activity ?? msg.neural);
    if (vals.length) m = mean(vals);
    else if (Number.isFinite(msg.spikes)) m = msg.spikes / CONFIG.NEURAL.SPIKE_NORMALIZER;
  }
  const trigger = parseTrigger(msg.boss_action_trigger ?? msg.action ?? msg.command ?? msg.behavior);
  if (m === null && !trigger) return null;

  let std = null;
  if (neurons && neurons.length) { const mu = mean(neurons); std = Math.sqrt(mean(neurons.map((v) => (v - mu) ** 2))); }
  return { mean: m, std, trigger };
}

const NeuralLink = {
  ws: null, connected: false, mockForced: false,
  bootAt: performance.now(), lastRealAt: 0, _logged: 0,

  raw:  { activity: 0, mean: 0, at: 0, move: null, moveAt: 0 },   // activity = normalizada 0..1
  view: { activity: 0, pulse: 0 },                                // suavizada, solo para dibujar
  volatility: 0,          // cuánto cambia la actividad (0..1) → más impredecible
  chaos: 0,               // dispersión entre neuronas (0..1) si llega el array de voltajes
  tier: 0,                // umbrales de voltaje superados (0..4)
  range: { lo: null, hi: null, at: 0 },
  pending: null,          // disparo de ataque pendiente
  lastTriggerAt: 0, lastTriggerKey: "", label: "—", labelAt: 0,
  history: [], _histAcc: 0,
  mockT: { next: 0, nextFire: 0, fireAt: 0, target: 0.3, mean: 0.2, msgAcc: 0 },

  connect() {
    try { this.ws = new WebSocket(CONFIG.WS_URL); }
    catch (e) { setTimeout(() => this.connect(), CONFIG.RECONNECT_MS); return; }
    this.ws.onopen = () => {
      this.connected = true;
      this.send({ type: "hello", client: "web_frontend", version: 2, arena_radius: CONFIG.ARENA_RADIUS });
    };
    this.ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (this._logged++ < 3) console.log("[SNN] mensaje recibido:", msg);
      const n = normalizeNeural(msg);
      if (n) { this.lastRealAt = performance.now(); this.apply(n); }
    };
    this.ws.onclose = () => { this.connected = false; setTimeout(() => this.connect(), CONFIG.RECONNECT_MS); };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  },

  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); },

  /** Rango adaptativo: convierte la actividad cruda en 0..1 respecto a lo visto en los últimos ~20 s. */
  _adapt(v, now) {
    const C = CONFIG.NEURAL, r = this.range;
    if (r.lo === null) { r.lo = r.hi = v; r.at = now; return 0; }
    const k = 1 - Math.exp(-((now - r.at) / 1000) / C.RANGE_TAU_S); r.at = now;
    r.hi = Math.max(v, lerp(r.hi, v, k));
    r.lo = Math.min(v, lerp(r.lo, v, k));
    return clamp((v - r.lo) / Math.max(r.hi - r.lo, C.MIN_SPAN), 0, 1);
  },

  _queue(t, label) {
    const now = performance.now();
    if (this.pending && !this.pending.implicit && t.implicit) return;     // un trigger explícito manda sobre uno implícito
    this.pending = { ...t, at: now };
    this.label = label; this.labelAt = now;
  },

  /** Punto de entrada único para datos reales Y simulados. */
  apply(n) {
    const now = performance.now(), C = CONFIG.NEURAL, prev = this.raw.activity;
    let a = prev;
    if (n.mean !== null) a = C.ACTIVITY_MODE === "auto" ? this._adapt(n.mean, now) : clamp(n.mean, 0, 1);

    this.volatility = lerp(this.volatility, clamp(Math.abs(a - prev) * 10, 0, 1), 0.25);
    if (n.std !== null) this.chaos = lerp(this.chaos, clamp(n.std * 4, 0, 1), 0.2);
    if (a - prev > 0.2) this.view.pulse = 1;

    // Umbrales de voltaje con histéresis: cruzar uno hacia arriba = el jefe "se decide" a atacar
    const T = C.TIERS; let tier = this.tier;
    while (tier < T.length && a >= T[tier]) tier++;
    while (tier > 0 && a < T[tier - 1] - C.TIER_HYST) tier--;
    if (tier > this.tier) this._queue({ attack: null, implicit: true, tier }, "umbral " + tier);
    this.tier = tier;

    // boss_action_trigger explícito (con detección de flanco)
    const tr = n.trigger;
    if (tr && tr.move) { this.raw.move = tr.move; this.raw.moveAt = now; }
    if (tr && tr.fire) {
      const key = tr.attack ?? "any";
      if (key !== this.lastTriggerKey || now - this.lastTriggerAt > C.TRIGGER_REPEAT_MS) {
        this._queue({ attack: tr.attack, tier }, tr.attack ?? "pulso");
        this.lastTriggerKey = key; this.lastTriggerAt = now;
      }
    } else this.lastTriggerKey = "";                                      // el trigger bajó → permite un nuevo flanco

    this.raw.activity = a;
    if (n.mean !== null) this.raw.mean = n.mean;
    this.raw.at = now;
  },

  peekTrigger() {
    const p = this.pending;
    if (!p) return null;
    if (performance.now() - p.at > CONFIG.NEURAL.TRIGGER_TTL_MS) { this.pending = null; return null; }
    return p;
  },
  consumeTrigger() { const p = this.peekTrigger(); this.pending = null; return p; },
  currentMove() { return performance.now() - this.raw.moveAt < CONFIG.ACTION_MAX_AGE_MS ? this.raw.move : null; },

  mockActive() {
    if (this.mockForced) return true;
    const now = performance.now();
    const realFresh = this.connected && now - this.lastRealAt < 3000;
    return !realFresh && now - this.bootAt > CONFIG.AUTO_MOCK_AFTER_MS;
  },

  /** Backend falso: genera mensajes con el MISMO formato que el real y los pasa por normalizeNeural(). */
  stepMock(dt) {
    const m = this.mockT, now = performance.now();
    if (now > m.next) {
      const r = Math.random();
      m.target = r < 0.3 ? rand(0.8, 1.0) : r < 0.65 ? rand(0.45, 0.72) : rand(0.08, 0.35);
      m.next = now + rand(1500, 4000);
    }
    if (now > m.nextFire) { m.nextFire = now + rand(1800, 3400); if (m.mean > 0.4) m.fireAt = now + 40; }
    m.msgAcc += dt;
    if (m.msgAcc >= 0.05) {                                   // 20 mensajes/s
      m.msgAcc = 0;
      m.mean = clamp(lerp(m.mean, m.target, 0.12) + rand(-0.03, 0.03), 0, 1);
      const msg = { mean_activity: m.mean, boss_action_trigger: false };
      if (m.fireAt && now > m.fireAt) { m.fireAt = 0; msg.boss_action_trigger = Math.random() < 0.4 ? ATTACK_ORDER[Math.floor(Math.random() * 6)] : true; }
      const n = normalizeNeural(msg); if (n) this.apply(n);
    }
  },

  update(dt) {
    if (this.mockActive()) this.stepMock(dt);
    this.view.activity = damp(this.view.activity, this.raw.activity, 8, dt);
    this.view.pulse = Math.max(0, this.view.pulse - dt * 3);
    this._histAcc += dt;
    if (this._histAcc > 1 / 30) { this._histAcc = 0; this.history.push(this.raw.activity); if (this.history.length > 120) this.history.shift(); }
  },
};

/* =============================================================================
   5. HUD
   ============================================================================= */
const HUD = {
  el: {
    hpBar: document.querySelector(".bar.hp"), hp: $("hp-fill"), st: $("st-fill"),
    boss: $("boss-fill"), ghost: $("boss-ghost"), dmg: $("boss-dmg"), bossBar: $("boss-bar"),
    dot: $("link-dot"), text: $("link-text"), roAct: $("ro-activity"), roAction: $("ro-action"),
    scope: $("scope").getContext("2d"), banner: $("banner"), vignette: $("vignette"), fps: $("fps"),
    estus: $("estus"), pips: document.querySelectorAll("#estus .pips i"),
  },
  bossPct: 100, ghostPct: 100, ghostHold: 0, dmgAcc: 0, dmgTimer: 0, healT: 0,

  setPlayer(hpPct, stPct) { this.el.hp.style.width = hpPct + "%"; this.el.st.style.width = stPct + "%"; },
  setEstus(n, drinking) {
    this.el.pips.forEach((p, i) => p.classList.toggle("spent", i >= n));
    this.el.estus.classList.toggle("drinking", drinking);
    this.el.estus.classList.toggle("empty", n === 0);
  },
  flashHeal() { this.healT = 0.9; },
  setBoss(pct, tookDamage) { if (tookDamage) this.ghostHold = 0.6; this.bossPct = pct; },
  setEnraged(on) { this.el.bossBar.classList.toggle("enraged", on); },
  addBossDamage(n) { this.dmgAcc += n; this.dmgTimer = 1.6; this.el.dmg.textContent = "−" + Math.round(this.dmgAcc); },
  banner(text, kind) { this.el.banner.textContent = text; this.el.banner.className = "show " + kind; },
  hideBanner() { this.el.banner.className = ""; },

  setLink(connected, mock) {
    const { dot, text } = this.el;
    if (mock && connected) { dot.className = "warn"; text.textContent = "Conectado, sin datos · simulación local"; }
    else if (mock)         { dot.className = "warn"; text.textContent = "Sin servidor · simulación local"; }
    else if (connected)    { dot.className = "ok";   text.textContent = "Conectoma conectado · 500 neuronas"; }
    else                   { dot.className = "off";  text.textContent = "Reconectando…"; }
  },

  drawScope(history, color) {
    const c = this.el.scope, w = 240, h = 56, T = CONFIG.NEURAL.TIERS;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "rgba(200,162,74,.16)"; c.lineWidth = 1;
    for (const t of T) { const y = h - 3 - t * (h - 6); c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }   // umbrales
    c.strokeStyle = color; c.lineWidth = 1.6; c.beginPath();
    history.forEach((v, i) => { const x = (i / 119) * w, y = h - 3 - v * (h - 6); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
  },

  update(dt, heatCss) {
    if (this.ghostHold > 0) this.ghostHold -= dt; else this.ghostPct = Math.max(this.bossPct, this.ghostPct - 30 * dt);
    if (this.ghostPct < this.bossPct) this.ghostPct = this.bossPct;
    this.el.boss.style.width = this.bossPct + "%";
    this.el.ghost.style.width = this.ghostPct + "%";
    if (this.dmgTimer > 0 && (this.dmgTimer -= dt) <= 0) { this.dmgAcc = 0; this.el.dmg.textContent = ""; }
    if (this.healT > 0) { this.healT -= dt; this.el.hpBar.classList.toggle("heal", this.healT > 0); }

    const now = performance.now();
    this.el.roAct.textContent = Math.round(NeuralLink.view.activity * 100) + "%";
    this.el.roAction.textContent = now - NeuralLink.labelAt < 1600 ? NeuralLink.label : "—";
    this.el.vignette.style.opacity = (NeuralLink.view.activity * 0.5 + (boss.enraged ? 0.15 : 0)).toFixed(3);
    this.drawScope(NeuralLink.history, heatCss);
  },
};

/* =============================================================================
   6. ESCENA · renderer, texturas procedurales, entorno y partículas
   ============================================================================= */
const renderer = new THREE.WebGLRenderer({ canvas: $("game"), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x070605);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b0907, 0.026);

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
const camPos = new THREE.Vector3(0, 6, 16);
let shake = 0;
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// --- Luces: ambiente frío + "luna" con sombras + luz propia del jefe (se tiñe con la SNN)
scene.add(new THREE.HemisphereLight(0x544a3c, 0x0a0806, 0.75));
const moon = new THREE.DirectionalLight(0x8d94a8, 0.6);
moon.position.set(-10, 24, 8);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
Object.assign(moon.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 });
scene.add(moon);
const bossLight = new THREE.PointLight(0x93a032, 1.2, 26, 1.6);
scene.add(bossLight);

/* ---------- Texturas procedurales de piedra y ladrillo ---------- */
const rgb = (c, v = 0) => `rgb(${clamp(c[0] + v, 0, 255) | 0},${clamp(c[1] + v * 0.95, 0, 255) | 0},${clamp(c[2] + v * 0.9, 0, 255) | 0})`;

/** Dibuja ladrillos/losas (color + mapa de relieve) en dos canvas. Es "tileable". */
function makeBrickCanvases({ size = 512, rows = 8, cols = 4, base = [66, 60, 53], mortar = [15, 13, 11], vary = 16, stagger = true, cracks = 6, moss = 4 } = {}) {
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = size; return c; };
  const color = mk(), bump = mk(), g = color.getContext("2d"), b = bump.getContext("2d");
  g.fillStyle = rgb(mortar); g.fillRect(0, 0, size, size);
  b.fillStyle = "#000"; b.fillRect(0, 0, size, size);
  const rh = size / rows, cw = size / cols, gap = Math.max(3, size / 120);

  for (let r = 0; r < rows; r++) {
    const off = stagger && r % 2 ? cw / 2 : 0;
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + off + rand(-1, 1), y = r * rh, w = cw - gap, h = rh - gap;
      g.fillStyle = rgb(base, rand(-vary, vary));
      g.fillRect(x + gap / 2, y + gap / 2, w, h);
      const sh = g.createLinearGradient(x, y, x + cw, y + rh);               // luz arriba-izq., sombra abajo-der.
      sh.addColorStop(0, "rgba(255,255,255,.08)"); sh.addColorStop(1, "rgba(0,0,0,.22)");
      g.fillStyle = sh; g.fillRect(x + gap / 2, y + gap / 2, w, h);
      for (let i = 0; i < 46; i++) {                                         // grano
        g.fillStyle = Math.random() < 0.5 ? "rgba(255,240,210,.05)" : "rgba(0,0,0,.14)";
        g.fillRect(x + rand(0, cw), y + rand(0, rh), rand(1, 3.5), rand(1, 3.5));
      }
      const lv = 150 + rand(-35, 35);                                        // relieve: la piedra sobresale del mortero
      b.fillStyle = `rgb(${lv | 0},${lv | 0},${lv | 0})`; b.fillRect(x + gap / 2, y + gap / 2, w, h);
      for (let i = 0; i < 30; i++) { const n = rand(90, 220) | 0; b.fillStyle = `rgba(${n},${n},${n},.35)`; b.fillRect(x + rand(0, cw), y + rand(0, rh), rand(2, 6), rand(2, 6)); }
    }
  }
  for (let k = 0; k < cracks; k++) {                                          // grietas
    let x = rand(0, size), y = rand(0, size);
    for (const [ctx, style, lw] of [[g, "rgba(0,0,0,.6)", 1.6], [b, "rgba(0,0,0,.8)", 2.4]]) {
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x, y);
      let cx = x, cy = y; for (let s = 0; s < 14; s++) { cx += rand(-14, 14); cy += rand(4, 22); ctx.lineTo(cx, cy); } ctx.stroke();
    }
  }
  for (let k = 0; k < moss; k++) {                                            // musgo / moho
    const x = rand(0, size), y = rand(0, size), rr = rand(22, 60), mg = g.createRadialGradient(x, y, 2, x, y, rr);
    mg.addColorStop(0, "rgba(70,86,38,.34)"); mg.addColorStop(1, "rgba(70,86,38,0)");
    g.fillStyle = mg; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  return { color, bump };
}
function tiled(canvas, rx, ry) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = MAX_ANISO;
  return t;
}
function stoneMaterial(cv, rx, ry, { bump = 2.2, rough = 0.93, side, imagePath } = {}) {
  const params = { map: tiled(cv.color, rx, ry), bumpMap: tiled(cv.bump, rx, ry), bumpScale: bump, roughness: rough, metalness: 0.02 };
  if (side !== undefined) params.side = side;
  const mat = new THREE.MeshStandardMaterial(params);
  if (imagePath) {                                                            // textura de imagen opcional (CONFIG.TEXTURES)
    new THREE.TextureLoader().load(imagePath, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = MAX_ANISO;
      mat.map = t; mat.bumpMap = null; mat.needsUpdate = true;
    }, undefined, () => console.warn("[texturas] no se pudo cargar", imagePath, "→ se mantiene la procedural"));
  }
  return mat;
}

// Losas del suelo (grandes, claras y desgastadas) y ladrillo oscuro para muros y columnas
const floorCv = makeBrickCanvases({ rows: 4, cols: 4, base: [74, 67, 59], mortar: [12, 10, 9], vary: 14, cracks: 9, moss: 6 });
const wallCv  = makeBrickCanvases({ rows: 8, cols: 4, base: [52, 46, 42], mortar: [12, 10, 9], vary: 14, cracks: 5, moss: 7 });

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(CONFIG.ARENA_RADIUS + 6, 72),
  stoneMaterial(floorCv, 8, 8, { bump: 2.6, imagePath: CONFIG.TEXTURES.floor })
);
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

// Decal rúnico sobre el suelo + oscurecimiento hacia el borde
(() => {
  const S = 1024, c = document.createElement("canvas"); c.width = c.height = S;
  const g = c.getContext("2d"), C = S / 2, u = C / (CONFIG.ARENA_RADIUS + 6);
  g.strokeStyle = "rgba(200,162,74,.30)"; g.lineWidth = 3;
  for (const r of [4.2, 9, 14.8, CONFIG.ARENA_RADIUS - 0.2]) { g.beginPath(); g.arc(C, C, r * u, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 2; g.strokeStyle = "rgba(200,162,74,.16)";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath(); g.moveTo(C + Math.cos(a) * 4.2 * u, C + Math.sin(a) * 4.2 * u); g.lineTo(C + Math.cos(a) * 14.8 * u, C + Math.sin(a) * 14.8 * u); g.stroke();
  }
  const edge = g.createRadialGradient(C, C, (CONFIG.ARENA_RADIUS - 1) * u, C, C, C);
  edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(0.45, "rgba(0,0,0,.88)"); edge.addColorStop(1, "rgba(0,0,0,.95)");
  g.fillStyle = edge; g.fillRect(0, 0, S, S);
  const decal = new THREE.Mesh(new THREE.CircleGeometry(CONFIG.ARENA_RADIUS + 6, 72),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  decal.rotation.x = -Math.PI / 2; decal.position.y = 0.03; scene.add(decal);
})();

// Muro circular de ladrillo (visto desde dentro) que cierra la arena
{
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(CONFIG.WALL_RADIUS, CONFIG.WALL_RADIUS, 13, 72, 1, true),
    stoneMaterial(wallCv, 22, 2.6, { bump: 3, side: THREE.BackSide, imagePath: CONFIG.TEXTURES.wall })
  );
  wall.position.y = 6.5; scene.add(wall);
}

// Columnas góticas de ladrillo, con base, capitel y escombros caídos
{
  const pillarMat = stoneMaterial(wallCv, 2, 1.6, { bump: 2.6, imagePath: CONFIG.TEXTURES.pillar });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.95 });
  const R = CONFIG.ARENA_RADIUS + 1.9;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, h = rand(7, 11), x = Math.cos(a) * R, z = Math.sin(a) * R;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.95, h, 10), pillarMat);
    shaft.position.set(x, h / 2, z); shaft.castShadow = shaft.receiveShadow = true; scene.add(shaft);
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.7, 2.1), trimMat); base.position.set(x, 0.35, z); base.rotation.y = -a; base.castShadow = true; scene.add(base);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 1.9), trimMat); cap.position.set(x, h + 0.2, z); cap.rotation.y = -a; cap.castShadow = true; scene.add(cap);
    const chunk = new THREE.Mesh(new THREE.BoxGeometry(rand(0.8, 1.5), rand(0.5, 1), rand(0.8, 1.5)), pillarMat);
    chunk.position.set(Math.cos(a + 0.1) * (R - 2.6), 0.3, Math.sin(a + 0.1) * (R - 2.6));
    chunk.rotation.set(rand(0, 1), rand(0, 3), rand(0, 1)); chunk.castShadow = chunk.receiveShadow = true; scene.add(chunk);
  }
}

/* ---------- Partículas: pool de chispas / llamas / Estus + polvo ambiental ---------- */
const softSprite = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();

const Fx = (() => {
  const N = 900;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), vel = new Float32Array(N * 3), base = new Float32Array(N * 3);
  const life = new Float32Array(N), maxLife = new Float32Array(N), grav = new Float32Array(N);
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = -100;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.2, map: softSprite, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pts.frustumCulled = false; scene.add(pts);
  let cursor = 0;

  /** opts: color [r,g,b] 0..1 · speed · jitter (0 = solo dir) · dir [x,y,z] · life (s) · grav (<0 = sube) */
  function emit(x, y, z, count, o = {}) {
    const speed = o.speed ?? 4, jit = o.jitter ?? 1, l0 = o.life ?? 0.6, g = o.grav ?? 9, c = o.color ?? [1, 0.7, 0.3], d = o.dir;
    for (let n = 0; n < count; n++) {
      const k = cursor; cursor = (cursor + 1) % N;
      let rx = rand(-1, 1), ry = rand(-1, 1), rz = rand(-1, 1); const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
      vel[k * 3]     = (d ? d[0] : 0) * speed + rx * speed * jit;
      vel[k * 3 + 1] = (d ? d[1] : 0) * speed + ry * speed * jit;
      vel[k * 3 + 2] = (d ? d[2] : 0) * speed + rz * speed * jit;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      life[k] = maxLife[k] = l0 * rand(0.6, 1.2); grav[k] = g;
      base[k * 3] = c[0]; base[k * 3 + 1] = c[1]; base[k * 3 + 2] = c[2];
    }
  }
  function update(dt) {
    const drag = Math.exp(-1.3 * dt);
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { pos[i * 3 + 1] = -100; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
      vel[i * 3 + 1] -= grav[i] * dt;
      vel[i * 3] *= drag; vel[i * 3 + 1] *= drag; vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (grav[i] > 0 && pos[i * 3 + 1] < 0.04) { pos[i * 3 + 1] = 0.04; vel[i * 3 + 1] *= -0.35; vel[i * 3] *= 0.6; vel[i * 3 + 2] *= 0.6; }
      const f = Math.pow(life[i] / maxLife[i], 0.8);
      col[i * 3] = base[i * 3] * f; col[i * 3 + 1] = base[i * 3 + 1] * f; col[i * 3 + 2] = base[i * 3 + 2] * f;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
  }
  return { emit, update };
})();
const COL = { spark: [1, 0.75, 0.35], guard: [1, 0.92, 0.6], blood: [0.8, 0.12, 0.1], estus: [1, 0.78, 0.25], dust: [0.45, 0.4, 0.34], plague: [0.58, 0.66, 0.2], flame: [1, 0.5, 0.15] };

// Polvo flotando en la penumbra (alpha normal, muy sutil)
const dust = (() => {
  const N = 260, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 18;
    pos.set([Math.cos(a) * r, rand(0.3, 9), Math.sin(a) * r], i * 3); seed[i] = rand(0, 100);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xbfae8a, size: 0.12, map: softSprite, transparent: true, opacity: 0.3, depthWrite: false }));
  pts.frustumCulled = false; scene.add(pts);
  return { pts, pos, seed, N };
})();
function updateDust(t, dt) {
  const { pos, seed, N } = dust;
  for (let i = 0; i < N; i++) {
    pos[i * 3]     += Math.sin(t * 0.3 + seed[i]) * 0.12 * dt;
    pos[i * 3 + 1] += Math.cos(t * 0.2 + seed[i] * 1.7) * 0.06 * dt - 0.02 * dt;
    pos[i * 3 + 2] += Math.cos(t * 0.25 + seed[i] * 0.6) * 0.12 * dt;
    if (pos[i * 3 + 1] < 0.2) pos[i * 3 + 1] = 9;
  }
  dust.pts.geometry.attributes.position.needsUpdate = true;
}

// Braseros con fuego (luz parpadeante + llamas del pool de partículas)
const braziers = [];
{
  const stone = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.95 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x1a1816, metalness: 0.8, roughness: 0.5 });
  for (let i = 0; i < 4; i++) {
    const a = ((i * 3 + 1.5) / 12) * Math.PI * 2, x = Math.cos(a) * 16.7, z = Math.sin(a) * 16.7;
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.2, 8), stone); ped.position.set(x, 0.6, z); ped.castShadow = true; scene.add(ped);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.3, 0.45, 10), iron); bowl.position.set(x, 1.4, z); scene.add(bowl);
    const light = new THREE.PointLight(0xff8a3a, 1.2, 17, 1.6); light.position.set(x, 2.3, z); scene.add(light);
    braziers.push({ x, z, light, ph: rand(0, 10), acc: 0 });
  }
}
function updateBraziers(t, dt) {
  for (const b of braziers) {
    b.light.intensity = 1.05 + Math.sin(t * 11 + b.ph) * 0.18 + Math.sin(t * 27 + b.ph * 2) * 0.12;
    b.acc += dt * 28;
    while (b.acc >= 1) { b.acc -= 1; Fx.emit(b.x + rand(-0.25, 0.25), 1.65, b.z + rand(-0.25, 0.25), 1, { color: COL.flame, speed: 0.9, jitter: 0.35, dir: [0, 1, 0], life: 0.75, grav: -2 }); }
  }
}

// Brasas grandes flotando (ambiente)
const embers = (() => {
  const N = 110, pos = new Float32Array(N * 3), spd = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 19; pos.set([Math.cos(a) * r, rand(0, 10), Math.sin(a) * r], i * 3); spd[i] = rand(0.3, 1.1); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff9a4a, size: 0.12, map: softSprite, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  pts.frustumCulled = false; scene.add(pts);
  return { pts, pos, spd, N };
})();
function updateEmbers(dt, t) {
  const { pos, spd, N } = embers;
  for (let i = 0; i < N; i++) {
    pos[i * 3 + 1] += spd[i] * dt; pos[i * 3] += Math.sin(t + i) * 0.15 * dt;
    if (pos[i * 3 + 1] > 10) pos[i * 3 + 1] = 0;
  }
  embers.pts.geometry.attributes.position.needsUpdate = true;
}

/* =============================================================================
   7. JUGADOR · escudo, Estus, rodar con i-frames, ataque
   ============================================================================= */
const player = {
  group: new THREE.Group(), rig: new THREE.Group(), sword: new THREE.Group(),
  shield: new THREE.Group(), flask: new THREE.Group(), lantern: null, armorMat: null,
  pos: new THREE.Vector3(0, 0, 9), vel: new THREE.Vector3(), knock: new THREE.Vector3(),
  yaw: Math.PI,                              // forward = (sin yaw, 0, cos yaw)
  hp: CONFIG.PLAYER.maxHp, stamina: CONFIG.PLAYER.maxStamina, staminaDelay: 0,
  roll: 0, rollDir: new THREE.Vector3(), invuln: 0,
  attack: 0, attackHit: false,
  blocking: false, blockT: 0, blockTime: 0,                      // blockT = animación 0..1, blockTime = s desde que subió el escudo
  flasks: CONFIG.PLAYER.estus.flasks, drink: 0, healed: false, // drink = tiempo restante de la animación
  stagger: 0, hurt: 0, dead: false, moving: false, speed: 0,
};
const SHIELD_REST = new THREE.Vector3(-0.55, 0.05, 0.12), SHIELD_UP = new THREE.Vector3(-0.1, 0.12, 0.58);
const FLASK_REST = new THREE.Vector3(-0.5, 0.2, 0.3), FLASK_UP = new THREE.Vector3(-0.08, 0.72, 0.3);
{
  const armor = player.armorMat = new THREE.MeshStandardMaterial({ color: 0x454b57, metalness: 0.6, roughness: 0.5, emissive: 0x000000 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2a1d17, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.9, roughness: 0.3 });
  const gold  = new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 0.8, roughness: 0.4 });
  const rig = player.rig; rig.position.y = 0.9;                  // el rig rota sobre su centro al rodar
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; rig.add(m); return m; };
  add(new THREE.CylinderGeometry(0.34, 0.4, 1.0, 10), armor, 0, 0.05, 0);          // torso
  add(new THREE.SphereGeometry(0.25, 12, 10), armor, 0, 0.78, 0);                  // yelmo
  add(new THREE.CylinderGeometry(0.3, 0.38, 0.7, 10), cloth, 0, -0.62, 0);         // falda/piernas
  add(new THREE.BoxGeometry(0.9, 0.12, 0.5), cloth, 0, 0.55, -0.22);               // capa
  // Espada (hombro derecho)
  player.sword.position.set(0.5, 0.35, 0.1);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 1.15), steel); blade.position.z = 0.7; blade.castShadow = true;
  player.sword.add(blade); rig.add(player.sword);
  // Escudo (brazo izquierdo): en reposo a un lado, al bloquear se planta delante
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 18), armor); disc.rotation.x = Math.PI / 2; disc.castShadow = true;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.04, 8, 24), gold);
  const boss_ = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), gold); boss_.position.z = 0.06; boss_.scale.z = 0.5;
  player.shield.add(disc, rim, boss_); player.shield.position.copy(SHIELD_REST); rig.add(player.shield);
  // Frasco de Estus (aparece al beber)
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.24, 8), new THREE.MeshStandardMaterial({ color: 0xffc94a, emissive: 0xffa21a, emissiveIntensity: 1.6, transparent: true, opacity: 0.92 }));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.1, 8), gold); neck.position.y = 0.17;
  player.flask.add(glass, neck); player.flask.visible = false; player.flask.position.copy(FLASK_REST); rig.add(player.flask);

  player.group.add(rig);
  player.lantern = new THREE.PointLight(0xffb870, 0.9, 9, 1.8); player.lantern.position.set(0, 1.8, 0);
  player.group.add(player.lantern);
  scene.add(player.group);
}

/** Aplica daño ya resuelto (sin comprobar escudo) y gestiona la muerte */
function hurtPlayer(dmg) {
  player.hp = Math.max(0, player.hp - dmg);
  if (player.hp <= 0 && !player.dead) {
    player.dead = true; player.blocking = false; player.drink = 0;
    HUD.banner("HAS MUERTO", "dead");
    sendStimulus("player_died");
  }
}

/**
 * Daño del jefe al jugador.  src = {x,z} del origen del golpe (decide si el escudo lo cubre).
 * Devuelve "dodged" | "blocked" | "perfect" | "guard_break" | "hit".
 */
function playerTakeDamage(amount, src, opts = {}) {
  const P = CONFIG.PLAYER, B = P.block;
  if (player.dead) return null;
  if (player.invuln > 0) return "dodged";                          // i-frames del rodar

  if (player.blocking && !opts.unblockable) {
    const toSrc = Math.atan2(src.x - player.pos.x, src.z - player.pos.z);
    if (Math.abs(wrapAngle(toSrc - player.yaw)) < B.cone) {        // el golpe viene de frente
      const perfect = player.blockTime < B.perfectWindow;
      const cost = perfect ? 0 : amount * B.staminaPerDmg;
      const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
      Fx.emit(player.pos.x + fx * 0.8, 1.1, player.pos.z + fz * 0.8, perfect ? 30 : 16, { color: COL.guard, speed: 5, life: 0.35, dir: [fx, 0.3, fz] });
      shake = Math.max(shake, perfect ? 0.1 : 0.25);
      player.staminaDelay = CONFIG.PLAYER.staminaDelay;
      if (player.stamina >= cost) {
        player.stamina -= cost;
        if (!perfect) hurtPlayer(amount * B.chip);
        player.knock.set(-fx, 0, -fz).multiplyScalar(perfect ? 1.2 : 3.2);   // el golpe te empuja hacia atrás
        sendStimulus(perfect ? "perfect_block" : "block");
        return perfect ? "perfect" : "blocked";
      }
      // Estamina insuficiente → guardia rota
      player.stamina = 0; player.blocking = false; player.stagger = B.breakStagger;
      hurtPlayer(amount * 0.5); shake = Math.max(shake, 0.5);
      player.knock.set(-fx, 0, -fz).multiplyScalar(5);
      sendStimulus("guard_break");
      return "guard_break";
    }
  }

  // Golpe directo
  hurtPlayer(amount);
  player.hurt = 0.3; shake = Math.max(shake, 0.35);
  if (player.drink > 0) player.drink = 0;                          // beber interrumpido (el frasco se pierde si no había curado)
  player.attack = 0;
  if (amount >= 15) player.stagger = Math.max(player.stagger, P.staggerTime);
  const dx = player.pos.x - src.x, dz = player.pos.z - src.z, d = Math.hypot(dx, dz) || 1;
  player.knock.set(dx / d, 0, dz / d).multiplyScalar(amount >= 20 ? 5 : 3);
  Fx.emit(player.pos.x, 1.2, player.pos.z, 14, { color: COL.blood, speed: 3.5, life: 0.5 });
  if (!player.dead) sendStimulus("hit_taken");
  return "hit";
}

function startDrinking() {
  const E = CONFIG.PLAYER.estus;
  player.flasks--; player.drink = E.time; player.healed = false;
  sendStimulus("estus");
}

function updatePlayer(dt) {
  const P = CONFIG.PLAYER, E = P.estus;
  player.moving = false; player.speed = 0;
  if (player.dead) {
    player.rig.rotation.x = damp(player.rig.rotation.x, -1.5, 5, dt); player.rig.position.y = damp(player.rig.position.y, 0.35, 5, dt);
    player.flask.visible = false; player.blockT = damp(player.blockT, 0, 8, dt);
    return;
  }

  // Base de movimiento relativa a la cámara (W = hacia el jefe)
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const ax = Input.axis();
  const wish = new THREE.Vector3().addScaledVector(fwd, ax.y).addScaledVector(right, ax.x);
  if (wish.lengthSq() > 0) wish.normalize();
  const toBoss = new THREE.Vector3(boss.pos.x - player.pos.x, 0, boss.pos.z - player.pos.z).normalize();

  player.stagger = Math.max(0, player.stagger - dt);
  player.blockTime += dt;
  player.invuln = Math.max(0, player.invuln - dt);
  const busy = player.stagger > 0;
  const lockedDrinking = player.drink > 0 && !player.healed;       // antes de que caiga la curación no se puede cancelar

  // --- Rodar (Espacio): i-frames al principio. Se puede cancelar el final de la animación de beber
  if (!busy && !lockedDrinking && player.roll <= 0 && player.stamina >= P.roll.cost && Input.consume("Space")) {
    player.roll = P.roll.time;
    player.rollDir.copy(wish.lengthSq() > 0 ? wish : toBoss.clone().negate());     // sin dirección → paso atrás
    player.stamina -= P.roll.cost; player.staminaDelay = P.staminaDelay;
    player.attack = 0; player.drink = 0; player.blocking = false;
    sendStimulus("roll");
  }
  // --- Ataque (J / clic izquierdo)
  if (!busy && player.roll <= 0 && player.attack <= 0 && player.drink <= 0 && player.stamina >= P.attackCost && Input.consume("KeyJ", "Mouse0")) {
    player.attack = P.attackTime; player.attackHit = false; player.blocking = false;
    player.stamina -= P.attackCost; player.staminaDelay = P.staminaDelay;
    sendStimulus("attack");
  }
  // --- Estus (Q)
  if (!busy && player.roll <= 0 && player.attack <= 0 && player.drink <= 0 && player.flasks > 0 && Input.consume("KeyQ")) {
    startDrinking(); player.blocking = false;
  }
  // --- Escudo (Shift / K / clic derecho, mantener)
  const wantBlock = Input.isDown("ShiftLeft", "ShiftRight", "KeyK", "Mouse2");
  const canBlock = !busy && player.roll <= 0 && player.attack <= 0 && player.drink <= 0 && player.stamina > 0;
  if (wantBlock && canBlock) { if (!player.blocking) { player.blocking = true; player.blockTime = 0; } }
  else player.blocking = false;
  player.blockT = damp(player.blockT, player.blocking ? 1 : 0, 18, dt);

  // --- Movimiento
  if (player.roll > 0) {
    const elapsed = P.roll.time - player.roll;
    player.invuln = elapsed < P.roll.iFrames ? 0.05 : 0;
    player.vel.copy(player.rollDir).multiplyScalar(P.roll.speed * (1 - (elapsed / P.roll.time) * 0.55));
    player.yaw = Math.atan2(player.rollDir.x, player.rollDir.z);
    player.roll -= dt;
    player.rig.rotation.x = (elapsed / P.roll.time) * Math.PI * 2;               // voltereta
    player.rig.scale.y = 0.8; player.moving = true;
  } else {
    player.rig.rotation.x = busy ? -0.28 : 0; player.rig.scale.y = 1;
    let speed = P.speed;
    if (player.attack > 0) speed *= 0.3;
    if (player.drink > 0) speed *= E.moveMul;
    if (player.blocking) speed *= P.block.moveMul;
    if (busy) speed = 0;
    if (player.blocking || player.attack > 0) {                                   // lock-on: mira al jefe
      player.yaw += wrapAngle(Math.atan2(toBoss.x, toBoss.z) - player.yaw) * (1 - Math.exp(-16 * dt));
    } else if (wish.lengthSq() > 0 && !busy) {
      player.yaw += wrapAngle(Math.atan2(wish.x, wish.z) - player.yaw) * (1 - Math.exp(-14 * dt));
    }
    player.vel.copy(wish).multiplyScalar(speed);
    player.moving = wish.lengthSq() > 0 && !busy;
  }
  player.vel.add(player.knock);
  player.knock.multiplyScalar(Math.exp(-9 * dt));

  // --- Estus: animación, curación y partículas doradas
  if (player.drink > 0) {
    const elapsed = E.time - player.drink;
    if (!player.healed && elapsed >= E.healAt) {
      player.healed = true;
      player.hp = Math.min(P.maxHp, player.hp + E.heal);
      HUD.flashHeal();
      Fx.emit(player.pos.x, 1.0, player.pos.z, 46, { color: COL.estus, speed: 2.8, life: 1.0, grav: -1.5, dir: [0, 1, 0] });
    }
    if (Math.random() < dt * 40) Fx.emit(player.pos.x + rand(-0.4, 0.4), 0.2, player.pos.z + rand(-0.4, 0.4), 1, { color: COL.estus, speed: 1.2, jitter: 0.25, dir: [0, 1, 0], life: 0.9, grav: -1.2 });
    player.drink -= dt;
  }

  // --- Ataque: ventana de impacto
  if (player.attack > 0) {
    const elapsed = P.attackTime - player.attack;
    player.sword.rotation.x = lerp(-2.0, 0.7, clamp(elapsed / (P.attackTime * 0.7), 0, 1));
    if (!player.attackHit && elapsed > 0.12 && elapsed < 0.3) {
      const d = Math.hypot(boss.pos.x - player.pos.x, boss.pos.z - player.pos.z);
      if (d < P.attackRange + CONFIG.BOSS.radius) { player.attackHit = true; bossTakeDamage(P.attackDamage); }
    }
    player.attack -= dt;
  } else player.sword.rotation.x = damp(player.sword.rotation.x, 0.2, 10, dt);

  // --- Integración + colisiones
  player.pos.addScaledVector(player.vel, dt);
  player.speed = player.vel.length();
  const dB = Math.hypot(player.pos.x - boss.pos.x, player.pos.z - boss.pos.z), minD = CONFIG.BOSS.radius + P.radius;
  if (dB < minD && dB > 0.001) {                                                  // el cuerpo del jefe es sólido
    player.pos.x = boss.pos.x + ((player.pos.x - boss.pos.x) / dB) * minD;
    player.pos.z = boss.pos.z + ((player.pos.z - boss.pos.z) / dB) * minD;
  }
  const rr = Math.hypot(player.pos.x, player.pos.z), maxR = CONFIG.ARENA_RADIUS - 0.6;
  if (rr > maxR) { player.pos.x *= maxR / rr; player.pos.z *= maxR / rr; }

  // --- Estamina (regenera más lento con el escudo arriba)
  player.staminaDelay -= dt;
  if (player.roll <= 0 && player.attack <= 0 && player.staminaDelay <= 0)
    player.stamina = Math.min(P.maxStamina, player.stamina + P.staminaRegen * (player.blocking ? P.block.regenMul : 1) * dt);

  // --- Pose visual del escudo, frasco, luz y daño
  player.shield.position.lerpVectors(SHIELD_REST, SHIELD_UP, player.blockT);
  player.shield.rotation.y = lerp(1.35, 0, player.blockT);
  player.flask.visible = player.drink > 0;
  if (player.drink > 0) {
    const k = clamp((E.time - player.drink) / (E.healAt * 0.8), 0, 1);
    player.flask.position.lerpVectors(FLASK_REST, FLASK_UP, k); player.flask.rotation.z = -k * 0.9;
  }
  const glow = player.drink > 0 ? 1 : 0;
  player.lantern.intensity = damp(player.lantern.intensity, glow ? 2.2 : 0.9, 10, dt);
  player.lantern.color.setHex(glow ? 0xffc040 : 0xffb870);
  player.hurt = Math.max(0, player.hurt - dt);
  player.armorMat.emissive.setRGB(player.hurt * 2, 0, 0);

  player.group.position.copy(player.pos);
  player.group.rotation.y = player.yaw;
  player.rig.position.y = 0.9;
}

/* =============================================================================
   8. JEFE · Caballero Mosca
   ============================================================================= */
const boss = {
  group: new THREE.Group(), model: new THREE.Group(),
  armR: new THREE.Group(), armL: new THREE.Group(), wingR: new THREE.Group(), wingL: new THREE.Group(), head: new THREE.Group(),
  pos: new THREE.Vector3(0, 0, -6), yaw: 0, knock: new THREE.Vector3(),
  hp: CONFIG.BOSS.maxHp, dead: false, deathT: 0,
  blink: 0, recoil: 0, poise: CONFIG.BOSS.poise, poiseT: 0, stagger: 0,
  enraged: false, lastAttack: null, chain: 0,
  wingPhase: 0, wingOpen: 0, lift: 0,
  ai: { attack: null, phase: null, t: 0, pulse: 0, hitDone: false, cooldown: 1.5, windupScale: 1, strafeDir: 1, strafeT: 0, dir: new THREE.Vector3() },
  mats: {},
};

// Paleta reactiva: poco activo = verde pútrido → ámbar → carmesí
const HEAT = { low: new THREE.Color(0x6e8a2a), mid: new THREE.Color(0xe0a73a), high: new THREE.Color(0xe0361c) };
const heatColor = (a, out) => (a < 0.5 ? out.lerpColors(HEAT.low, HEAT.mid, a / 0.5) : out.lerpColors(HEAT.mid, HEAT.high, (a - 0.5) / 0.5));
const _heat = new THREE.Color(), _tint = new THREE.Color(), WHITE = new THREE.Color(1, 1, 1);

{
  const armor = new THREE.MeshStandardMaterial({ color: 0x2c2823, metalness: 0.7, roughness: 0.45, emissive: 0x000000 });
  const chitin = new THREE.MeshStandardMaterial({ color: 0x1a1713, metalness: 0.3, roughness: 0.55 });
  const bone = new THREE.MeshStandardMaterial({ color: 0x8a7d62, roughness: 0.7 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x93a032, emissiveIntensity: 1.5 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x57524a, metalness: 0.85, roughness: 0.35, emissive: 0x000000 });
  const wingMat = new THREE.MeshBasicMaterial({ color: 0x9aa88a, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
  boss.mats = { armor, steel, eye, wingMat };

  const M = boss.model;
  const add = (parent, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  // Torso, peto y abdomen segmentado
  add(M, new THREE.SphereGeometry(1, 24, 16), armor, 0, 3.3, 0).scale.set(1.5, 2.0, 1.2);
  add(M, new THREE.BoxGeometry(1.2, 1.4, 0.4), bone, 0, 3.5, 1.05);
  add(M, new THREE.SphereGeometry(1.1, 16, 12), chitin, 0, 2.4, -1.6).scale.set(1, 1, 1.4);
  add(M, new THREE.SphereGeometry(0.85, 16, 12), chitin, 0, 2.0, -2.9).scale.set(1, 1, 1.3);
  add(M, new THREE.SphereGeometry(0.6, 14, 10), chitin, 0, 1.7, -3.9).scale.set(1, 1, 1.4);
  for (const s of [-1, 1]) {                                                          // patas
    add(M, new THREE.CylinderGeometry(0.3, 0.2, 2.3, 8), armor, s * 0.75, 1.15, 0.2);
    add(M, new THREE.ConeGeometry(0.35, 0.6, 6), chitin, s * 0.75, 0.2, 0.55).rotation.x = Math.PI / 2;
  }
  // Cabeza: ojos compuestos, cresta, mandíbulas
  const H = boss.head; H.position.set(0, 5.6, 0.35); M.add(H);
  add(H, new THREE.SphereGeometry(0.85, 18, 14), chitin, 0, 0, 0).scale.set(1, 0.92, 1);
  for (const s of [-1, 1]) {
    add(H, new THREE.SphereGeometry(0.42, 14, 12), eye, s * 0.55, 0.1, 0.62);
    add(H, new THREE.ConeGeometry(0.14, 0.7, 6), bone, s * 0.22, -0.7, 0.7).rotation.x = Math.PI * 0.85;
  }
  add(H, new THREE.BoxGeometry(0.16, 0.9, 1.7), armor, 0, 0.95, -0.1);
  add(H, new THREE.TorusGeometry(0.82, 0.07, 8, 24), bone, 0, 0.1, 0.1).rotation.x = Math.PI / 2;
  for (const s of [-1, 1]) add(M, new THREE.SphereGeometry(0.78, 14, 10), armor, s * 1.75, 4.6, 0).scale.set(1, 0.7, 1);   // hombreras

  // Brazo derecho + espadón (pivote en el hombro, "cuelga" hacia -Y)
  boss.armR.position.set(1.9, 4.5, 0.1); boss.armR.rotation.order = "YXZ"; M.add(boss.armR);
  add(boss.armR, new THREE.CylinderGeometry(0.24, 0.2, 1.8, 8), armor, 0, -0.9, 0);
  add(boss.armR, new THREE.BoxGeometry(1.0, 0.14, 0.22), bone, 0, -1.9, 0);
  add(boss.armR, new THREE.BoxGeometry(0.34, 4.2, 0.1), steel, 0, -3.95, 0);
  // Brazo izquierdo: escudo pequeño + garras (se usan en la ráfaga de garras)
  boss.armL.position.set(-1.9, 4.5, 0.2); boss.armL.rotation.order = "YXZ"; boss.armL.rotation.x = -0.7; M.add(boss.armL);
  add(boss.armL, new THREE.CylinderGeometry(0.24, 0.2, 1.8, 8), armor, 0, -0.9, 0);
  add(boss.armL, new THREE.SphereGeometry(0.34, 10, 8), chitin, 0, -1.95, 0);
  for (const cx of [-0.2, 0, 0.2]) add(boss.armL, new THREE.ConeGeometry(0.075, 1.0, 5), bone, cx, -2.55, 0.05).rotation.x = Math.PI;
  const shield = add(boss.armL, new THREE.CylinderGeometry(1.05, 1.05, 0.16, 18), armor, -0.75, -1.2, 0.4); shield.rotation.x = Math.PI / 2;
  add(boss.armL, new THREE.TorusGeometry(1.05, 0.08, 8, 24), bone, -0.75, -1.2, 0.48);

  // Alas translúcidas
  const ws = new THREE.Shape();
  ws.moveTo(0, 0); ws.bezierCurveTo(1.2, 0.9, 3.2, 1.4, 4.6, 0.9); ws.quadraticCurveTo(4.8, 0.2, 4.5, -0.1); ws.bezierCurveTo(3, 0.1, 1.5, -0.1, 0, 0);
  const wingGeo = new THREE.ShapeGeometry(ws, 16);
  for (const [pivot, s] of [[boss.wingR, 1], [boss.wingL, -1]]) {
    pivot.position.set(s * 0.5, 4.7, -0.7); pivot.scale.x = s;
    const w = new THREE.Mesh(wingGeo, wingMat); w.rotation.x = -Math.PI / 2; pivot.add(w); M.add(pivot);
  }
  M.traverse((o) => { if (o.isMesh && o.material !== wingMat) o.castShadow = true; });
  boss.group.add(M); scene.add(boss.group);
}

// Aura en el suelo y enjambre orbitando
const aura = (() => {
  const mat = new THREE.MeshBasicMaterial({ map: softSprite, color: 0x93a032, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(15, 15), mat);
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.06; scene.add(mesh);
  return { mesh, mat };
})();
const swarm = (() => {
  const N = 220, pos = new Float32Array(N * 3);
  const p = Array.from({ length: N }, () => ({ r: rand(0.6, 1.4), a: rand(0, 6.28), y: rand(-2.6, 2.6), w: rand(0.6, 1.6), ph: rand(0, 6.28) }));
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0x93a032, size: 0.16, map: softSprite, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
  return { pts, mat, p, pos, N };
})();

// Telegrafías en el suelo: la línea roja avisa de la embestida; el anillo verde, de la explosión de plaga
const telegraph = (() => {
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 17), lineMat);
  lineMesh.rotation.x = -Math.PI / 2; lineMesh.position.z = 8.8;
  const line = new THREE.Group(); line.position.y = 0.08; line.add(lineMesh); scene.add(line);
  const nr = CONFIG.ATTACKS.nova.waveMax;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x93a032, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(nr - 0.3, nr, 72), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; scene.add(ring);
  return { line, lineMat, ring, ringMat };
})();
function updateTelegraphs(t) {
  const ai = boss.ai, winding = ai.phase === "windup" && !boss.stagger;
  const ch = winding && ai.attack === "charge", nv = winding && ai.attack === "nova";
  telegraph.lineMat.opacity = ch ? 0.18 + 0.2 * Math.abs(Math.sin(t * 18)) : 0;
  telegraph.line.position.set(boss.pos.x, 0.08, boss.pos.z); telegraph.line.rotation.y = boss.yaw;
  telegraph.ringMat.opacity = nv ? 0.1 + 0.2 * Math.abs(Math.sin(t * 14)) : 0;
  telegraph.ring.position.set(boss.pos.x, 0.08, boss.pos.z);
}

/** La actividad neuronal controla TODO el aspecto del jefe. */
function applyNeuralVisuals(dt, t) {
  const act = clamp(NeuralLink.view.activity + (boss.enraged ? 0.15 : 0), 0, 1), pulse = NeuralLink.view.pulse;
  heatColor(act, _heat);
  const fade = boss.dead ? Math.max(0, 1 - boss.deathT / 2.5) : 1;
  const fl = boss.blink > 0 ? (Math.floor(t * 28) % 2 ? 1 : 0.25) : 0;          // parpadeo al recibir un golpe
  _tint.copy(_heat).lerp(WHITE, fl);

  boss.mats.eye.emissive.copy(_tint);
  boss.mats.eye.emissiveIntensity = (0.8 + act * 2.4 + pulse * 2.5 + fl * 2) * fade;
  for (const m of [boss.mats.armor, boss.mats.steel]) { m.emissive.copy(_tint); m.emissiveIntensity = (0.04 + act * 0.22 + fl * 0.7) * fade; }
  bossLight.color.copy(_heat);
  bossLight.intensity = (0.9 + act * 2.6 + pulse * 1.5) * (0.92 + 0.08 * Math.sin(t * 23)) * fade;
  bossLight.position.set(boss.pos.x, 4.5, boss.pos.z + 1);
  aura.mat.color.copy(_heat);
  aura.mat.opacity = (0.12 + act * 0.5) * fade;
  aura.mesh.scale.setScalar(0.9 + act * 0.5 + Math.sin(t * 2.4) * 0.05);
  aura.mesh.position.set(boss.pos.x, 0.06, boss.pos.z);

  // Alas: más actividad = aleteo más rápido y amplio
  boss.wingPhase += dt * (6 + act * 34);
  const flap = Math.sin(boss.wingPhase) * (0.18 + act * 0.5), open = 0.25 + boss.wingOpen * 0.5 + flap;
  boss.wingR.rotation.z = open; boss.wingL.rotation.z = -open;
  boss.mats.wingMat.opacity = (0.2 + act * 0.25) * fade;

  // Enjambre: más rápido, ancho y brillante; en la explosión de plaga se contrae y se expande
  swarm.mat.color.copy(_heat);
  swarm.mat.opacity = (0.35 + act * 0.65) * fade;
  swarm.mat.size = 0.13 + act * 0.1;
  const nova = boss.ai.attack === "nova" ? (boss.ai.phase === "windup" ? 0.45 : 1.8) : 1;
  const spread = (2.4 + act * 2.6) * nova, spin = 0.8 + act * 4;
  for (let i = 0; i < swarm.N; i++) {
    const q = swarm.p[i]; q.a += dt * spin * q.w;
    const r = q.r * spread * (1 + 0.15 * Math.sin(t * 3 + q.ph));
    swarm.pos[i * 3] = boss.pos.x + Math.cos(q.a) * r;
    swarm.pos[i * 3 + 1] = 3.8 + q.y * (0.6 + act * 0.7) + Math.sin(t * 5 + q.ph) * 0.25;
    swarm.pos[i * 3 + 2] = boss.pos.z + Math.sin(q.a) * r;
  }
  swarm.pts.geometry.attributes.position.needsUpdate = true;
  return _heat;
}

/** Postura corporal según el ataque y su fase. El aviso (windup) es lo que el jugador debe leer. */
function animateBossBody(dt, t) {
  const ai = boss.ai, ph = ai.phase, act = NeuralLink.view.activity;
  let tx = -0.15, ty = 0, lx = -0.7 + Math.sin(t * 1.7) * 0.05, ly = 0, lean = 0, head = 0, wing = 0, lift = 0, k = 6;

  if (boss.stagger > 0)                { tx = 0.35; lx = 0.2; lean = 0.45; head = 0.7; wing = -0.3; lift = -0.5; k = 8; }
  else if (ai.attack === "slash") {
    if (ph === "windup")      { tx = -1.45; ty = 1.5;  lean = -0.1; k = 7; }
    else if (ph === "strike") { tx = -1.45; ty = -1.2; lean = 0.15; k = 32; }
    else                      { tx = -1.1;  ty = -0.8; k = 4; }
  } else if (ai.attack === "claws") {
    if (ph === "windup")      { tx = -1.9; lx = -1.9; ty = 1.1; ly = -1.1; lean = -0.1; k = 9; }
    else if (ph === "strike") { const s = ai.pulse % 2 ? 1 : -1; tx = lx = -1.45; ty = 1.1 * s; ly = -1.1 * s; lean = 0.2; k = 34; }
    else                      { tx = -0.9; lx = -0.9; k = 4; }
  } else if (ai.attack === "charge") {
    if (ph === "windup")      { tx = -2.6; lean = -0.4; wing = -0.2; lift = -0.2; k = 6; }
    else if (ph === "strike") { tx = -0.4; lx = -0.4; lean = 0.55; wing = -0.35; k = 12; }
    else                      { lean = 0.3; tx = -0.6; k = 4; }
  } else if (ai.attack === "slam") {
    if (ph === "windup")      { tx = -3.3; lean = -0.18; head = -0.2; k = 5; }
    else if (ph === "strike") { tx = -0.75; lean = 0.28; head = 0.2; k = 42; }
    else                      { tx = -0.75; lean = 0.15; k = 3; }
  } else if (ai.attack === "swarm") {
    if (ph === "windup")      { tx = -0.5; head = -0.45; lean = -0.1; wing = 1; k = 5; }
    else if (ph === "strike") { head = 0.25; lean = 0.1; wing = 1; k = 25; }
    else                      { wing = 0.3; }
  } else if (ai.attack === "nova") {
    if (ph === "windup")      { tx = lx = -3.0; head = -0.5; wing = 1.2; lift = 1.5; k = 5; }
    else if (ph === "strike") { tx = lx = -0.6; lean = 0.3; wing = 1.2; lift = -0.2; k = 40; }
    else                      { tx = lx = -0.6; wing = 0.4; k = 4; }
  }

  boss.armR.rotation.x = damp(boss.armR.rotation.x, tx, k, dt);
  boss.armR.rotation.y = damp(boss.armR.rotation.y, ty, k, dt);
  boss.armL.rotation.x = damp(boss.armL.rotation.x, lx, k, dt);
  boss.armL.rotation.y = damp(boss.armL.rotation.y, ly, k, dt);
  boss.model.rotation.x = damp(boss.model.rotation.x, lean - boss.recoil * 0.22, 10, dt);   // retroceso al recibir un golpe
  boss.head.rotation.x = damp(boss.head.rotation.x, head, 8, dt);
  boss.wingOpen = damp(boss.wingOpen, wing, 6, dt);
  boss.lift = damp(boss.lift, lift, 6, dt);
  const r = boss.recoil;
  boss.model.position.y = 0.45 + Math.sin(t * (1.6 + act * 3)) * 0.14 + boss.lift;
  boss.model.position.z = -r * 0.45;
  boss.model.scale.set(1 + 0.03 * r, 1 - 0.04 * r, 1 + 0.03 * r);
}

/* ---------- Daño al jefe, retroceso, poise y fase 2 ---------- */
const maxPoise = () => CONFIG.BOSS.poise * (boss.enraged ? 1.5 : 1);
const bossDmg = (base) => base * (boss.enraged ? CONFIG.BOSS.enrageDamageMul : 1);

function bossTakeDamage(n) {
  if (boss.dead) return;
  const B = CONFIG.BOSS, P = CONFIG.PLAYER;
  boss.hp = Math.max(0, boss.hp - n);
  HUD.addBossDamage(n); HUD.setBoss((boss.hp / B.maxHp) * 100, true);

  // Reacción visual: parpadeo + retroceso + chispas + hit-stop
  const dx = boss.pos.x - player.pos.x, dz = boss.pos.z - player.pos.z, d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d;
  const armored = boss.ai.phase === "strike";                      // en pleno golpe casi no retrocede (super armadura)
  boss.blink = 0.35; boss.recoil = 1;
  boss.knock.x += nx * (armored ? 1.5 : 6); boss.knock.z += nz * (armored ? 1.5 : 6);
  Fx.emit(boss.pos.x - nx * B.radius * 0.9, 2.8 + rand(0, 1.2), boss.pos.z - nz * B.radius * 0.9, 18, { color: COL.spark, speed: 6, life: 0.45, dir: [-nx, 0.3, -nz] });
  game.hitStop = 0.07; shake = Math.max(shake, 0.14);
  sendStimulus("boss_hit");

  if (boss.hp <= 0) {
    boss.dead = true; boss.deathT = 0; boss.ai.attack = null; boss.ai.phase = null;
    HUD.banner("ENEMIGO ABATIDO", "won"); sendStimulus("boss_defeated"); return;
  }
  if (!boss.enraged && boss.hp / B.maxHp <= B.enrageAt) enrageBoss();

  // Poise: varios golpes seguidos rompen su guardia y lo dejan expuesto
  if (!armored) {
    boss.poise -= P.attackPoise; boss.poiseT = B.poiseDelay;
    if (boss.poise <= 0) staggerBoss();
  }
}
function staggerBoss() {
  const ai = boss.ai;
  boss.stagger = CONFIG.BOSS.staggerTime; boss.poise = maxPoise(); boss.chain = 0;
  ai.attack = null; ai.phase = null; ai.cooldown = 0.5;
  NeuralLink.pending = null;
  Fx.emit(boss.pos.x, 4.5, boss.pos.z, 30, { color: COL.plague, speed: 5, life: 0.7 });
  shake = Math.max(shake, 0.4); sendStimulus("boss_staggered");
}
function enrageBoss() {
  boss.enraged = true; boss.poise = maxPoise();
  HUD.setEnraged(true);
  Fx.emit(boss.pos.x, 3.5, boss.pos.z, 60, { color: COL.blood, speed: 7, life: 0.9 });
  shake = Math.max(shake, 0.8); boss.ai.cooldown = Math.min(boss.ai.cooldown, 0.6);
  sendStimulus("boss_enraged");
}

/* ---------- Decisión de ataque: la actividad neuronal elige y pondera ---------- */
/** 0..1 — cuanto más alta y volátil es la actividad, menos descansa, más encadena y más rápido telegrafía. */
const aggression = () => clamp(0.28 + NeuralLink.view.activity * 0.55 + NeuralLink.volatility * 0.45 + (boss.enraged ? 0.2 : 0), 0, 1);

/** Elige un ataque según distancia + nº de umbrales superados (tier). La volatilidad y el "caos" entre neuronas
    desordenan los pesos → comportamiento impredecible. Sin repetir el mismo ataque dos veces seguidas (penalizado). */
function chooseAttack(dist) {
  const A = CONFIG.ATTACKS, tier = NeuralLink.tier, en = boss.enraged ? 1.3 : 1;
  const w = {
    slash:  dist < 8.5 ? 1.5 + tier * 0.5 : 0,
    claws:  dist < 6.5 && tier >= 1 ? (1.5 + tier) * en : 0,
    charge: dist >= A.charge.minDist && tier >= 2 ? (1.5 + tier) * en : 0,
    slam:   dist < A.slam.maxDist && tier >= 2 ? 1 + tier : 0,
    swarm:  dist >= A.swarm.minDist && tier >= 2 ? 1.5 + (tier >= 3 ? 1 : 0) : 0,
    nova:   tier >= 3 ? (tier >= 4 ? 4.5 : 1.8) * (dist < 11 ? 1 : 0.4) * en : 0,
  };
  const chaos = clamp(NeuralLink.volatility * 1.2 + NeuralLink.chaos, 0, 1);
  let sum = 0;
  for (const k of ATTACK_ORDER) {
    if (w[k] <= 0) continue;
    if (k === boss.lastAttack) w[k] *= 0.35;
    w[k] *= Math.max(0.05, 1 + chaos * rand(-0.8, 1.2));
    sum += w[k];
  }
  if (sum <= 0) return null;
  let r = Math.random() * sum;
  for (const k of ATTACK_ORDER) { if (w[k] > 0 && (r -= w[k]) <= 0) return k; }
  return ATTACK_ORDER.find((k) => w[k] > 0) ?? null;
}

function startAttack(name) {
  const ai = boss.ai;
  Object.assign(ai, { attack: name, phase: "windup", t: 0, pulse: 0, hitDone: false, windupScale: clamp(1 - 0.28 * aggression(), 0.7, 1) });
  boss.lastAttack = name;
}
function endAttack() {
  const ai = boss.ai, ag = aggression();
  ai.attack = null; ai.phase = null;
  const chainP = clamp(ag * 0.6 + (boss.enraged ? 0.2 : 0) - 0.1, 0, 0.75);
  if (boss.chain < 2 && NeuralLink.tier >= 2 && Math.random() < chainP) { boss.chain++; ai.cooldown = 0.08; }   // combo encadenado
  else { boss.chain = 0; ai.cooldown = lerp(1.8, 0.45, ag); }
}

function onStrikeStart(name) {
  const A = CONFIG.ATTACKS[name], fx = Math.sin(boss.yaw), fz = Math.cos(boss.yaw);
  if (name === "slam") {
    spawnShockwave(boss.pos.x + fx * 4, boss.pos.z + fz * 4, A, 0xe0a73a, 0);
    Fx.emit(boss.pos.x + fx * 4, 0.2, boss.pos.z + fz * 4, 26, { color: COL.dust, speed: 5, life: 0.7, dir: [0, 1, 0] });
    shake = Math.max(shake, 0.6);
  } else if (name === "swarm") {
    for (let i = 0; i < A.count; i++) {
      const a = boss.yaw + (i - (A.count - 1) / 2) * 0.17;
      spawnProjectile(boss.pos.x + fx * 1.5, 3.6, boss.pos.z + fz * 1.5, Math.sin(a) * A.speed, Math.cos(a) * A.speed, bossDmg(A.damage));
    }
  } else if (name === "nova") {
    spawnShockwave(boss.pos.x, boss.pos.z, A, 0x93a032, 0);
    spawnShockwave(boss.pos.x, boss.pos.z, A, 0xc9d44a, A.echoDelay);                // eco: obliga a esquivar dos veces
    Fx.emit(boss.pos.x, 1, boss.pos.z, 50, { color: COL.plague, speed: 7, life: 0.8, dir: [0, 0.4, 0] });
    shake = Math.max(shake, 0.8);
  } else if (name === "charge") {
    boss.ai.dir.set(fx, 0, fz); shake = Math.max(shake, 0.2);
  }
}

function clawHit(atk, dx, dz, dist, fx, fz) {
  boss.pos.x += fx * 0.9; boss.pos.z += fz * 0.9;                                    // pequeño avance en cada zarpazo
  Fx.emit(boss.pos.x + fx * 2.5, 2.2, boss.pos.z + fz * 2.5, 8, { color: COL.guard, speed: 4, life: 0.25, dir: [fx, 0, fz] });
  if (dist < atk.range && (dx * fx + dz * fz) / dist > 0.2) playerTakeDamage(bossDmg(atk.damage), boss.pos);
}

const clampBoss = () => {
  const rr = Math.hypot(boss.pos.x, boss.pos.z), maxR = CONFIG.ARENA_RADIUS - 3;
  if (rr > maxR) { boss.pos.x *= maxR / rr; boss.pos.z *= maxR / rr; }
};

/** IA del jefe: el CEREBRO (conectoma) elige y modula; aquí solo se ejecuta con física y animación. */
function updateBoss(dt) {
  const A = CONFIG.ATTACKS, B = CONFIG.BOSS, ai = boss.ai;
  if (boss.dead) {
    boss.deathT += dt;
    boss.model.rotation.x = damp(boss.model.rotation.x, -0.9, 2, dt);
    boss.model.position.y = damp(boss.model.position.y, -0.6, 2, dt);
    return;
  }
  boss.pos.addScaledVector(boss.knock, dt); boss.knock.multiplyScalar(Math.exp(-7 * dt));   // retroceso por golpes
  boss.blink = Math.max(0, boss.blink - dt); boss.recoil = Math.max(0, boss.recoil - dt * 5);
  boss.poiseT -= dt; if (boss.poiseT <= 0) boss.poise = Math.min(maxPoise(), boss.poise + B.poiseRegen * dt);

  if (boss.stagger > 0) { boss.stagger -= dt; clampBoss(); return; }                         // aturdido: expuesto

  let dx = player.pos.x - boss.pos.x, dz = player.pos.z - boss.pos.z, dist = Math.hypot(dx, dz) || 0.001;
  const fx = Math.sin(boss.yaw), fz = Math.cos(boss.yaw);
  const engaged = game.started && !player.dead;
  const ag = aggression();

  // Giro hacia el jugador: más rápido cuanto más agresivo; lento en el aviso; bloqueado en el golpe
  const turn = (ai.phase === "strike" ? 0 : ai.phase === "windup" ? 1.2 : 2.4) * (0.8 + ag * 0.6);
  boss.yaw += clamp(wrapAngle(Math.atan2(dx, dz) - boss.yaw), -turn * dt, turn * dt);

  if (ai.attack) {
    const atk = A[ai.attack]; ai.t += dt;
    if (ai.phase === "windup") {
      if (ai.t >= atk.windup * ai.windupScale) { ai.phase = "strike"; ai.t = 0; ai.pulse = 0; ai.hitDone = false; onStrikeStart(ai.attack); }
    } else if (ai.phase === "strike") {
      let done = ai.t >= atk.strike;
      if (ai.attack === "slash") {
        boss.pos.x += fx * 7 * dt; boss.pos.z += fz * 7 * dt;                                // tajo con embestida corta
        dx = player.pos.x - boss.pos.x; dz = player.pos.z - boss.pos.z; dist = Math.hypot(dx, dz) || 0.001;
        if (!ai.hitDone && dist < atk.range && (dx * fx + dz * fz) / dist > 0.3) { ai.hitDone = true; playerTakeDamage(bossDmg(atk.damage), boss.pos); }
      } else if (ai.attack === "claws") {
        while (ai.pulse < atk.pulses && ai.t >= ai.pulse * atk.pulseGap) {                   // 3 zarpazos seguidos
          dx = player.pos.x - boss.pos.x; dz = player.pos.z - boss.pos.z; dist = Math.hypot(dx, dz) || 0.001;
          clawHit(atk, dx, dz, dist, fx, fz); ai.pulse++;
        }
      } else if (ai.attack === "charge") {
        const sp = atk.speed * (boss.enraged ? 1.15 : 1);
        boss.pos.x += ai.dir.x * sp * dt; boss.pos.z += ai.dir.z * sp * dt;
        Fx.emit(boss.pos.x - ai.dir.x * 1.6, 0.3, boss.pos.z - ai.dir.z * 1.6, 2, { color: COL.dust, speed: 2, life: 0.5, dir: [0, 0.6, 0] });
        dx = player.pos.x - boss.pos.x; dz = player.pos.z - boss.pos.z; dist = Math.hypot(dx, dz) || 0.001;
        if (!ai.hitDone && dist < B.radius + CONFIG.PLAYER.radius + 0.9) { ai.hitDone = true; playerTakeDamage(bossDmg(atk.damage), boss.pos); shake = Math.max(shake, 0.5); }
        if (Math.hypot(boss.pos.x, boss.pos.z) > CONFIG.ARENA_RADIUS - 3.1) done = true;      // choca con el borde
      }
      if (done) { ai.phase = "recover"; ai.t = 0; }
    } else if (ai.phase === "recover" && ai.t >= atk.recover * (1 - 0.25 * ag)) {
      endAttack();
    }
  } else {
    ai.cooldown -= dt;
    const trig = engaged ? NeuralLink.peekTrigger() : null;
    const tier = NeuralLink.tier;
    // ¿Puede atacar ya? Autónomo (cooldown + tier ≥ 1) o por disparo (boss_action_trigger / cruce de umbral)
    const canAct = engaged && ((ai.cooldown <= 0 && tier >= 1) || (trig && ai.cooldown <= 0.8));
    let want = null, forceMove = null;
    if (canAct) {
      want = trig?.attack ?? chooseAttack(dist);
      // Adaptación al terreno: si el ataque pedido es imposible desde aquí, primero se recoloca
      if ((want === "slash" || want === "claws") && dist > A[want].range * 1.25) { forceMove = "approach"; want = null; }
      else if (want === "slam" && dist > A.slam.maxDist) { forceMove = "approach"; want = null; }
      else if (want === "swarm" && dist < A.swarm.minDist) { forceMove = "retreat"; want = null; }
    }
    if (want) { startAttack(want); if (trig) NeuralLink.consumeTrigger(); }
    else {
      const move = !engaged ? "idle" : forceMove ?? NeuralLink.currentMove() ?? (tier === 0 ? (dist > 12 ? "approach" : "idle") : dist > 5.5 ? "approach" : "idle");
      const spd = 1 + ag * 0.6 + (boss.enraged ? 0.15 : 0);
      let mx = 0, mz = 0;
      if (move === "approach") { if (dist > 3.8) { mx = (dx / dist) * B.approachSpeed * spd; mz = (dz / dist) * B.approachSpeed * spd; } }
      else if (move === "retreat") { mx = (-dx / dist) * B.retreatSpeed * spd; mz = (-dz / dist) * B.retreatSpeed * spd; }
      else if (engaged) {                                                                      // idle: rodea al jugador
        ai.strafeT -= dt; if (ai.strafeT <= 0) { ai.strafeDir = Math.random() < 0.5 ? -1 : 1; ai.strafeT = rand(1.2, 3.2); }
        mx = (-dz / dist) * B.strafeSpeed * spd * ai.strafeDir; mz = (dx / dist) * B.strafeSpeed * spd * ai.strafeDir;
      }
      boss.pos.x += mx * dt; boss.pos.z += mz * dt;
    }
  }
  clampBoss();
}

/* =============================================================================
   9. PROYECTILES (moscas) Y ONDAS EXPANSIVAS
   ============================================================================= */
const projectiles = [], waves = [];
const projGeo = new THREE.SphereGeometry(0.28, 8, 8);
const projMat = new THREE.MeshBasicMaterial({ color: 0xc9d44a });
const waveGeo = new THREE.RingGeometry(0.92, 1, 56);

function spawnProjectile(x, y, z, vx, vz, damage) {
  const mesh = new THREE.Mesh(projGeo, projMat); mesh.position.set(x, y, z); scene.add(mesh);
  projectiles.push({ mesh, vx, vz, life: 3, damage });
}
function spawnShockwave(x, z, A, color, delay) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(waveGeo, mat);
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, 0.12, z); mesh.visible = delay <= 0; scene.add(mesh);
  waves.push({ mesh, mat, x, z, r: 0.5, hit: false, A, delay });
}
function clearHazards() {
  for (const p of projectiles) scene.remove(p.mesh);
  for (const w of waves) { scene.remove(w.mesh); w.mat.dispose(); }
  projectiles.length = waves.length = 0;
}
function updateHazards(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i], m = p.mesh.position;
    m.x += p.vx * dt; m.z += p.vz * dt; p.life -= dt;
    let consumed = false;
    if (!player.dead && Math.hypot(m.x - player.pos.x, m.z - player.pos.z) < 0.8) {
      consumed = playerTakeDamage(p.damage, { x: m.x, z: m.z }) !== "dodged";            // los i-frames dejan pasar la mosca
    }
    if (consumed || p.life <= 0 || Math.hypot(m.x, m.z) > CONFIG.ARENA_RADIUS + 2) { scene.remove(p.mesh); projectiles.splice(i, 1); }
  }
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    if (w.delay > 0) { w.delay -= dt; if (w.delay <= 0) w.mesh.visible = true; continue; }
    w.r += w.A.waveSpeed * dt; w.mesh.scale.setScalar(w.r); w.mat.opacity = Math.max(0, 0.9 * (1 - w.r / w.A.waveMax));
    // La onda solo golpea cuando su borde pasa por el jugador → rodar en el momento justo (o bloquear) la neutraliza
    if (!w.hit && !player.dead && Math.abs(Math.hypot(player.pos.x - w.x, player.pos.z - w.z) - w.r) < 1.0) {
      w.hit = true; playerTakeDamage(bossDmg(w.A.damage), { x: w.x, z: w.z });
    }
    if (w.r >= w.A.waveMax) { scene.remove(w.mesh); w.mat.dispose(); waves.splice(i, 1); }
  }
}

/* =============================================================================
   10. SINCRONIZACIÓN · estímulo sensorial hacia el backend
   -----------------------------------------------------------------------------
   Posición del jugador RELATIVA al jefe, en el marco de referencia del jefe:
     rel.z = metros delante (+) o detrás (−) · rel.x = a su derecha (+) o izquierda (−)
     angle = 0 justo enfrente · ±π a su espalda
   20 Hz mientras el jugador actúa, 4 Hz en reposo, e inmediato en cada evento
   (kind): roll, attack, block, perfect_block, guard_break, estus, hit_taken, player_died,
           boss_hit, boss_staggered, boss_enraged, boss_defeated.
   ============================================================================= */
function buildStimulus(kind) {
  const dx = player.pos.x - boss.pos.x, dz = player.pos.z - boss.pos.z, dist = Math.hypot(dx, dz);
  const s = Math.sin(boss.yaw), c = Math.cos(boss.yaw);
  const relZ = dx * s + dz * c, relX = dx * c - dz * s, angle = Math.atan2(relX, relZ);
  return {
    type: "player_state", kind, t: Date.now(),
    player: {
      rel: { x: +relX.toFixed(3), z: +relZ.toFixed(3) },
      world: { x: +player.pos.x.toFixed(3), z: +player.pos.z.toFixed(3) },
      distance: +dist.toFixed(3),
      distance_norm: +clamp(dist / (CONFIG.ARENA_RADIUS * 2), 0, 1).toFixed(3),
      angle: +angle.toFixed(3), in_front: Math.abs(angle) < Math.PI / 2,
      velocity: { x: +player.vel.x.toFixed(3), z: +player.vel.z.toFixed(3) }, speed: +player.speed.toFixed(3),
      moving: player.moving, rolling: player.roll > 0, attacking: player.attack > 0,
      blocking: player.blocking, drinking: player.drink > 0, estus_left: player.flasks,
      hp_pct: +(player.hp / CONFIG.PLAYER.maxHp).toFixed(3), stamina_pct: +(player.stamina / CONFIG.PLAYER.maxStamina).toFixed(3),
    },
    boss: { hp_pct: +(boss.hp / CONFIG.BOSS.maxHp).toFixed(3), yaw: +boss.yaw.toFixed(3), attack: boss.ai.attack, phase: boss.enraged ? 2 : 1, staggered: boss.stagger > 0 },
  };
}
function sendStimulus(kind) { NeuralLink.send(buildStimulus(kind)); }

let sendAcc = 0;
function tickSender(dt) {
  if (!game.started) return;
  sendAcc += dt;
  const active = player.moving || player.roll > 0 || player.attack > 0 || player.blocking || player.drink > 0;
  if (sendAcc >= 1 / (active ? CONFIG.SEND_HZ_ACTIVE : CONFIG.SEND_HZ_IDLE)) { sendAcc = 0; sendStimulus("tick"); }
}

/* =============================================================================
   11. CÁMARA, ESTADO Y BUCLE PRINCIPAL (60 FPS)
   ============================================================================= */
function updateCamera(dt) {
  // Cámara "lock-on": detrás del jugador, en la línea jefe → jugador, sin salirse de las columnas
  const dx = boss.pos.x - player.pos.x, dz = boss.pos.z - player.pos.z, d = Math.hypot(dx, dz) || 1;
  let wx = player.pos.x - (dx / d) * 9, wz = player.pos.z - (dz / d) * 9;
  const rr = Math.hypot(wx, wz), maxR = CONFIG.ARENA_RADIUS + 1.2;
  if (rr > maxR) { wx *= maxR / rr; wz *= maxR / rr; }
  camPos.x = damp(camPos.x, wx, 5, dt); camPos.y = damp(camPos.y, 5.4, 5, dt); camPos.z = damp(camPos.z, wz, 5, dt);
  shake = Math.max(0, shake - dt * 1.8);
  camera.position.copy(camPos).add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shake * 0.35));
  camera.lookAt(lerp(player.pos.x, boss.pos.x, 0.3), 2.2, lerp(player.pos.z, boss.pos.z, 0.3));
}

function startFight() {
  if (game.started) return;
  game.started = true;
  $("gate").classList.add("leave");
  Input.endFrame();                                  // descarta el clic que pulsó el botón
  NeuralLink.send({ type: "fight_start" });
}

function resetFight() {
  clearHazards();
  Object.assign(player, {
    hp: CONFIG.PLAYER.maxHp, stamina: CONFIG.PLAYER.maxStamina, dead: false, roll: 0, attack: 0, invuln: 0, hurt: 0,
    blocking: false, blockT: 0, flasks: CONFIG.PLAYER.estus.flasks, drink: 0, healed: false, stagger: 0,
  });
  player.pos.set(0, 0, 9); player.vel.set(0, 0, 0); player.knock.set(0, 0, 0); player.yaw = Math.PI;
  player.rig.rotation.x = 0; player.rig.position.y = 0.9; player.rig.scale.y = 1;
  boss.pos.set(0, 0, -6); boss.yaw = 0; boss.knock.set(0, 0, 0);
  Object.assign(boss, { hp: CONFIG.BOSS.maxHp, dead: false, deathT: 0, blink: 0, recoil: 0, stagger: 0, enraged: false, chain: 0, lastAttack: null, poise: CONFIG.BOSS.poise, poiseT: 0 });
  boss.model.rotation.x = 0;
  Object.assign(boss.ai, { attack: null, phase: null, t: 0, cooldown: 1.5 });
  NeuralLink.pending = null;
  HUD.bossPct = HUD.ghostPct = 100; HUD.setEnraged(false); HUD.hideBanner();
  camPos.set(0, 6, 16);
  NeuralLink.send({ type: "reset" });
}

$("gate-btn").addEventListener("click", startFight);
addEventListener("keydown", (e) => { if (e.code === "Enter") startFight(); });

const fpsMeter = { lastSecond: performance.now(), frames: 0 };
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);

  // Limitador a 60 FPS (en monitores de 120/144 Hz evita ir más rápido)
  const elapsed = now - last, frameMs = 1000 / CONFIG.TARGET_FPS;
  if (elapsed < frameMs - 0.5) return;
  last = now - (elapsed % frameMs);
  const realDt = Math.min(elapsed / 1000, 0.05);
  let dt = realDt;
  if (game.hitStop > 0) { game.hitStop -= realDt; dt = realDt * 0.06; }        // hit-stop: el golpe "pesa"
  game.t += dt;

  if (Input.consume("KeyM")) NeuralLink.mockForced = !NeuralLink.mockForced;
  if (Input.consume("KeyR") && game.started) resetFight();
  if (DEBUG && game.started) {                                                 // ?debug → 1..6 fuerzan un ataque, 0 simula un disparo
    ATTACK_ORDER.forEach((name, i) => { if (Input.consume("Digit" + (i + 1)) && !boss.dead) { boss.stagger = 0; startAttack(name); } });
    if (Input.consume("Digit0")) NeuralLink._queue({ attack: null }, "debug");
  }

  // 1) red neuronal → 2) lógica → 3) visuales → 4) HUD → 5) red hacia el backend
  NeuralLink.update(realDt);
  if (game.started) updatePlayer(dt);
  updateBoss(dt);
  if (game.started) updateHazards(dt);

  boss.group.position.copy(boss.pos);
  boss.group.rotation.y = boss.yaw;
  animateBossBody(dt, game.t);
  const heat = applyNeuralVisuals(dt, game.t);
  updateTelegraphs(game.t);
  updateBraziers(game.t, dt);
  updateEmbers(dt, game.t);
  updateDust(game.t, dt);
  Fx.update(dt);
  updateCamera(realDt);

  HUD.setPlayer((player.hp / CONFIG.PLAYER.maxHp) * 100, (player.stamina / CONFIG.PLAYER.maxStamina) * 100);
  HUD.setEstus(player.flasks, player.drink > 0);
  HUD.setLink(NeuralLink.connected, NeuralLink.mockActive());
  HUD.update(realDt, "#" + heat.getHexString());

  tickSender(realDt);
  renderer.render(scene, camera);
  Input.endFrame();

  fpsMeter.frames++;
  if (now - fpsMeter.lastSecond >= 1000) { HUD.el.fps.textContent = fpsMeter.frames + " FPS"; fpsMeter.frames = 0; fpsMeter.lastSecond = now; }
}

/* ---- Arranque ---- */
NeuralLink.connect();
requestAnimationFrame(frame);
window.__volitak = { NeuralLink, boss, player, CONFIG, normalizeNeural, parseTrigger };   // depuración desde la consola (F12)
})();