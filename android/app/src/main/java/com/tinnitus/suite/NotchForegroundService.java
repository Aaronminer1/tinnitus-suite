package com.tinnitus.suite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the app alive while the system-wide notch
 * filter is running. Without this, Android (especially Samsung) will kill
 * the background process within 1-5 minutes when the user switches to
 * Spotify/Pandora/YouTube.
 *
 * Shows a persistent notification so the user knows the filter is active
 * and can tap to return to the app.
 *
 * CRITICAL FIX: Plays a silent audio loop via MediaPlayer to create a real
 * Android media session. Without this, Samsung detects the app isn't producing
 * audio (DynamicsProcessing on session 0 is a system effect, not "our" audio)
 * and kills the process despite the foreground service.
 */
public class NotchForegroundService extends Service {

    private static final String TAG = "NotchFgService";
    private static final String CHANNEL_ID = "tinnitus_notch_channel";
    private static final int NOTIFICATION_ID = 9001;

    private PowerManager.WakeLock wakeLock;
    private MediaPlayer silentPlayer;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
        startSilentAudio();
        Log.i(TAG, "Foreground service created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Extract frequency info from intent for notification display
        float freq = 8000f;
        float depth = -30f;
        if (intent != null) {
            freq = intent.getFloatExtra("frequency", 8000f);
            depth = intent.getFloatExtra("depth", -30f);
        }

        Notification notification = buildNotification(freq, depth);

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        Log.i(TAG, "Foreground service started — notch at " + freq + " Hz");

        // If killed, restart with the last intent
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        stopSilentAudio();
        releaseWakeLock();
        Log.i(TAG, "Foreground service destroyed");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not a bound service
    }

    /**
     * If user swipes the app from recents, restart the service immediately.
     * Samsung aggressively kills services when tasks are removed.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.w(TAG, "Task removed — scheduling service restart");
        // Re-broadcast start intent to keep the service alive
        Intent restartIntent = new Intent(getApplicationContext(), NotchForegroundService.class);
        restartIntent.setPackage(getPackageName());
        if (Build.VERSION.SDK_INT >= 26) {
            getApplicationContext().startForegroundService(restartIntent);
        } else {
            getApplicationContext().startService(restartIntent);
        }
        super.onTaskRemoved(rootIntent);
    }

    /**
     * Update the notification with new frequency/depth values.
     */
    public void updateNotification(float freq, float depth) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(freq, depth));
        }
    }

    // ── Internal ─────────────────────────────────────────────────────────

    /**
     * Play a silent WAV in a loop so Android sees our process as actively playing
     * audio. This is the KEY fix: DynamicsProcessing on session 0 is a system
     * effect that doesn't count as "our" audio session. Samsung's process manager
     * kills apps it considers idle even with a foreground service. The looping
     * silent MediaPlayer creates a real AudioTrack/media session that tells
     * Android we're a legitimate audio app.
     */
    private void startSilentAudio() {
        try {
            silentPlayer = MediaPlayer.create(this, R.raw.silence);
            if (silentPlayer != null) {
                silentPlayer.setLooping(true);
                silentPlayer.setVolume(0f, 0f);
                // Use USAGE_MEDIA so Android treats this as a media session
                if (Build.VERSION.SDK_INT >= 21) {
                    silentPlayer.setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build()
                    );
                }
                silentPlayer.start();
                Log.i(TAG, "Silent audio loop started — media session active");
            } else {
                Log.w(TAG, "Could not create silent MediaPlayer (resource missing?)");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to start silent audio", e);
        }
    }

    private void stopSilentAudio() {
        try {
            if (silentPlayer != null) {
                if (silentPlayer.isPlaying()) silentPlayer.stop();
                silentPlayer.release();
                silentPlayer = null;
                Log.i(TAG, "Silent audio loop stopped");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error stopping silent audio", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Tinnitus Therapy Notch Filter",
                NotificationManager.IMPORTANCE_LOW  // No sound, just persistent icon
            );
            channel.setDescription("Shows when the therapeutic notch filter is active on device audio");
            channel.setShowBadge(false);

            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(float freq, float depth) {
        // Tapping the notification brings the user back to the app
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String freqText = freq >= 1000
            ? String.format("%.1f kHz", freq / 1000)
            : String.format("%.0f Hz", freq);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🎵 Notch Filter Active")
            .setContentText("Filtering audio at " + freqText + " · " + Math.round(Math.abs(depth)) + " dB notch")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)          // Can't be swiped away
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pendingIntent)
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText("Therapeutic 1-octave notch filter is active on all device audio. "
                    + "Open Spotify, Pandora, or YouTube Music — the notch is applied automatically. "
                    + "Tap to return to the app."))
            .build();
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "TinnitusSuite::NotchFilterWakeLock"
                );
                // 4-hour timeout as safety net (clinical sessions are 1-2 hours)
                wakeLock.acquire(4 * 60 * 60 * 1000L);
                Log.i(TAG, "Wake lock acquired (4h timeout)");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not acquire wake lock", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.i(TAG, "Wake lock released");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error releasing wake lock", e);
        }
    }
}
