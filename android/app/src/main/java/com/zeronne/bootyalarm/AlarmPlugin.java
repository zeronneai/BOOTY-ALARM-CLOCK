package com.zeronne.bootyalarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AlarmPlugin")
public class AlarmPlugin extends Plugin {

    @PluginMethod
    public void scheduleAlarm(PluginCall call) {
        Integer id = call.getInt("id");
        Double timeMs = call.getDouble("time");

        if (id == null || timeMs == null) {
            call.reject("id and time are required");
            return;
        }

        Context context = getContext();
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        PendingIntent pi = buildPendingIntent(context, id);
        // setAlarmClock is the most reliable method: survives Doze mode and is
        // exempt from battery-optimization restrictions, just like a system clock app
        am.setAlarmClock(new AlarmManager.AlarmClockInfo(timeMs.longValue(), pi), pi);

        call.resolve();
    }

    @PluginMethod
    public void cancelAlarm(PluginCall call) {
        Integer id = call.getInt("id");

        if (id == null) {
            call.reject("id is required");
            return;
        }

        Context context = getContext();
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            PendingIntent pi = buildPendingIntent(context, id);
            am.cancel(pi);
            pi.cancel();
        }

        call.resolve();
    }

    private PendingIntent buildPendingIntent(Context context, int id) {
        Intent intent = new Intent(context, AlarmReceiver.class);
        intent.setAction(AlarmReceiver.ACTION_ALARM_FIRE);
        intent.putExtra(AlarmReceiver.EXTRA_ALARM_ID, id);
        return PendingIntent.getBroadcast(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
