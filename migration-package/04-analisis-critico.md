# 04 — Análisis crítico + cómo hacerlo bien (lo más importante)

Cada punto: **qué está mal hoy → por qué importa → cómo se hace moderno**. Ordenado por
gravedad. Las implementaciones de referencia están en `codigo-mejorado/`.

---

## A. DETECCIÓN DE POSE Y CONTEO

### A1. 🔴 Librería deprecada y sin versión fijada (fragilidad crítica)
**Hoy:** `@mediapipe/pose` (solución *legacy*) cargada por CDN **sin `@version`**.
- Google **deprecó** esta solución; no recibe mantenimiento ni parches.
- Sin pin de versión, jsdelivr puede servir otra build (o el paquete puede desaparecer) y la
  app **se rompe en silencio** sin que cambies una línea. No hay SRI ni fallback.
- Depende de red en cada arranque (mal para offline; contradice ser una PWA).

**Moderno:**
- Migrar a **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`, `PoseLandmarker`), que es la
  API soportada y activa. Alternativa: **TensorFlow.js MoveNet** (Lightning/Thunder) si
  quieres algo más ligero.
- **Fijar versión exacta** e instalar por npm; **auto-hospedar** el `.wasm` y el `.task`
  (modelo) como assets locales para que funcione offline y no dependa de un CDN externo.
- Usar el modo `VIDEO` con `detectForVideo(video, timestamp)` manejado por
  `video.requestVideoFrameCallback`, en vez del utilitario `Camera` legacy.

Ver `codigo-mejorado/pose-tracker.js`.

### A2. 🔴 Fuga de memoria: `poseInstance.close()` nunca se llama
**Hoy:** cada `startWorkoutScreen()` crea `new Pose(...)` en `initPoseDetection`. Al terminar
solo se hace `mediapipeCamera.stop()` y se paran los tracks; **la instancia de Pose (WASM +
contexto WebGL) nunca se libera**.
- Cada alarma/reto deja un contexto WebGL colgado. Los navegadores limitan ~8–16 contextos
  WebGL vivos; tras varios workouts, **la detección deja de inicializar** (y el consumo de RAM
  crece sin parar).
- `video.srcObject` tampoco se limpia.

**Moderno:** ciclo de vida explícito. Crear **una sola** instancia y reutilizarla, o si se
recrea, `await poseLandmarker.close()` y `video.srcObject = null` al terminar. Cancelar el
`requestVideoFrameCallback`. Ver el método `dispose()` en `pose-tracker.js`.

### A3. 🔴 El conteo es trivial de hacer trampa
**Hoy:** la rep se cuenta solo con el ángulo de rodilla cruzando 2 umbrales.
- **Squat:** promedia ambas rodillas en **2D**. Puedes contar reps **sentado** flexionando y
  estirando las rodillas, o moviendo la pierna, sin hacer una sentadilla real. No valida que
  la cadera baje, ni postura, ni que estés de pie entre reps.
- **Lunge:** usa el **mínimo** de las dos rodillas → basta **levantar/flexionar una sola
  pierna** (marcha en el sitio) para sumar reps.
- `MIN_VIS = 0.1` es casi nulo y **ni siquiera se aplica** en los detectores → cuenta poses
  basura/parciales.
- No exige cuerpo completo en cuadro, ni rango de movimiento real, ni duración plausible.

**Moderno (anti-trampa):**
1. **Landmarks 3D del mundo** (`worldLandmarks`, en metros) para ángulos invariantes a la
   perspectiva, no solo `x,y` de pantalla.
2. **Validación de profundidad real** del squat: la cadera debe bajar respecto a la rodilla
   (Δy cadera–rodilla por encima de un umbral), no solo el ángulo.
3. **Gating de visibilidad por articulación** (umbral ~0.6) y exigir **ambas piernas + cadera
   + tobillos** visibles; si no, no se cuenta y se avisa "ponte en cuadro".
4. **Postura del torso** (hombros–cadera razonablemente vertical) para descartar "agacharse".
5. **Duración mínima y máxima de rep** (p. ej. 600 ms–8 s) → descarta sacudidas y
   movimientos imposibles.
6. **Rango de movimiento (ROM):** exigir que el ángulo llegue tanto a un mínimo profundo
   como a una extensión casi completa (histéresis amplia) y, opcionalmente, que el ángulo de
   cadera también cambie.
7. **Lunge correcto:** detectar la pierna que da el paso y exigir flexión en **ambas** rodillas
   (delantera ~90°, trasera bajando), no el mínimo de una.
8. **Suavizado temporal (EMA)** del ángulo para no contar por jitter de un frame.

Todo esto está implementado en `codigo-mejorado/rep-counter.js`.

### A4. 🟠 Sin suavizado ni gating de confianza por frame
**Hoy:** se actúa sobre el ángulo crudo de cada frame. Un frame ruidoso o una oclusión puede
disparar transiciones. La histéresis ayuda pero no filtra ruido dentro de cada estado.
**Moderno:** EMA sobre el ángulo + ignorar frames con baja confianza/visibilidad + requerir N
frames consistentes para cambiar de estado.

### A5. 🟠 Rendimiento y batería no controlados
**Hoy:** `modelComplexity: 1` procesando **cada frame** vía `Camera`. En gama media/baja la
inferencia va más lenta que el frame rate → lag, calor y batería.
**Moderno:** delegado **GPU**, resolución de captura modesta (480–640), **cap de FPS** (p. ej.
15–24) y *frame dropping* (saltar frame si el anterior sigue procesándose) con
`requestVideoFrameCallback`. Elegir `lite` para móviles.

### A6. 🟡 "Modo manual" muerto + `isVisible()` sin uso
**Hoy:** `startManualMode()` solo muestra un error; `isVisible()` está definida pero nunca se
llama. Código muerto que confunde.
**Moderno:** o implementas un fallback honesto (contador manual por tap con aviso) o lo
eliminas. Aplicar de verdad el gating de visibilidad.

---

## B. ALARMA

### B1. 🔴 La promesa central ("no se apaga hasta entrenar") es evadible
**Hoy:** el sonido de alarma son osciladores Web Audio en la página. En **background el
`AudioContext` se suspende** → el sonido para. Cerrar/segundo plano = alarma silenciada. La
capa nativa solo **muestra una notificación**, no reproduce un sonido en loop persistente ni
fuerza la pantalla de ejercicio.
**Moderno (para que sea una alarma de verdad):**
- En Android: **`AlarmManager.setAlarmClock`** + **Foreground Service** que reproduce un
  `Ringtone`/`MediaPlayer` en loop (canal `IMPORTANCE_HIGH`, `CATEGORY_ALARM`, `setBypassDnd`)
  + **full-screen intent** (`USE_FULL_SCREEN_INTENT`) que abre directo la pantalla de
  ejercicio sobre el lockscreen. El audio lo detiene el **código nativo** solo cuando el
  WebView avisa "workout completado". Ver `codigo-mejorado/alarm-native.md`.
- En iOS: no se puede forzar una "alarma imparable" en segundo plano (limitación del SO);
  lo realista es una *critical/time-sensitive notification* con sonido y, al abrir, la
  pantalla de ejercicio. Hay que ser honesto: iOS no permite el "no se apaga" estricto.

### B2. 🔴 Timers de Service Worker no sobreviven (capa 2 poco fiable)
**Hoy:** el SW agenda con `setTimeout` para horas en el futuro, pero el navegador **mata el SW
inactivo en segundos**, perdiendo el timeout.
**Moderno:** no confiar en `setTimeout` del SW. Para web usar **Notification Triggers API**
(`showTrigger: new TimestampTrigger(ts)`) donde exista; documentar que el soporte es parcial.
La fiabilidad real viene de la capa nativa (B1). Mantener el SW solo para cache offline.

### B3. 🟠 El intent nativo de AlarmManager no arranca el workout
**Hoy:** `AlarmReceiver` → notificación → abre `MainActivity` con extra `alarm_id`, pero **el
WebView nunca lee ese extra**. `checkNotificationLaunch()` solo lee `?alarm=` de la URL.
**Moderno:** que `MainActivity` lea el extra en `onCreate`/`onNewIntent` y lo inyecte al
WebView (vía `bridge.eval` / `appUrlOpen` / evento Capacitor), para que la página llame a
`triggerAlarm(alarmId)`. Unificar todas las capas en **un solo** `handleAlarm(id)`.

### B4. 🟠 Permisos pedidos de más y sin estrategia
**Hoy:** `scheduleCapacitorAlarms()` (y por ende `requestPermissions()`) corre en init, login y
**en cada `saveAlarms()`**. La cámara se pide con `getUserMedia` directo, sin contexto previo
ni recuperación si se niega.
**Moderno:**
- Pedir permisos **una sola vez**, con pantalla de *priming* que explique por qué, justo antes
  de necesitarlos.
- Cachear el estado del permiso; no re-solicitar en cada guardado.
- Si la cámara se niega: estado claro + botón "Abrir ajustes" (Capacitor puede abrir la
  config de la app) + reintento.
- En Android 12+, manejar `SCHEDULE_EXACT_ALARM` revocable (`canScheduleExactAlarms()` y
  mandar al usuario al ajuste si hace falta).

### B5. 🟡 Riesgo de disparo múltiple y lógica de hora frágil
**Hoy:** 4 capas pueden disparar; dedupe depende de `lastTriggered === today` + `isRinging`.
El `setInterval` exige `m === alarm.min` exacto (si despierta un minuto tarde, no suena).
**Moderno:** comparar contra un **timestamp objetivo** (≤ ahora y no disparada) en vez de
igualdad hora/minuto; un único *guard* central de "alarma X ya disparada en la ventana Y".
Modelar repetición/días de semana con timestamps, no con strings AM/PM.

### B6. 🟡 Audio con copyright y dependiente de red
**Hoy:** MP3 comerciales (Junior H, Eden Muñoz) servidos desde Cloudinary. Riesgo legal,
sin offline, y si el asset se borra no hay música.
**Moderno:** audio con licencia clara (o generado), **empaquetado local** (`preload`/cacheado
por el SW), y para la alarma usar sonido **nativo** (B1), no `<audio>` del WebView.

### B7. 🟡 Wake Lock no se re-adquiere
**Hoy:** al volver de background el wake lock no se re-pide.
**Moderno:** re-`request('screen')` en `visibilitychange` mientras el workout esté activo.

---

## C. ALMACENAMIENTO Y RACHAS

### C1. 🔴 La racha mostrada miente (no expira)
**Hoy:** la racha solo se recalcula al completar un workout. Si faltas días, la home sigue
mostrando el número viejo hasta que vuelvas a entrenar.
**Moderno:** **expiración perezosa al cargar**: comparar `lastCompleted` con hoy; si la
diferencia es > 1 día, la racha mostrada es 0 (o se reinicia). Implementado en
`codigo-mejorado/storage.js` (`getCurrentStreak()`).

### C2. 🔴 `JSON.parse` sin protección → corrupción rompe la app
**Hoy:** `loadAlarms()` hace `JSON.parse(raw)` sin `try/catch`; ídem `bac_week`.
**Moderno:** lector seguro con `try/catch`, valor por defecto y **versión de esquema** para
migraciones. Ver `safeGet`/`migrate` en `storage.js`.

### C3. 🟠 `localStorage.clear()` en logout borra todo el origin
**Hoy:** elimina cualquier clave del origin, no solo `bac_*`.
**Moderno:** borrar **solo** las claves namespaced de la app (`Object.keys` filtrando el
prefijo). Ver `clearAll()` en `storage.js`.

### C4. 🟠 `bac_total` mezcla ejercicios y cuenta la meta, no lo real
**Hoy:** "Total squats" suma `targetReps` de squats **y** lunges.
**Moderno:** contar **reps reales completadas** y separar contadores por ejercicio
(`totals.squat`, `totals.lunge`). Sumar al completar cada rep válida, no la meta.

### C5. 🟡 Cálculo de semana frágil y persistencia sin respaldo
**Hoy:** `getWeekNum()` casero, frágil en bordes de año; datos solo en localStorage, sin
export/import, desalojables por el navegador.
**Moderno:** usar fechas ISO (o una util como `date-fns`) para semana; ofrecer
**export/import JSON** como respaldo manual; considerar **IndexedDB** si los datos crecen
(historial de sesiones). El usuario no quiere Supabase: documentar que sin backend la
sincronización entre dispositivos no existe y el respaldo es responsabilidad del usuario.

---

## D. ARQUITECTURA Y CALIDAD GENERAL

### D1. 🟠 Todo en un solo `index.html` con estado global mutable
**Hoy:** ~2800 líneas, un objeto `state` global, funciones sueltas, lógica de UI/audio/pose/
alarma entremezclada.
**Moderno:** modularizar por dominio (`pose/`, `alarm/`, `storage/`, `audio/`, `ui/`),
ESM + bundler (Vite). Considerar un framework ligero (Svelte/Preact/Lit) o al menos separar
lógica de DOM. Mantenerlo testeable (la lógica de reps y rachas debe ser funciones puras
testeables sin DOM).

### D2. 🟡 Sin manejo de errores observable y `catch(e){}` vacíos
**Hoy:** muchos `try { } catch(e) {}` que tragan errores en silencio (audio, wake lock, pose).
Difícil de depurar.
**Moderno:** logging mínimo (incluso `console.warn`) y estados de error visibles al usuario
donde importa (cámara, permisos).

### D3. 🟡 PWA: íconos y assets dependientes de Cloudinary
**Hoy:** `manifest.json` referencia íconos remotos en Cloudinary; el SW hace de proxy.
**Moderno:** íconos locales en el repo, versionados; el SW cachea app shell local.

### D4. 🟢 Lo que SÍ está bien (conservar)
- La privacidad: **la pose se procesa 100% on-device**, no se sube video. Mantenerlo.
- La idea de **múltiples capas** de alarma para cubrir background — la dirección es correcta,
  solo hay que arreglar las capas (B1–B3).
- La **histéresis** down/up con dos umbrales separados (evita rebote) — buena base; mejórala
  con 3D + validaciones.
- El **cooldown** anti-doble-conteo y el flag `workoutDone`.
- El **desbloqueo de audio** en el gesto del usuario (necesario en móvil); reusar el patrón.

---

## Prioridades sugeridas para el proyecto nuevo

1. **Pose moderna + anti-trampa + sin fugas** (A1, A2, A3) → `pose-tracker.js` + `rep-counter.js`.
2. **Alarma nativa de verdad** (B1, B3) → `alarm-native.md`.
3. **Storage robusto con racha que no miente** (C1, C2) → `storage.js`.
4. Permisos con priming (B4), audio con licencia/local (B6), modularización (D1).
