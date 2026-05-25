# 02 — Sistema de alarma (cómo funciona HOY)

La alarma tiene **4 capas independientes** que intentan dispararla en distintos contextos
(app abierta, app en background, app cerrada). Esto es porque una alarma confiable no se
puede lograr solo con JavaScript en una página web.

## 2.1 Modelo de datos de una alarma

Cada alarma vive en `state.alarms` y se persiste en `localStorage['bac_alarms_list']`:

```js
{
  id: 1716600000000,   // Date.now() al crearla
  hour: 6,             // 1..12 (formato 12h)
  min: 30,
  ampm: 'AM',
  exercise: 'squat',   // 'squat' | 'lunge'
  targetReps: 10,
  active: true,
  lastTriggered: ''    // toDateString() del día que ya sonó (evita doble disparo el mismo día)
}
```

CRUD en `saveAlarm` / `deleteAlarm` / `toggleAlarmById`. Cada cambio dispara `saveAlarms()`,
que reescribe localStorage y **resincroniza las 4 capas**:

```js
function saveAlarms() {
  localStorage.setItem('bac_alarms_list', JSON.stringify(state.alarms));
  syncAlarmsToSW();                 // capa 2: Service Worker
  scheduleCapacitorAlarms();        // capa 3: Capacitor LocalNotifications
  syncNativeAlarms(state.alarms);   // capa 4: AlarmManager nativo (Android)
}
```

## 2.2 Capa 1 — `setInterval` en la página (solo app abierta)

`setupAlarmChecker()` revisa cada segundo si alguna alarma coincide con la hora actual:

```js
state.alarmInterval = setInterval(() => {
  if (state.isRinging) return;
  const now = new Date(), h = now.getHours(), m = now.getMinutes(), today = now.toDateString();
  for (const alarm of state.alarms) {
    if (!alarm.active) continue;
    if (alarm.lastTriggered === today) continue;     // ya sonó hoy
    let ah = alarm.hour;
    if (alarm.ampm === 'PM' && ah !== 12) ah += 12;
    if (alarm.ampm === 'AM' && ah === 12) ah = 0;
    if (h === ah && m === alarm.min) {               // coincide hora y minuto exactos
      alarm.lastTriggered = today;
      saveAlarms();
      state.currentAlarm = alarm;
      triggerAlarm();
      break;
    }
  }
}, 1000);
```

> Solo funciona con la app **abierta y en primer plano**. En móvil, los timers de pestañas
> en background se estrangulan/suspenden. El comentario del código dice que "si despierta a
> mitad de minuto sigue sonando", pero como exige `m === alarm.min`, si despierta al minuto
> siguiente **no dispara**.

## 2.3 Capa 2 — Service Worker (`sw.js`, web/PWA con app cerrada)

`saveAlarms` → `syncAlarmsToSW()` envía las alarmas por `postMessage`. El SW las agenda con
`setTimeout`:

```js
function scheduleAlarms(alarms) {
  clearAlarmTimeouts();
  const now = new Date();
  for (const alarm of alarms) {
    if (!alarm.active || alarm.lastTriggered === now.toDateString()) continue;
    // 12h → 24h, calcula delay hasta hoy
    const target = new Date(); target.setHours(ah, alarm.min, 0, 0);
    let delay = target - now;
    if (delay < 0) continue;
    pendingAlarmTimeouts.push(setTimeout(() => fireAlarm(alarm), delay));
  }
}

async function fireAlarm(alarm) {
  const openClients = await self.clients.matchAll({ type: 'window' });
  if (openClients.length > 0) {
    openClients.forEach(c => c.postMessage({ type: 'ALARM_TRIGGERED', alarmId: alarm.id }));
    return;                                  // la página lo maneja
  }
  // app cerrada → muestra notificación
  await self.registration.showNotification('🍑 BootyAlarm', {
    body: `...Hora de tus ${alarm.targetReps} ${exName}...`,
    requireInteraction: true,
    vibrate: [400,100,400,100,800],
    actions: [{ action: 'start', title: '💪 ¡A darle!' }],
    data: { alarmId: alarm.id }
  });
}
```

Click en la notificación (`notificationclick`): enfoca una ventana abierta y le manda
`ALARM_TRIGGERED`, o abre `/?alarm=<id>`.

> ❌ **Falla de raíz:** los Service Workers se **terminan cuando están inactivos** (segundos).
> Un `setTimeout` para dentro de horas **no sobrevive**. Esta capa es poco fiable para
> alarmas reales. Lo correcto sería la *Notification Triggers API* (soporte limitado) o,
> mejor, depender de la capa nativa.

## 2.4 Capa 3 — Capacitor LocalNotifications (iOS + Android)

`scheduleCapacitorAlarms()` cancela lo pendiente y reprograma una notificación diaria por
alarma:

```js
const perm = await _capLN.requestPermissions();        // pide permiso CADA vez
if (perm.display !== 'granted') return;
// cancela pendientes...
notifications.push({
  id: alarm.id,
  title: '🍑 BootyAlarm',
  body: `¡Son las ${alarm.hour}:${min} ${alarm.ampm}! Hora de tus ${alarm.targetReps} ${exName}...`,
  schedule: { at: target, every: 'day', count: 730, allowWhileIdle: true },
  extra: { alarmId: alarm.id },
  sound: 'default',
});
await _capLN.schedule({ notifications });
```

