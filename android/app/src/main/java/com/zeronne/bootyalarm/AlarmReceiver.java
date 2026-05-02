package com.zeronne.bootyalarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_ALARM_FIRE = "com.zeronne.bootyalarm.ALARM_FIRE";
    public static final String EXTRA_ALARM_ID = "alarm_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        int alarmId = intent.getIntExtra(EXTRA_ALARM_ID, 0);
        NotificationHelper.showAlarmNotification(context, alarmId);
    }
}
