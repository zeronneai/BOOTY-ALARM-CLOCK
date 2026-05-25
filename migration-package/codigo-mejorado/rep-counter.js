// rep-counter.js — Contador de repeticiones con ANTI-TRAMPA (resuelve A3, A4).
//
// Lógica pura, sin DOM: fácil de testear. Recibe los landmarks de cada frame
// (normalizados + worldLandmarks 3D de PoseTracker) y emite eventos:
//   - onRep(count)         cuando se valida una rep COMPLETA y honesta
//   - onState(phase, info) para feedback en UI ('UP'|'DOWN'|'TRANSITION'|'NOT_READY')
//
// Mejoras frente al código viejo:
//   • Usa ángulos 3D (worldLandmarks en metros) → invariante a la perspectiva.
//   • Exige cuerpo completo visible (gating de visibilidad real, no MIN_VIS=0.1 sin usar).
//   • Squat: valida PROFUNDIDAD real (cadera baja respecto a rodilla), no solo el ángulo.
//   • Lunge: exige flexión de AMBAS rodillas, no el mínimo de una (anti "marcha en el sitio").
//   • Duración mínima/máxima de rep → descarta sacudidas e imposibles.
//   • Suavizado EMA del ángulo → no cuenta por jitter de un frame.
//   • Histéresis con dos umbrales (se conserva del diseño viejo, que era correcto).

// Índices BlazePose / MediaPipe Pose (33 puntos)
const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

const DEFAULTS = {
  // Visibilidad: umbral real (el viejo usaba 0.1 y ni lo aplicaba)
  minVisibility: 0.6,
  // Histéresis de ángulo de rodilla (grados)
  downAngle: 95,    // por debajo => "abajo"
  upAngle: 160,     // por encima => "arriba" (extensión casi completa, exige ROM completo)
  // Suavizado
  emaAlpha: 0.4,
  // Duración plausible de una rep completa (ms)
  minRepMs: 600,
  maxRepMs: 8000,
  // Squat: cuánto debe bajar la cadera respecto a la rodilla (metros, world coords).
  // En el eje Y de world landmarks, "abajo" es +Y. Pedimos que la cadera se acerque
  // o pase la altura de la rodilla.
  squatHipDropM: 0.0,   // cadera.y >= rodilla.y - margen => suficientemente abajo
  squatHipDropMarginM: 0.08,
  // Torso: la rep no vale si te doblas hacia adelante en vez de sentarte (anti "agacharse").
  maxTorsoLeanDeg: 50,
};

function angle3D(a, b, c) {
  // Ángulo en b del triángulo a-b-c usando coords 3D (x,y,z en metros).
  const ab = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
  const magAB = Math.hypot(ab.x, ab.y, ab.z);
  const magCB = Math.hypot(cb.x, cb.y, cb.z);
  if (magAB === 0 || magCB === 0) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot / (magAB * magCB)))) * (180 / Math.PI);
}

export class RepCounter {
  /**
   * @param {'squat'|'lunge'} exercise
   * @param {object} opts  ver DEFAULTS
   * @param {(count:number)=>void} opts.onRep
   * @param {(phase:string, info:object)=>void} opts.onState
   */
  constructor(exercise, opts = {}) {
    this.exercise = exercise;
    this.o = { ...DEFAULTS, ...opts };
    this.count = 0;
    this.phase = 'NOT_READY';   // 'NOT_READY' | 'UP' | 'DOWN'
    this.ema = null;
    this.downStartTs = 0;
    this.reachedDepth = false;  // ¿alcanzó profundidad/validación real estando abajo?
  }

  reset() {
    this.count = 0;
    this.phase = 'NOT_READY';
    this.ema = null;
    this.downStartTs = 0;
    this.reachedDepth = false;
  }

  _visible(lm, ...idx) {
    return idx.every((i) => lm[i] && (lm[i].visibility ?? 1) >= this.o.minVisibility);
  }

  _smooth(angle) {
    this.ema = this.ema == null ? angle : this.o.emaAlpha * angle + (1 - this.o.emaAlpha) * this.ema;
    return this.ema;
  }

  // Inclinación del torso respecto a la vertical (grados). 0 = erguido.
  _torsoLean(w) {
    const sx = (w[LM.L_SHOULDER].x + w[LM.R_SHOULDER].x) / 2;
    const sy = (w[LM.L_SHOULDER].y + w[LM.R_SHOULDER].y) / 2;
    const hx = (w[LM.L_HIP].x + w[LM.R_HIP].x) / 2;
    const hy = (w[LM.L_HIP].y + w[LM.R_HIP].y) / 2;
    const dx = sx - hx, dy = sy - hy;
    // ángulo respecto al eje vertical
    return Math.abs(Math.atan2(Math.abs(dx), Math.abs(dy)) * (180 / Math.PI));
  }

