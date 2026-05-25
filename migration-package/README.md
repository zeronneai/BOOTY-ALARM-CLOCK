# Paquete de migración — Cámara + Alarma (Booty Alarm Clock → proyecto nuevo)

Este paquete documenta **cómo funciona hoy** la detección de movimiento por cámara, la
alarma y el conteo de rachas en la app original (un único `index.html` de ~95 KB con
Capacitor para iOS/Android), y propone **cómo debería rehacerse, mejorada y moderna**, en
el proyecto nuevo.

> El proyecto original es una PWA + Capacitor. Toda la lógica vive en un solo archivo
> `index.html` con un `<script>` global (sin módulos, sin build, sin framework). El nuevo
> proyecto debería modularizar esto.

## Cómo usar este paquete

Si eres otra instancia de Claude Code trabajando en el proyecto nuevo: **lee primero el
análisis crítico (`04`)**, porque define las decisiones de arquitectura. Los documentos
`01`–`03` son la referencia de "qué hacía el código viejo y por qué". La carpeta
`codigo-mejorado/` contiene implementaciones de referencia listas para adaptar.

| Archivo | Contenido |
|---|---|
| `01-deteccion-camara.md` | Cómo funciona hoy la cámara + MediaPipe Pose + conteo de squats/lunges (con código real). |
| `02-alarma.md` | Cómo se programa, dispara y silencia la alarma; el flujo notificación → cámara → ejercicio → apagar; las 4 capas de scheduling. |
| `03-localstorage-rachas.md` | Modelo de datos en localStorage, cómo se leen/escriben rachas y retos. |
| `04-analisis-critico.md` | **Lo más importante.** Todo lo que está mal, frágil o explotable, con la versión moderna recomendada para cada punto. |
| `codigo-mejorado/pose-tracker.js` | Tracker de pose moderno (MediaPipe Tasks Vision `PoseLandmarker`), con ciclo de vida y liberación de memoria correctos. |
| `codigo-mejorado/rep-counter.js` | Contador de reps con **anti-trampa** (profundidad 3D, postura, duración mínima, gating de visibilidad). |
| `codigo-mejorado/storage.js` | Capa de almacenamiento robusta: versionada, tolerante a corrupción, con **expiración perezosa de racha**. |
| `codigo-mejorado/alarm-native.md` | Cómo hacer una alarma de verdad "que no se apaga hasta entrenar" (full-screen intent + foreground service). |

## Resumen del stack original

- **Pose:** `@mediapipe/pose` (Solución *legacy* de MediaPipe, **deprecada**) + `@mediapipe/camera_utils` + `@mediapipe/drawing_utils`, cargados por CDN **sin versión fijada**.
- **Cámara:** `navigator.mediaDevices.getUserMedia` (cámara frontal), frames empujados a MediaPipe por el utilitario `Camera`.
- **Alarma:** 4 capas — `setInterval` en la página, Service Worker (`setTimeout` + Notifications), Capacitor `LocalNotifications`, y `AlarmManager` nativo de Android.
- **Audio:** Web Audio API (osciladores para pitidos) + dos `<audio loop>` con MP3 remotos en Cloudinary.
- **Persistencia:** `localStorage` con claves `bac_*`. Sin backend.
- **Empaquetado:** Capacitor 6 (iOS + Android), PWA con `manifest.json` + `sw.js`.

## Qué NO se incluye aquí

- Estilos visuales / CSS / layout viejo (por pedido explícito).
- Las pistas de audio originales (MP3 con copyright en Cloudinary — ver nota de licencias en `02`).
