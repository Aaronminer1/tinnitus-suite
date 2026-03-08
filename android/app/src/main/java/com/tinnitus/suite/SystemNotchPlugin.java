package com.tinnitus.suite;

import android.media.audiofx.DynamicsProcessing;
import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * SystemNotchPlugin — applies a 1-octave TMNMT notch filter to ALL device audio
 * (system-wide) using Android's DynamicsProcessing attached to audio session 0.
 *
 * 20-band preEq layout:
 *   Bands 0-7:   Notch shaping (1-octave at tinnitus freq)
 *   Bands 8-19:  Audiogram compensation (hearing loss EQ)
 *
 * Requires Android 9+ (API 28).
 */
@CapacitorPlugin(name = "SystemNotch")
public class SystemNotchPlugin extends Plugin {

    private static final String TAG = "SystemNotch";
    private static final int NOTCH_BANDS = 8;
    private static final int AUDIO_BANDS = 12;
    private static final int TOTAL_BANDS = NOTCH_BANDS + AUDIO_BANDS;
    private static final float MAX_POSITIVE_GAIN = 18f; // Safety cap: never boost more than +18 dB

    // Static reference prevents GC from collecting DP when WebView is backgrounded
    private static DynamicsProcessing sDp = null;

    private boolean enabled = false;
    private float currentFreq = 8000f;
    private float currentDepth = -30f;
    private String currentNoiseColor = "white"; // "white", "pink", "brown"
    private float[] audioFreqs = null;
    private float[] audioGains = null;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", Build.VERSION.SDK_INT >= 28);
        ret.put("apiLevel", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void enable(PluginCall call) {
        if (Build.VERSION.SDK_INT < 28) {
            call.reject("DynamicsProcessing requires Android 9+ (API 28)");
            return;
        }

        float freq  = call.getFloat("frequency", 8000f);
        float depth = call.getFloat("depth", -30f);
        String noiseColor = call.getString("noiseColor", "white");
        parseAudiogram(call);

        try {
            releaseDP();
            requestBatteryOptimizationExemption();

            DynamicsProcessing.Config config = buildConfig(freq, depth, noiseColor);
            sDp = new DynamicsProcessing(100, 0, config);
            sDp.setEnabled(true);

            enabled = true;
            currentFreq = freq;
            currentDepth = depth;
            currentNoiseColor = noiseColor;

            requestNotificationPermissionIfNeeded();
            startForegroundService(freq, depth);

            Log.i(TAG, "Notch enabled: " + freq + " Hz, " + depth + " dB"
                + (audioFreqs != null ? " + " + audioFreqs.length + "-band audiogram EQ" : ""));

            JSObject ret = new JSObject();
            ret.put("enabled", true);
            ret.put("frequency", freq);
            ret.put("depth", depth);
            ret.put("audiogramBands", audioFreqs != null ? audioFreqs.length : 0);
            ret.put("noiseColor", currentNoiseColor);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to enable system notch", e);
            call.reject("Failed to enable system notch: " + e.getMessage());
        }
    }

    @PluginMethod
    public void disable(PluginCall call) {
        try {
            releaseDP();
            stopForegroundService();
            enabled = false;
            Log.i(TAG, "System-wide notch disabled");
            JSObject ret = new JSObject();
            ret.put("enabled", false);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Failed to disable system notch", e);
            call.reject("Failed to disable: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setFrequency(PluginCall call) {
        if (sDp == null || !enabled) {
            call.reject("System notch is not active");
            return;
        }
        float freq  = call.getFloat("frequency", currentFreq);
        float depth = call.getFloat("depth", currentDepth);
        String noiseColor = call.getString("noiseColor", currentNoiseColor);
        try {
            applyAllBands(sDp, freq, depth, noiseColor);
            currentFreq = freq;
            currentDepth = depth;
            currentNoiseColor = noiseColor;
            updateForegroundNotification(freq, depth);
            JSObject ret = new JSObject();
            ret.put("frequency", freq);
            ret.put("depth", depth);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to update frequency: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        ret.put("frequency", currentFreq);
        ret.put("depth", currentDepth);
        ret.put("available", Build.VERSION.SDK_INT >= 28);
        ret.put("audiogramBands", audioFreqs != null ? audioFreqs.length : 0);
        ret.put("noiseColor", currentNoiseColor);
        call.resolve(ret);
    }

    // ── Internal ──────────────────────────────────────────────────────────

    private void releaseDP() {
        if (sDp != null) {
            try { sDp.setEnabled(false); sDp.release(); } catch (Exception e) {
                Log.w(TAG, "Error releasing DP", e);
            }
            sDp = null;
        }
    }

    private void parseAudiogram(PluginCall call) {
        try {
            JSONArray arr = call.getArray("audiogram");
            if (arr == null || arr.length() == 0) { audioFreqs = null; audioGains = null; return; }

            int cap = Math.min(arr.length(), AUDIO_BANDS);
            float[] freqs = new float[cap];
            float[] gains = new float[cap];
            int n = 0;

            for (int i = 0; i < arr.length() && n < cap; i++) {
                JSONObject o = arr.getJSONObject(i);
                float f = (float) o.getDouble("freq");
                float l = (float) o.optDouble("left", 0);
                float r = (float) o.optDouble("right", 0);
                float avg = (l + r) / 2f;
                if (avg > 10 && f >= 250 && f <= 12000) {
                    freqs[n] = f;
                    gains[n] = Math.min(18f, avg * 0.5f);
                    n++;
                }
            }
            if (n > 0) {
                audioFreqs = new float[n]; audioGains = new float[n];
                System.arraycopy(freqs, 0, audioFreqs, 0, n);
                System.arraycopy(gains, 0, audioGains, 0, n);
                Log.i(TAG, "Audiogram: " + n + " compensation bands");
            } else { audioFreqs = null; audioGains = null; }
        } catch (Exception e) {
            Log.w(TAG, "Could not parse audiogram", e);
            audioFreqs = null; audioGains = null;
        }
    }

    /**
     * Compute spectral tilt gain for a given frequency.
     * Pink noise: -3 dB/octave relative to 1 kHz
     * Brown noise: -6 dB/octave relative to 1 kHz
     * White: 0 dB (flat)
     */
    private float colorTiltGain(float freq, String noiseColor) {
        if ("pink".equals(noiseColor)) {
            // -3 dB per octave above 1 kHz, +3 dB per octave below 1 kHz
            return -3f * (float)(Math.log(freq / 1000.0) / Math.log(2.0));
        } else if ("brown".equals(noiseColor)) {
            // -6 dB per octave above 1 kHz, +6 dB per octave below 1 kHz
            return -6f * (float)(Math.log(freq / 1000.0) / Math.log(2.0));
        }
        return 0f; // white = flat
    }

    private DynamicsProcessing.Config buildConfig(float freq, float depth, String noiseColor) {
        DynamicsProcessing.Config.Builder builder = new DynamicsProcessing.Config.Builder(
            DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
            1, true, TOTAL_BANDS, false, 0, false, 0, false);
        DynamicsProcessing.Config config = builder.build();

        DynamicsProcessing.Channel channel = config.getChannelByChannelIndex(0);

        // Notch bands 0-7
        float sqrt2 = (float) Math.sqrt(2.0);
        float lo = freq / sqrt2, hi = freq * sqrt2;
        float[] nc = { lo*0.25f, lo*0.7f, lo, freq*0.95f, freq*1.05f, hi, hi*1.4f, hi*3f };
        float[] ng = { 0, 0, depth*0.4f, depth, depth, depth*0.4f, 0, 0 };
        for (int i = 0; i < NOTCH_BANDS; i++) {
            float tilt = colorTiltGain(nc[i], noiseColor);
            float gain = Math.min(MAX_POSITIVE_GAIN, ng[i] + tilt);
            DynamicsProcessing.EqBand b = channel.getPreEqBand(i);
            b.setEnabled(true); b.setCutoffFrequency(nc[i]); b.setGain(gain);
        }

        // Audiogram bands 8-19
        float[] defF = { 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000 };
        for (int i = 0; i < AUDIO_BANDS; i++) {
            DynamicsProcessing.EqBand b = channel.getPreEqBand(NOTCH_BANDS + i);
            b.setEnabled(true);
            float f, g;
            if (audioFreqs != null && i < audioFreqs.length) {
                f = audioFreqs[i]; g = audioGains[i];
            } else {
                f = defF[i]; g = 0f;
            }
            float tilt = colorTiltGain(f, noiseColor);
            float totalGain = Math.min(MAX_POSITIVE_GAIN, g + tilt);
            b.setCutoffFrequency(f); b.setGain(totalGain);
        }
        return config;
    }

    private void applyAllBands(DynamicsProcessing dp, float freq, float depth, String noiseColor) {
        float sqrt2 = (float) Math.sqrt(2.0);
        float lo = freq / sqrt2, hi = freq * sqrt2;
        float[] nc = { lo*0.25f, lo*0.7f, lo, freq*0.95f, freq*1.05f, hi, hi*1.4f, hi*3f };
        float[] ng = { 0, 0, depth*0.4f, depth, depth, depth*0.4f, 0, 0 };

        for (int i = 0; i < NOTCH_BANDS; i++) {
            float tilt = colorTiltGain(nc[i], noiseColor);
            float gain = Math.min(MAX_POSITIVE_GAIN, ng[i] + tilt);
            dp.setPreEqBandAllChannelsTo(i, new DynamicsProcessing.EqBand(true, nc[i], gain));
        }

        float[] defF = { 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000 };
        for (int i = 0; i < AUDIO_BANDS; i++) {
            float f = (audioFreqs != null && i < audioFreqs.length) ? audioFreqs[i] : defF[i];
            float g = (audioGains != null && i < audioGains.length) ? audioGains[i] : 0f;
            float tilt = colorTiltGain(f, noiseColor);
            float totalGain = Math.min(MAX_POSITIVE_GAIN, g + tilt);
            dp.setPreEqBandAllChannelsTo(NOTCH_BANDS + i, new DynamicsProcessing.EqBand(true, f, totalGain));
        }
    }

    @Override
    protected void handleOnDestroy() {
        releaseDP();
        stopForegroundService();
        super.handleOnDestroy();
    }

    // ── Battery optimization exemption (Samsung) ──────────────────────────

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                Context ctx = getContext();
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + ctx.getPackageName()));
                    // Launch from the Activity (not Context) so it stays in the
                    // same task stack — prevents Samsung from pushing the dialog
                    // behind the WebView.
                    getActivity().startActivity(intent);
                }
            } catch (Exception e) {
                Log.w(TAG, "Battery opt exemption failed", e);
            }
        }
    }

    // ── Notification permission (Android 13+) ─────────────────────────────

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(getActivity(),
                        new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1001);
                }
            } catch (Exception e) {
                Log.w(TAG, "Notification permission request failed", e);
            }
        }
    }

    // ── Foreground service ────────────────────────────────────────────────

    private void startForegroundService(float freq, float depth) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(ctx, NotchForegroundService.class);
            intent.putExtra("frequency", freq);
            intent.putExtra("depth", depth);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
            else ctx.startService(intent);
        } catch (Exception e) { Log.w(TAG, "FG service start failed", e); }
    }

    private void stopForegroundService() {
        try {
            Context ctx = getContext();
            ctx.stopService(new Intent(ctx, NotchForegroundService.class));
        } catch (Exception e) { Log.w(TAG, "FG service stop failed", e); }
    }

    private void updateForegroundNotification(float freq, float depth) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(ctx, NotchForegroundService.class);
            intent.putExtra("frequency", freq);
            intent.putExtra("depth", depth);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
            else ctx.startService(intent);
        } catch (Exception e) { Log.w(TAG, "Notification update failed", e); }
    }
}
