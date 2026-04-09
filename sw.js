// Booty Alarm Clock — Service Worker v4
// Handles: offline cache, icon proxy, alarm scheduling, push notifications

const CACHE_NAME = 'booty-alarm-v4';
const ICON_BASE  = 'https://res.cloudinary.com/dsprn0ew4/image/upload';
const ICON_PUB   = 'v1775761992/WhatsApp_Image_2026-04-09_at_1.09.51_PM_enqynv.jpg';
const APP_SHELL  = ['/', '/index.html', '/manifest.json'];

// ── In-memory alarm schedule (rebuilt from page on every SW activation) ──
let pendingAlarmTimeouts = [];

// ══════════════════════════════════════════════════════
// INSTALL — pre-cache app shell
// ══════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ══════════════════════════════════════════════════════
// ACTIVATE — delete old caches, claim clients, ask page to resync alarms
// ══════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Ask all open pages to resend their alarms so we can reschedule
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'SW_READY' }));
        });
      })
  );
});

// ══════════════════════════════════════════════════════
// FETCH — cache strategy + icon proxy
// ══════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Icon proxy: serve /icons/icon-NNN.png and /apple-touch-icon*.png from Cloudinary
  const iconMatch = url.pathname.match(/^\/icons\/icon-(\d+)\.png$/) ||
                    url.pathname.match(/^\/apple-touch-icon(-precomposed)?\.png$/);
  if (iconMatch) {
    const size = (url.pathname.match(/icon-(\d+)/) || [])[1] || '180';
    const cloudUrl = `${ICON_BASE}/w_${size},h_${size},c_fill,f_png/${ICON_PUB}`;
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(cloudUrl).then(r => {
          if (r.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone()));
          return r;
        }).catch(() => caches.match(event.request));
      })
    );
    return;
  }

  // CDN (MediaPipe, Fonts, Cloudinary audio) — network-first
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(event.request)
        .then(r => {
          if (r.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone()));
          return r;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Local assets — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(r => {
        if (r.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone()));
        return r;
      });
    })
  );
});

// ══════════════════════════════════════════════════════
// ALARM SCHEDULING
// ══════════════════════════════════════════════════════
function clearAlarmTimeouts() {
  pendingAlarmTimeouts.forEach(clearTimeout);
  pendingAlarmTimeouts = [];
}

function scheduleAlarms(alarms) {
  clearAlarmTimeouts();
  const now   = new Date();
  const today = now.toDateString();

  for (const alarm of alarms) {
    if (!alarm.active) continue;
    if (alarm.lastTriggered === today) continue; // already fired today

    // Convert 12h → 24h
    let ah = alarm.hour;
    if (alarm.ampm === 'PM' && ah !== 12) ah += 12;
    if (alarm.ampm === 'AM' && ah === 12) ah  = 0;

    const target = new Date();
    target.setHours(ah, alarm.min, 0, 0);

    let delay = target - now;
    if (delay < 0) continue; // already past for today

    const tid = setTimeout(() => fireAlarm(alarm), delay);
    pendingAlarmTimeouts.push(tid);
  }
}

async function fireAlarm(alarm) {
  // Tell any open windows to trigger directly (faster, no notification needed)
  const openClients = await self.clients.matchAll({ type: 'window' });
  if (openClients.length > 0) {
    openClients.forEach(c => c.postMessage({ type: 'ALARM_TRIGGERED', alarmId: alarm.id }));
    return; // page will handle it — notification not needed when app is visible
  }

  // App not open → show notification so user is woken up
  const exName = alarm.exercise === 'squat' ? 'Squats' : 'Lunges';
  const minStr = String(alarm.min).padStart(2, '0');
  await self.registration.showNotification('🍑 BootyAlarm', {
    body:               `¡Son las ${alarm.hour}:${minStr} ${alarm.ampm}! Hora de tus ${alarm.targetReps} ${exName}. ¡Sin excusas!`,
    icon:               '/icons/icon-192.png',
    badge:              '/icons/icon-192.png',
    tag:                `alarm-${alarm.id}`,
    renotify:           true,
    requireInteraction: true,
    vibrate:            [400, 100, 400, 100, 800],
    actions:            [{ action: 'start', title: '💪 ¡A darle!' }],
    data:               { alarmId: alarm.id }
  });
}

// ══════════════════════════════════════════════════════
// MESSAGES from the page
// ══════════════════════════════════════════════════════
self.addEventListener('message', event => {
  const { type, alarms } = event.data || {};
  if (type === 'SYNC_ALARMS') {
    scheduleAlarms(alarms || []);
  }
});

// ══════════════════════════════════════════════════════
// NOTIFICATION CLICK
// ══════════════════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alarmId = event.notification.data?.alarmId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing window and tell it to trigger the alarm
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope)) {
          client.focus();
          client.postMessage({ type: 'ALARM_TRIGGERED', alarmId });
          return;
        }
      }
      // No open window — open the app with alarm ID in the URL
      return self.clients.openWindow(`/?alarm=${alarmId}`);
    })
  );
});
