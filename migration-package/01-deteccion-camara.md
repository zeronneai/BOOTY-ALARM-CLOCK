# 01 — Detección de movimiento por cámara (cómo funciona HOY)

## 1.1 Librería y versión

La app usa la **Solución de Pose *legacy* de MediaPipe**, cargada por CDN en el `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js" crossorigin="anonymous"></script>
```

- **Paquete:** `@mediapipe/pose` (la solución JS antigua, expone `window.Pose`, `window.Camera`, `window.POSE_CONNECTIONS`, `drawConnectors`, `drawLandmarks`).
- **Versión:** **NO está fijada.** La URL no incluye `@x.y.z`, así que jsdelivr sirve la última publicada (que para `@mediapipe/pose` quedó congelada en `0.5.x` cuando Google deprecó la solución). No aparece en `package-lock.json` porque se carga por CDN, no por npm.
- Es un modelo **BlazePose** de 33 puntos. Corre 100% en el dispositivo (WASM + WebGL), no manda video a ningún servidor.

> ⚠️ Esta solución está **deprecada** por Google desde 2023. Reemplazo moderno: `@mediapipe/tasks-vision` (`PoseLandmarker`). Ver `04-analisis-critico.md`.

## 1.2 Activación de la cámara y permisos

La cámara se enciende en `initCamera()` (index.html ~2407):

```js
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    state.camStream = stream;
    const video = document.getElementById('workout-video');
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      setupCanvas();
      initPoseDetection(video);
    };
  } catch(err) {
    document.getElementById('cam-status-txt').textContent = '⚠️ Sin acceso a cámara — Permite el acceso en tu navegador';
    document.getElementById('cam-loading').classList.add('hidden');
    startManualMode(); // en realidad solo muestra un error: el modo manual está deshabilitado
  }
}
```

Permisos:

- **Web/PWA:** el permiso de cámara lo pide el navegador automáticamente al llamar `getUserMedia` (no hay pre-prompt ni explicación previa). Si el usuario lo niega, se cae al `catch` y se muestra un texto de error; **no hay reintento ni enlace a ajustes**.
- **Android (nativo):** `MainActivity.requestPermissionsIfNeeded()` pide `CAMERA` y `POST_NOTIFICATIONS` (API 33+) al arrancar. Si se niegan, muestra un `Toast`. Declarado en `AndroidManifest.xml`: `CAMERA`, `VIBRATE`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`.
- **iOS:** depende de `NSCameraUsageDescription` en `Info.plist` (gestionado por Capacitor).

## 1.3 Bucle de inferencia

Se usa el utilitario `Camera` de MediaPipe, que empuja cada frame del `<video>` al modelo (`initPoseDetection`, ~2438):

```js
poseInstance = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
});
poseInstance.setOptions({
  modelComplexity: 1,        // 0=lite, 1=full, 2=heavy
  smoothLandmarks: true,
  enableSegmentation: false,
  smoothSegmentation: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});
poseInstance.onResults(onPoseResults);

mediapipeCamera = new Camera(video, {
  onFrame: async () => { await poseInstance.send({ image: video }); },
  width: canvas.width,
  height: canvas.height
});
mediapipeCamera.start();
```

Cada resultado entra a `onPoseResults`, que dibuja el esqueleto y delega al detector según el ejercicio:

```js
function onPoseResults(results) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!results.poseLandmarks) return;
  // dibuja esqueleto...
  const lm = results.poseLandmarks;            // 33 landmarks normalizados [0..1]
  if (state.exercise === 'squat') detectSquat(lm);
  else                            detectLunge(lm);
}
```

## 1.4 Qué puntos del cuerpo usa

Índices de landmarks de BlazePose usados:

| Índice | Punto |
|---|---|
| 23 / 24 | cadera izquierda / derecha |
| 25 / 26 | rodilla izquierda / derecha |
| 27 / 28 | tobillo izquierdo / derecho |

El **ángulo de rodilla** se calcula como el ángulo cadera–rodilla–tobillo, con vectores 2D
(solo `x`, `y`; **ignora `z` y `visibility`**):

```js
function getAngle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x*cb.x + ab.y*cb.y;
  const magAB = Math.sqrt(ab.x**2 + ab.y**2);
  const magCB = Math.sqrt(cb.x**2 + cb.y**2);
  if (magAB === 0 || magCB === 0) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot/(magAB*magCB)))) * (180/Math.PI);
}
```

Filtro de visibilidad (extremadamente permisivo):

```js
const MIN_VIS = 0.1;  // casi acepta cualquier landmark presente
function isVisible(lm, ...indices) {
  return indices.every(i => lm[i] && (lm[i].visibility === undefined || lm[i].visibility > MIN_VIS));
}
```
> Nota: `isVisible()` **está definida pero NO se usa** en los detectores. El conteo no valida visibilidad en absoluto.

## 1.5 Conteo de squats

```js
function detectSquat(lm) {
  const lAngle    = getAngle(lm[23], lm[25], lm[27]);
  const rAngle    = getAngle(lm[24], lm[26], lm[28]);
  const kneeAngle = (lAngle + rAngle) / 2;       // promedio de ambas rodillas
  updateAngleDisplay(kneeAngle, kneeAngle < 100);

  if (kneeAngle < 100 && state.poseState === 'up') {
    state.poseState = 'down';                    // bajó
  } else if (kneeAngle > 155 && state.poseState === 'down') {
    state.poseState = 'up';
    repComplete();                               // ← cuenta la rep al SUBIR
  }
}
```

Máquina de estados con histéresis: `down` cuando el ángulo medio < **100°**, `up` cuando
> **155°**. La rep se cuenta en la transición `down → up`.

## 1.6 Conteo de lunges

Idéntico, pero usa el **mínimo** de las dos rodillas y umbrales 105/155:

```js
function detectLunge(lm) {
  const lAngle   = getAngle(lm[23], lm[25], lm[27]);
  const rAngle   = getAngle(lm[24], lm[26], lm[28]);
  const minAngle = Math.min(lAngle, rAngle);     // la rodilla más flexionada
  if (minAngle < 105 && state.poseState === 'up') {
    state.poseState = 'down';
  } else if (minAngle > 155 && state.poseState === 'down') {
    state.poseState = 'up';
    repComplete();
  }
}
```

## 1.7 Cómo evita el doble conteo

Tres mecanismos en `repComplete()` (~2587):

```js
function repComplete() {
  if (state.workoutDone) return;                       // (1) ya terminó el set
  const now = Date.now();
  if (now - state.lastRepTime < 500) return;           // (2) cooldown de 500 ms
  state.lastRepTime = now;
  state.currentReps++;
  // ...sonido + UI...
  if (state.currentReps >= state.targetReps) {
    state.workoutDone = true;                           // (3) bloquea más conteo
    setTimeout(workoutComplete, 600);
  }
}
```

1. Flag `workoutDone` que congela el conteo al llegar a la meta.
2. **Cooldown de 500 ms** entre reps.
3. La **histéresis** de la máquina de estados (hay que pasar por `down` y volver a `up`),
   que evita contar dos veces sin un ciclo completo.

## 1.8 Liberación de la cámara

En `workoutComplete()` (~2625):

```js
try { if (mediapipeCamera) { mediapipeCamera.stop(); } } catch(e) {}
mediapipeCamera = null;
if (state.camStream) {
  state.camStream.getTracks().forEach(t => t.stop());
  state.camStream = null;
}
```

> ❌ **`poseInstance.close()` NUNCA se llama.** Esto es una fuga de memoria de WASM/WebGL
> confirmada (ver `04`). `video.srcObject` tampoco se limpia.