Listeners (`_setupCapacitorNotifListener`):

```js
_capLN.addListener('localNotificationActionPerformed', data => {
  const alarmId = data.notification?.extra?.alarmId;     // al tocar la notificación
  if (alarmId && state.user) _handleAlarmFromSW(alarmId);
});
_capLN.addListener('localNotificationReceived', data => {
  const alarmId = data.extra?.alarmId;                   // ⚠️ forma distinta del objeto
  if (alarmId && state.user && !state.isRinging) _handleAlarmFromSW(alarmId);
});
```

Esta es la capa **más fiable** porque el SO entrega la notificación aunque la app esté
cerrada. Funciona en iOS (donde no hay Service Workers en WKWebView) y en Android.

## 2.5 Capa 4 — AlarmManager nativo (Android, sobrevive a Doze)

`alarm-plugin.js` (puente JS) → `AlarmPlugin.java`:

```java
am.setAlarmClock(new AlarmManager.AlarmClockInfo(timeMs, pi), pi);
```

`setAlarmClock` es exacto, sobrevive a Doze y está exento de optimización de batería. Al
dispararse, `AlarmReceiver` muestra una notificación vía `NotificationHelper` (canal
`IMPORTANCE_HIGH`, `setBypassDnd(true)`, `CATEGORY_ALARM`), que al tocarse abre `MainActivity`
con el extra `alarm_id`.

> ❌ **Hueco:** `MainActivity` recibe el intent con `alarm_id`, pero **nadie lee ese extra
> dentro del WebView**. `checkNotificationLaunch()` solo lee parámetros de la URL
> (`?alarm=`), no el extra del intent nativo. Resultado: la capa AlarmManager **abre la app
> pero NO arranca el workout automáticamente**.

## 2.6 El flujo completo: notificación → cámara → ejercicio → apagar

```
Hora de la alarma
   │
   ├─ app abierta  → setInterval / SW postMessage → triggerAlarm()
   └─ app cerrada  → notificación (SW / Capacitor / AlarmManager)
                        └─ usuario toca → _handleAlarmFromSW(id) → triggerAlarm()

triggerAlarm():
   state.isRinging = true
   unlockAudio()                    // reactiva AudioContext
   playAlarmSound()                 // pitidos Web Audio (sawtooth, escalan en volumen) + vibración
   startWorkoutScreen()             // abre pantalla de workout
        ├─ playWorkoutMusic()       // <audio loop> con MP3 remoto (Junior H)
        ├─ requestWakeLock()        // pantalla encendida
        └─ initCamera() → initPoseDetection()  // empieza a contar reps

Por cada rep válida → repComplete() (pitido de coach)
Al llegar a targetReps → workoutComplete():
   stopAlarmSound()   // isRinging=false, limpia timers, vibrate(0)
   stopWorkoutMusic()
   releaseWakeLock()
   mediapipeCamera.stop(); camStream tracks.stop()
   actualiza racha/stats → saveStats()
   showCelebration()  // confeti
```

## 2.7 Audio

- **Pitido de alarma** (`playAlarmSound`): osciladores Web Audio (`sawtooth` 1100→820 Hz, 3
  pitidos), volumen escalante (`0.55 + tick*0.09`), repetido por `setTimeout` cada 1100 ms
  mientras `isRinging`. Vibración `[200,80,200,80,200]`. Pasa por un `DynamicsCompressor`
  maestro para sonar más fuerte.
- **Música de workout**: dos elementos `<audio loop preload="auto">` con MP3 remotos:
  - `workout-music` → alarma (Junior H, Cloudinary)
  - `qc-music` → reto rápido (Eden Muñoz, Cloudinary)
- **Desbloqueo de autoplay**: `unlockAudio()` crea/reanuda el `AudioContext`, y
  `_unlockAudioElements()` hace play+pause silencioso en el primer gesto del usuario
  (`touchstart`/`click`), porque los navegadores móviles solo permiten `audio.play()` dentro
  de un gesto. Hay reintentos (`_musicRetryFn`) si el autoplay sigue bloqueado.
- Pitidos por rep: `playFirstRepSound()` (arpegio Do-Mi-Sol-Do + whoosh de ruido) y
  `playRepBeep()` (square 2600→2000 Hz + sub-bajo 120→60 Hz).

> ❌ Los pitidos Web Audio **no suenan en background** (el `AudioContext` queda suspendido).
> Así que la promesa "la alarma no para hasta que entrenes" **solo se cumple con la app en
> primer plano**; si el usuario cierra o manda la app a background, el sonido para. La capa
> nativa solo muestra una notificación, no reproduce un sonido en loop persistente.

> ⚠️ **Licencias:** los dos MP3 son canciones comerciales (Junior H, Eden Muñoz) servidas
> desde una cuenta de Cloudinary. Esto es un riesgo legal y de disponibilidad (si la cuenta
> cae o se borra el asset, no hay música, y offline tampoco). El proyecto nuevo debe usar
> audio con licencia clara y empaquetado localmente.

## 2.8 Wake Lock

```js
async function requestWakeLock() {
  if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
}
```
> ⚠️ El Wake Lock se libera solo cuando la pestaña pasa a background y **no se re-adquiere**
> al volver (`visibilitychange`). Durante un workout, si el usuario sale y vuelve, la
> pantalla puede volver a apagarse.
