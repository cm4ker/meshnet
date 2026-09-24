package dev.cm4ker.meshnet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app running while the radio is shared with a computer ({@link MeshRelay}), with the
 * app in the background or swiped away: a foreground service of the connected-device kind, with
 * the notice Android requires for one. It holds nothing itself; the relay lives in the process.
 */
public class MeshRelayService extends Service {
    private static final String TAG = "MeshRelay";
    private static final String CHANNEL = "relay";
    private static final int NOTICE_ID = 0x4d52;
    private static final String EXTRA_COMPUTER = "computer";

    static void start(Context context, boolean computer) {
        Intent intent = new Intent(context, MeshRelayService.class).putExtra(EXTRA_COMPUTER, computer);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            // Refused from the background (Android 12 and later): the relay still works while the app is open.
            Log.w(TAG, "the background service did not start", e);
        }
    }

    /** A new line in the notice, when a computer comes or goes. */
    static void update(Context context, boolean computer) {
        NotificationManager notices = context.getSystemService(NotificationManager.class);
        if (notices != null && notices.areNotificationsEnabled()) notices.notify(NOTICE_ID, notice(context, computer));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MeshRelayService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean computer = intent != null && intent.getBooleanExtra(EXTRA_COMPUTER, false);
        Notification notice = notice(this, computer);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTICE_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(NOTICE_ID, notice);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "the background service was refused", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        // Not restarted by Android after the process dies: the relay's state went with it.
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static Notification notice(Context context, boolean computer) {
        NotificationManager notices = context.getSystemService(NotificationManager.class);
        if (notices != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notices.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Sharing the radio", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a computer can use the radio through this phone.");
            channel.setShowBadge(false);
            notices.createNotificationChannel(channel);
        }
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_meshnet)
            .setContentTitle("Sharing the radio")
            .setContentText(computer ? "A computer is connected" : "Waiting for a computer")
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }
}
