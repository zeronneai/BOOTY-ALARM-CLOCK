package com.zeronne.bootyalarm;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;

public class NotificationHelper {

    public static final String CHANNEL_ID = "booty_alarm_channel";

    public static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Booty Alarm",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alarm notifications for Booty Alarm");
            channel.enableVibration(true);
            // Bypass Do Not Disturb so the alarm fires regardless of focus mode
            channel.setBypassDnd(true);

            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    public static void showAlarmNotification(Context context, int alarmId) {
        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        openIntent.putExtra(AlarmReceiver.EXTRA_ALARM_ID, alarmId);

        // FLAG_IMMUTABLE required on API 31+; FLAG_UPDATE_CURRENT reuses an existing
        // PendingIntent for the same alarmId rather than stacking duplicates
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            alarmId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("¡Hora de entrenar!")
            .setContentText("Time to train!")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .addAction(0, "Open App", pendingIntent);

        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(alarmId, builder.build());
        }
    }
}