  /**
   * Procesa un frame. Llamar desde PoseTracker.onResult.
   * @param {Array} landmarks       normalizados (para gating de visibilidad)
   * @param {Array} worldLandmarks  3D en metros (para ángulos/profundidad)
   * @param {number} ts             timestamp (ms)
   */
  update({ landmarks, worldLandmarks, timestamp }) {
    const lm = landmarks;
    const w = worldLandmarks || landmarks; // si no hay world, degradar a normalizado

    // 1) Gating: cuerpo completo (ambas piernas + cadera + tobillos + hombros)
    const ready = this._visible(
      lm, LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE,
      LM.L_ANKLE, LM.R_ANKLE, LM.L_SHOULDER, LM.R_SHOULDER,
    );
    if (!ready) {
      this.phase = 'NOT_READY';
      this.o.onState?.('NOT_READY', { reason: 'Ponte de cuerpo completo en cuadro' });
      return;
    }

    if (this.exercise === 'squat') this._squat(w, timestamp);
    else this._lunge(w, timestamp);
  }

  _emitDown(info) { this.phase = 'DOWN'; this.o.onState?.('DOWN', info); }
  _emitUp(info)   { this.phase = 'UP';   this.o.onState?.('UP', info); }

  _tryComplete(ts) {
    // Validación temporal: duración plausible
    const dur = ts - this.downStartTs;
    if (dur < this.o.minRepMs || dur > this.o.maxRepMs) {
      this.o.onState?.('TRANSITION', { rejected: true, reason: 'Ritmo no válido', dur });
      return false;
    }
    if (!this.reachedDepth) {
      this.o.onState?.('TRANSITION', { rejected: true, reason: 'Baja más (sin profundidad)' });
      return false;
    }
    this.count++;
    this.o.onRep?.(this.count);
    return true;
  }

  _squat(w, ts) {
    const lAngle = angle3D(w[LM.L_HIP], w[LM.L_KNEE], w[LM.L_ANKLE]);
    const rAngle = angle3D(w[LM.R_HIP], w[LM.R_KNEE], w[LM.R_ANKLE]);
    const knee = this._smooth((lAngle + rAngle) / 2);

    // Profundidad real: cadera baja hasta (o por debajo de) la altura de la rodilla.
    const hipY = (w[LM.L_HIP].y + w[LM.R_HIP].y) / 2;
    const kneeY = (w[LM.L_KNEE].y + w[LM.R_KNEE].y) / 2;
    const deepEnough = hipY >= kneeY - this.o.squatHipDropMarginM; // +Y = abajo
    const torsoOk = this._torsoLean(w) <= this.o.maxTorsoLeanDeg;

    if (this.phase !== 'DOWN' && knee < this.o.downAngle) {
      this.downStartTs = ts;
      this.reachedDepth = false;
      this._emitDown({ angle: knee });
    } else if (this.phase === 'DOWN') {
      if (deepEnough && torsoOk) this.reachedDepth = true; // marca profundidad alcanzada
      if (knee > this.o.upAngle) {
        if (this._tryComplete(ts)) this._emitUp({ angle: knee });
        else this.phase = 'UP'; // vuelve arriba pero NO cuenta la rep inválida
      }
    } else {
      this.phase = 'UP';
      this.o.onState?.('UP', { angle: knee });
    }
  }

  _lunge(w, ts) {
    const lAngle = this._smoothPair('l', angle3D(w[LM.L_HIP], w[LM.L_KNEE], w[LM.L_ANKLE]));
    const rAngle = this._smoothPair('r', angle3D(w[LM.R_HIP], w[LM.R_KNEE], w[LM.R_ANKLE]));

    // Anti "marcha en el sitio": EXIGE que AMBAS rodillas se flexionen (no el mínimo de una).
    const bothBent = lAngle < this.o.downAngle + 20 && rAngle < this.o.downAngle + 20;
    const frontDeep = Math.min(lAngle, rAngle) < this.o.downAngle;
    const torsoOk = this._torsoLean(w) <= this.o.maxTorsoLeanDeg;
    const bothExtended = lAngle > this.o.upAngle && rAngle > this.o.upAngle;

    if (this.phase !== 'DOWN' && frontDeep && bothBent) {
      this.downStartTs = ts;
      this.reachedDepth = false;
      this._emitDown({ l: lAngle, r: rAngle });
    } else if (this.phase === 'DOWN') {
      if (bothBent && torsoOk) this.reachedDepth = true;
      if (bothExtended) {
        if (this._tryComplete(ts)) this._emitUp({ l: lAngle, r: rAngle });
        else this.phase = 'UP';
      }
    } else {
      this.phase = 'UP';
      this.o.onState?.('UP', { l: lAngle, r: rAngle });
    }
  }

  // EMA por pierna para el lunge
  _smoothPair(key, angle) {
    this._emaPair ??= {};
    const prev = this._emaPair[key];
    const v = prev == null ? angle : this.o.emaAlpha * angle + (1 - this.o.emaAlpha) * prev;
    this._emaPair[key] = v;
    return v;
  }
}

// ── Ejemplo de cableado ───────────────────────────────────────────────
// import { PoseTracker } from './pose-tracker.js';
// import { RepCounter } from './rep-counter.js';
//
// const counter = new RepCounter('squat', {
//   onRep:   (n) => { ui.setReps(n); if (n >= target) finishWorkout(); },
//   onState: (phase, info) => ui.setBadge(phase, info),
// });
// const tracker = new PoseTracker({ onResult: (r) => counter.update(r), fps: 20 });
// await tracker.start(videoEl);
// // al terminar:
// await tracker.stop();   // libera cámara/WebGL — clave para no fugar memoria
