// storage.js — Capa de almacenamiento robusta (resuelve C1–C4).
//
// Mejoras frente al código viejo:
//   • Lectura tolerante a corrupción (try/catch + default) — el viejo hacía JSON.parse pelado.
//   • Esquema VERSIONADO con migración.
//   • Racha que NO miente: expiración perezosa al leer (getCurrentStreak).
//   • Totales reales por ejercicio (no suma la meta, suma reps reales).
//   • clearAll() borra SOLO claves namespaced (el viejo hacía localStorage.clear()).
//   • Export/import JSON para respaldo (no hay backend, por decisión del proyecto).

const NS = 'bac:';            // namespace de todas las claves
const KEY = NS + 'state';     // un único blob versionado
const SCHEMA_VERSION = 2;

const DEFAULT_STATE = {
  version: SCHEMA_VERSION,
  user: null,                 // { name, avatar, since }
  streak: 0,
  bestStreak: 0,
  lastCompleted: '',          // 'YYYY-MM-DD'
  totals: { squat: 0, lunge: 0, workouts: 0 }, // reps REALES por ejercicio
  week: { iso: '', days: [] }, // ISO week "2026-W21" + días [0..6]
  alarms: [],                 // [{ id, hour, min, ampm, exercise, targetReps, active, lastTriggered }]
};

// ── Fechas en local time, formato estable ──────────────────────────────
function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysBetween(a, b) {
  // diferencia en días naturales entre dos 'YYYY-MM-DD'
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;        // lunes=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3);     // jueves de esta semana
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── Lectura/escritura seguras ──────────────────────────────────────────
function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function migrate(s) {
  if (!s || typeof s !== 'object') return { ...DEFAULT_STATE };
  // v1 (claves sueltas bac_*) -> v2 (blob único). Migración best-effort.
  if (!s.version) {
    const migrated = { ...DEFAULT_STATE };
    try {
      migrated.user = safeParse(localStorage.getItem('bac_user'), null);
      migrated.streak = parseInt(localStorage.getItem('bac_streak') || '0', 10);
      migrated.bestStreak = parseInt(localStorage.getItem('bac_best') || '0', 10);
      migrated.totals.squat = parseInt(localStorage.getItem('bac_total') || '0', 10);
      migrated.totals.workouts = parseInt(localStorage.getItem('bac_alarms') || '0', 10);
      migrated.alarms = safeParse(localStorage.getItem('bac_alarms_list'), []);
    } catch { /* ignora; usa defaults */ }
    return migrated;
  }
  return { ...DEFAULT_STATE, ...s, totals: { ...DEFAULT_STATE.totals, ...(s.totals || {}) } };
}

let _cache = null;

export function load() {
  if (_cache) return _cache;
  const parsed = safeParse(localStorage.getItem(KEY), null);
  _cache = migrate(parsed);
  // resetea la semana si cambió la ISO week
  const wk = isoWeek();
  if (_cache.week.iso !== wk) _cache.week = { iso: wk, days: [] };
  save();
  return _cache;
}

export function save() {
  if (!_cache) return;
  _cache.version = SCHEMA_VERSION;
  try { localStorage.setItem(KEY, JSON.stringify(_cache)); }
  catch (e) { console.warn('[storage] no se pudo guardar:', e); }
}

// ── RACHA que no miente (C1) ───────────────────────────────────────────
// La racha real depende de HOY. Si la última sesión fue antes de ayer, la racha es 0.
export function getCurrentStreak() {
  const s = load();
  if (!s.lastCompleted) return 0;
  const gap = daysBetween(s.lastCompleted, ymd());
  if (gap <= 0) return s.streak;   // hoy
  if (gap === 1) return s.streak;  // ayer: aún viva (hoy a tiempo de continuar)
  return 0;                        // se rompió
}

// ── Registrar una rep VÁLIDA (suma real, C4) ───────────────────────────
export function recordRep(exercise) {
  const s = load();
  if (exercise === 'squat' || exercise === 'lunge') s.totals[exercise] += 1;
  save();
}

// ── Completar un workout: actualiza racha con lógica correcta ───────────
export function completeWorkout(exercise) {
  const s = load();
  const today = ymd();

  if (s.lastCompleted === today) {
    // ya entrenó hoy: no toca la racha
  } else {
    const gap = s.lastCompleted ? daysBetween(s.lastCompleted, today) : Infinity;
    if (gap === 1) s.streak += 1;     // día consecutivo
    else s.streak = 1;                // primer día o racha rota
  }

  s.lastCompleted = today;
  s.totals.workouts += 1;
  if (s.streak > s.bestStreak) s.bestStreak = s.streak;

  const wk = isoWeek();
  if (s.week.iso !== wk) s.week = { iso: wk, days: [] };
  const dow = new Date().getDay();
  if (!s.week.days.includes(dow)) s.week.days.push(dow);

  save();
  return { streak: s.streak, bestStreak: s.bestStreak, totals: s.totals };
}

// ── Usuario / alarmas ──────────────────────────────────────────────────
export function setUser(user) { const s = load(); s.user = user; save(); }
export function getUser() { return load().user; }
export function getAlarms() { return load().alarms; }
export function setAlarms(alarms) { const s = load(); s.alarms = alarms; save(); }

// ── Logout: borra SOLO claves de la app (C3) ───────────────────────────
export function clearAll() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith(NS) || k.startsWith('bac_'))
    .forEach((k) => localStorage.removeItem(k));
  _cache = null;
}

// ── Respaldo manual (no hay backend) ───────────────────────────────────
export function exportJSON() { return JSON.stringify(load(), null, 2); }
export function importJSON(json) {
  const parsed = safeParse(json, null);
  if (!parsed) throw new Error('JSON inválido');
  _cache = migrate(parsed);
  save();
  return _cache;
}
