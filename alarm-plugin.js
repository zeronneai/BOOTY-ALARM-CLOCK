// Capacitor AlarmPlugin bridge
// Wraps the native Android AlarmManager plugin registered in MainActivity.
// All functions are no-ops when running in a plain browser (AlarmPlugin is null).

const AlarmPlugin = window.Capacitor?.Plugins?.AlarmPlugin ?? null;

/**
 * Schedule a one-shot native alarm.
 * @param {number} id      - Integer alarm ID (must match the ID used to cancel)
 * @param {number} timeMs  - Unix epoch milliseconds for when the alarm should fire
 * @returns {Promise<void>}
 */
async function scheduleNativeAlarm(id, timeMs) {
  if (!AlarmPlugin) return;
  await AlarmPlugin.scheduleAlarm({ id, time: timeMs });
}

/**
 * Cancel a previously scheduled native alarm.
 * @param {number} id - The same integer ID passed to scheduleNativeAlarm
 * @returns {Promise<void>}
 */
async function cancelNativeAlarm(id) {
  if (!AlarmPlugin) return;
  await AlarmPlugin.cancelAlarm({ id });
}

/**
 * Cancel all existing native alarms then reschedule every active alarm.
 * Mirrors the time-calculation logic used by scheduleCapacitorAlarms().
 * @param {Array} alarms - The app's state.alarms array
 * @returns {Promise<void>}
 */
async function syncNativeAlarms(alarms) {
  if (!AlarmPlugin) return;

  // Cancel every alarm (active or not) to wipe stale entries
  for (const alarm of alarms) {
    await cancelNativeAlarm(alarm.id);
  }

  const now = Date.now();
  for (const alarm of alarms) {
    if (!alarm.active) continue;

    let ah = alarm.hour;
    if (alarm.ampm === 'PM' && ah !== 12) ah += 12;
    if (alarm.ampm === 'AM' && ah === 12) ah  = 0;

    const target = new Date();
    target.setHours(ah, alarm.min, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);

    await scheduleNativeAlarm(alarm.id, target.getTime());
  }
}
