# Alarma nativa "de verdad" — guía para el proyecto nuevo (resuelve B1–B5)

El problema central del código viejo: la "alarma que no se apaga hasta entrenar" **se apaga
sola** cuando la app va a background (los pitidos Web Audio se suspenden) y las capas nativas
solo muestran una notificación pasiva. Para cumplir la promesa hay que hacer el sonido y el
disparo **nativos**.

## Capas recomendadas (y cuáles tirar)

| Capa | Veredicto |
|---|---|
| `setInterval` en la página | Mantener **solo** para cuando la app ya está abierta. No es la fuente de verdad. |
| Service Worker `setTimeout` | **Eliminar** como scheduler (el SW muere inactivo). Conservar SW solo para cache offline. Opcional: Notification Triggers API donde exista. |
| Capacitor `LocalNotifications` | Mantener como fuente de verdad en **iOS** y respaldo en Android. |
| `AlarmManager` nativo (Android) | Mantener y **completar**: debe arrancar el workout + sonar en loop. |

## Android — alarma imparable correcta

1. **Programar** con `AlarmManager.setAlarmClock(...)` (ya lo hace `AlarmPlugin.java`; es lo
   correcto: exacto, sobrevive a Doze, exento de optimización de batería).
2. Al disparar, en `AlarmReceiver.onReceive` **arrancar un Foreground Service** (no solo una
   notificación):
   - El servicio reproduce un `Ringtone`/`MediaPlayer` **en loop** (stream `STREAM_ALARM`),
     vibra, y publica una **notificación de servicio en primer plano** con
     `setCategory(CATEGORY_ALARM)`, `IMPORTANCE_HIGH`, `setBypassDnd(true)`.
   - Adjuntar un **full-screen intent** (`setFullScreenIntent`, permiso
     `USE_FULL_SCREEN_INTENT`) que lance `MainActivity` directamente sobre el lockscreen,
     mostrando la pantalla de ejercicio.
3. El audio en loop **solo lo detiene el código nativo** cuando el WebView avisa
   "workout completado". Expón un método de plugin `stopAlarm()` que el JS llame desde
   `completeWorkout()`. Así no se puede silenciar sin terminar las reps (salvo forzar cierre,
   que es inevitable en cualquier app).
4. Para que el lockscreen muestre la Activity: `setShowWhenLocked(true)` +
   `setTurnScreenOn(true)` en `MainActivity` (o flags equivalentes).
5. **Re-programar tras reboot**: declarar un `BootReceiver` con `RECEIVE_BOOT_COMPLETED` (ya
   está el permiso) que vuelva a agendar las alarmas activas, porque `AlarmManager` se borra
   al reiniciar.
6. **Android 12+**: comprobar `AlarmManager.canScheduleExactAlarms()`; si es false, mandar al
   usuario a `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`. (`USE_EXACT_ALARM` en API 33+ no es
   revocable y es preferible para apps de alarma.)

### Conectar el disparo nativo → arrancar el workout en el WebView (arregla B3)

El bug actual: `MainActivity` recibe el intent con `alarm_id` pero el WebView nunca lo lee.
Solución:

```java
// MainActivity.java
@Override
protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleAlarmIntent(intent);
}
@Override
protected void onCreate(Bundle b) {
    registerPlugin(AlarmPlugin.class);
    super.onCreate(b);
    handleAlarmIntent(getIntent());
}
private void handleAlarmIntent(Intent intent) {
    int id = intent != null ? intent.getIntExtra(AlarmReceiver.EXTRA_ALARM_ID, 0) : 0;
    if (id != 0 && bridge != null) {
        // Notifica al JS una sola vez que el bridge esté listo
        bridge.getWebView().post(() ->
            bridge.eval("window.dispatchEvent(new CustomEvent('native-alarm',{detail:{id:" + id + "}}))", null));
    }
}
```

```js
// en el WebView, un único punto de entrada para TODAS las capas:
window.addEventListener('native-alarm', (e) => handleAlarm(e.detail.id));
```

## iOS — lo realista

iOS **no permite** una "alarma imparable" en segundo plano para apps de terceros. Opciones:
- `LocalNotifications` con sonido (incluye sonido custom empaquetado) y, si calificas,
  *Time Sensitive* / *Critical Alerts* (las críticas requieren *entitlement* aprobado por
  Apple). Al tocar la notificación, abrir directo la pantalla de ejercicio.
- Sé honesto en la UI: en iOS el sonido lo controla el SO; cuando el usuario abre la app,
  ahí empieza el flujo de ejercicio.

## Unificación (arregla B5)

- Un **único** `handleAlarm(id)` en JS al que llaman TODAS las capas (interval, notificación
  web, Capacitor, nativo).
- Dedupe por **ventana de tiempo + flag** (no por igualdad exacta hora/minuto): "¿esta alarma
  ya disparó en los últimos N minutos?".
- Modelar la hora objetivo como **timestamp**; comparar `target <= now && !disparada`, así un
  despertar tardío de la pestaña aún dispara.

## Audio (arregla B6)

- La alarma usa **sonido nativo** (ringtone/asset empaquetado), no `<audio>` del WebView.
- La música de workout: usar audio con **licencia clara** y **empaquetado local**
  (cacheado por el SW para offline). Quitar los MP3 de Cloudinary con copyright.

## Wake lock (arregla B7)

Durante el workout, re-adquirir el screen wake lock en `visibilitychange` cuando la pantalla
vuelve a ser visible:

```js
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && workoutActive && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});
```
