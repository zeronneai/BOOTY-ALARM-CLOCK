# 03 — localStorage, rachas y retos (cómo funciona HOY)

No hay backend. Todo se guarda en `localStorage` del navegador/WebView con prefijo `bac_`.

## 3.1 Claves usadas

| Clave | Tipo | Contenido |
|---|---|---|
| `bac_user` | JSON | `{ name, avatar, since }` |
| `bac_streak` | número | Racha actual (días seguidos) |
| `bac_best` | número | Mejor racha histórica |
| `bac_total` | número | "Total squats" (en realidad suma reps de squats **y** lunges) |
| `bac_alarms` | número | Total de workouts completados |
| `bac_last` | string | `toDateString()` del último día completado |
| `bac_week` | JSON | `{ weekNum, days: [0..6] }` días entrenados de la semana ISO actual |
| `bac_alarms_list` | JSON | Array de alarmas (ver `02`) |
| `bac_alarm` | JSON | Alarma única antigua (formato legacy, solo para migración) |

## 3.2 Lectura (al iniciar / login)

```js
function loadStats() {
  state.streak       = parseInt(localStorage.getItem('bac_streak') || '0');
  state.bestStreak   = parseInt(localStorage.getItem('bac_best')   || '0');
  state.totalSquats  = parseInt(localStorage.getItem('bac_total')  || '0');
  state.totalAlarms  = parseInt(localStorage.getItem('bac_alarms') || '0');
  state.lastCompleted = localStorage.getItem('bac_last') || '';

  const curWeek = getWeekNum();
  let saved = JSON.parse(localStorage.getItem('bac_week') || '{"weekNum":0,"days":[]}');
  if (Array.isArray(saved)) saved = { weekNum: 0, days: saved };   // migra formato viejo
  if (saved.weekNum !== curWeek) saved = { weekNum: curWeek, days: [] }; // reset semanal
  state.weekDays = saved.days;
  state.weekNum  = curWeek;
}
```

## 3.3 Escritura

```js
function saveStats() {
  localStorage.setItem('bac_streak',  state.streak);
  localStorage.setItem('bac_best',    state.bestStreak);
  localStorage.setItem('bac_total',   state.totalSquats);
  localStorage.setItem('bac_alarms',  state.totalAlarms);
  localStorage.setItem('bac_last',    state.lastCompleted);
  localStorage.setItem('bac_week',    JSON.stringify({ weekNum: state.weekNum, days: state.weekDays }));
}
```

## 3.4 Cómo se suma la racha

**Todo el cálculo de racha ocurre solo al completar un workout**, en `workoutComplete()`:

```js
const today     = new Date().toDateString();
const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);

if (state.lastCompleted === today) {
  // ya entrenó hoy → no toca la racha (permite varios workouts/día)
} else if (state.lastCompleted === yesterday.toDateString()) {
  state.streak++;                       // día consecutivo
} else if (!state.lastCompleted) {
  state.streak = 1;                     // primer día de la historia
} else {
  state.streak = 1;                     // se rompió la racha → reinicia a 1
}

state.lastCompleted  = today;
state.totalSquats   += state.targetReps;   // suma la META, no las reps reales
state.totalAlarms++;
if (state.streak > state.bestStreak) state.bestStreak = state.streak;

// marca el día de la semana
const dayIdx = new Date().getDay();
if (!state.weekDays.includes(dayIdx)) state.weekDays.push(dayIdx);
saveStats();
```

## 3.5 Retos rápidos (quick challenges)

Un "reto" no es una alarma guardada: es un workout inmediato lanzado por botón
(`quickChallenge(reps)`), con `state.isRinging = false`. Usa la **misma** ruta
(`startWorkoutScreen` → cámara → `workoutComplete`), así que **suma a la racha y a los totales
igual que una alarma**. La diferencia es solo la música (`qc-music` vs `workout-music`) y el
texto del banner.

## 3.6 Semana

`getWeekNum()` calcula un número de semana aproximado del año:

```js
function getWeekNum() {
  const d = new Date();
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
}
```
Se usa para resetear `weekDays` cuando cambia la semana. `renderWeek()` pinta Dom..Sáb y
marca con ✅ los días en `weekDays`.

## 3.7 Logout

```js
function logout() {
  stopAlarmSound(); stopWorkoutMusic();
  localStorage.clear();                 // ⚠️ borra TODO el origin, no solo bac_*
  // ...reset de state...
}
```

## 3.8 Problemas conocidos (resumen — detalle en `04`)

- La **racha mostrada miente**: no se decrementa al perder un día hasta que vuelves a
  entrenar. Si tu última sesión fue hace 5 días, la home sigue mostrando la racha vieja.
- `JSON.parse` sin `try/catch` en `loadAlarms` y `bac_week` → datos corruptos rompen la app.
- `bac_total` mezcla squats y lunges y suma la **meta**, no las reps reales.
- `localStorage.clear()` en logout borra **todo** el origin.
- `getWeekNum()` es frágil en bordes de año.
- Persistencia única por dispositivo, sin export/backup; el navegador puede desalojarla.
