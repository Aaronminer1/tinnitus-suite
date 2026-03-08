# 🔊 Tinnitus Suite

> ⚠️ **EXPERIMENTAL SOFTWARE — NOT A MEDICAL DEVICE**  
> This program has not been reviewed, tested, or approved by any medical authority, regulatory body (FDA, CE, etc.), or healthcare organization. It is provided as-is for experimental and educational purposes only. **Use entirely at your own risk.** Do not use this as a substitute for professional medical advice, diagnosis, or treatment. If you have concerns about your hearing or tinnitus, consult a qualified audiologist or physician.

**A free, open-source tinnitus assessment and therapy tool built on peer-reviewed TMNMT research.**  
No account, no subscription, no data sent anywhere. Everything runs locally in your browser — or as a native Android app.

🌐 **Live app:** [aaronminer1.github.io/tinnitus-suite](https://aaronminer1.github.io/tinnitus-suite/)

---

## What it does

### Hearing Assessment

| Feature | Description |
|---|---|
| **Pure-tone audiometry** | ISO 8253-1 Hughson-Westlake method across 250 Hz – 16 kHz (3 resolution modes: Quick/Standard/Fine) |
| **2-of-3 threshold confirmation** | Proper ascending threshold requires 2 heard responses out of 3 attempts at the same level |
| **Catch trials** | ~15% of presentations are silent to detect false-positive responses — warns if accuracy is low |
| **Per-ear testing** | Independent left/right audiograms with explicit opposite-channel silence to prevent bleed |
| **Asymmetry detection** | Warns when left/right thresholds differ by ≥20 dB — a clinically significant finding |
| **NIHL notch detection** | Identifies noise-induced hearing loss patterns (4 kHz / 6 kHz notching) |
| **Volume calibration** | Guided 6-step calibration with a 1 kHz reference tone at –20 dBFS. Calibration status is saved with results |
| **Crash-safe auto-save** | Intermediate results saved to sessionStorage so a crash doesn't lose a 15-minute test |

### Tinnitus Tone Finder

| Feature | Description |
|---|---|
| **Logarithmic frequency sweep** | Pinpoint your exact tinnitus pitch (200 Hz – 20 kHz) |
| **Audiogram-guided** | Starts at your worst hearing frequency, routes to your worse ear |
| **Cross-session consistency** | Tracks frequency variance across sessions in cents — warns if matches are inconsistent |
| **Slope-based noise recommendation** | If high-frequency loss > 20 dB worse than low, recommends pink noise |

### Notched Noise Therapy (In-App)

| Feature | Description |
|---|---|
| **Research-based 1-octave notch** | ERB-scaled notch width per Okamoto et al. 2010 (PNAS) |
| **5 carrier types** | Notched music (evidence-based ★), notched white, white, pink (Voss-McCartney IIR), brown (leaky integrator) |
| **Music file carrier** | Upload your own MP3/WAV/OGG/M4A — the strongest evidence-based carrier |
| **Audiogram EQ** | Compensates for hearing loss with per-frequency peaking filters (gain capped at +18 dB) |
| **Notch depth control** | 0–40 dB slider (capped per research — clinical studies used 12–20 dB) |
| **Nyquist guard** | Clamps notch center to 90% of Nyquist to prevent biquad instability |
| **Volume safety** | Warning banner when volume exceeds 72 dB SPL equivalent |
| **Session tracking** | Cumulative duration tracking with daily target progress bar |
| **Sleep timer** | Auto-fade with session auto-save |
| **Gradual fade-out** | 90-second linear fade prevents rebound effect from abrupt sound offset |
| **Post-session check-in** | Asks if tinnitus worsened — logs response and provides guidance |
| **Effective volume display** | Shows true peak dB including audiogram EQ boost, with graduated warnings |

### System-Wide Streaming Notch Filter (Android)

| Feature | Description |
|---|---|
| **DynamicsProcessing API** | 20-band preEQ on audio session 0 — filters ALL device audio (Spotify, YouTube, Pandora, etc.) |
| **Audiogram compensation** | 12-band hearing-loss EQ applied alongside 8-band notch shaping |
| **Pink/brown spectral tilt** | –3 dB/octave (pink) or –6 dB/octave (brown) tilt applied to EQ bands |
| **Safety cap** | Combined gain never exceeds +18 dB on any band |
| **Animated visualization** | 80-bar spectrum analyzer showing notch region and noise color tilt |
| **Session timer & tracking** | Elapsed time, daily target progress, session persistence |
| **Streaming sleep timer** | Auto-disable after configured duration |
| **Background survival** | Foreground service + silent MediaPlayer loop + WebAudio keep-alive + wake lock |
| **Persistent notification** | Shows active frequency/depth, tap to return to app |

### Platform Features

| Feature | Description |
|---|---|
| **Multi-user accounts** | Per-user profiles with independent audiograms, tone history, and sessions |
| **History & progression** | Audiogram comparisons, tone match history, session streaks, cumulative hours |
| **Double-notch guard** | Warns if both in-app and streaming notch are active simultaneously |
| **Reactive tinnitus screening** | Identifies sound-sensitive users and applies conservative defaults automatically |
| **Session settings tracking** | Records noise type, volume, notch depth, and app version with each session |
| **PWA support** | Install as a standalone app on any device |
| **Evidence disclaimer** | Prominent banner with links to published research |

---

## Use it online (no install)

Just open your browser and go to:

```
https://aaronminer1.github.io/tinnitus-suite/
```

Works on Chrome, Edge, Firefox, and Safari. Use **headphones** for the hearing test.

> **Note:** The system-wide streaming notch filter requires the Android native app (see below). The web version has all other features.

---

## Install locally (web version)

### Requirements
- [Node.js](https://nodejs.org/) v18 or higher (includes npm)
- A modern browser

```bash
git clone https://github.com/Aaronminer1/tinnitus-suite.git
cd tinnitus-suite
npm install
npm start
```

Then open [http://localhost:5173](http://localhost:5173).

> **Don't have Git?** Download the ZIP from the green **Code** button above, extract it, then run `npm install && npm start`.

---

## Build for Android

### Requirements
- Node.js v18+
- Android SDK (API 28+ for DynamicsProcessing, API 36 for full feature set)
- Java 17+

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Install via ADB:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Android-specific features
- **System-wide notch filter** using Android DynamicsProcessing (API 28+)
- **Foreground service** with persistent notification for background operation
- **Silent audio keep-alive** prevents Samsung/OEM process killing
- **Battery optimization exemption** requested on first enable
- **Service survives task removal** (`stopWithTask=false` + `onTaskRemoved` restart)

---

## Deploy to Android with VS Code + AI (easiest method)

This is how I personally deploy to my phones — no Android Studio needed. You just clone the repo, plug in your phone, and ask the AI to deploy it.

### What you need

1. **VS Code** — [Download here](https://code.visualstudio.com/)
2. **GitHub Copilot** — Install the GitHub Copilot extension in VS Code (requires a GitHub Copilot subscription). I use **Claude Opus 4.6** as the model — you can select it in Copilot's model picker
3. **Node.js v18+** — [Download here](https://nodejs.org/)
4. **Java 17+** — `sudo apt install openjdk-17-jdk` (Linux) or download from [Adoptium](https://adoptium.net/)
5. **Android SDK** — Install via Android Studio's SDK Manager, or use `sdkmanager` from command-line tools. You need API 28+ (API 36 for full feature set)
6. **ADB** — Comes with Android SDK platform-tools. Make sure it's in your PATH
7. **A USB-C cable** (or USB-A to USB-C) to connect your phone

### One-time phone setup

1. **Enable Developer Options:**
   - Go to **Settings → About phone → Software information**
   - Tap **Build number** 7 times — you'll see "Developer mode has been enabled"
2. **Enable USB Debugging:**
   - Go to **Settings → Developer options**
   - Turn on **USB debugging**
3. **Connect your phone** via USB cable
4. **Authorize the connection** — a popup will appear on your phone asking "Allow USB debugging?" — tap **Allow** (check "Always allow from this computer" for convenience)
5. **Verify the connection** — open a terminal and run `adb devices`. You should see your device listed

### Deploy walkthrough

1. **Clone the repo and install dependencies:**
   ```bash
   git clone https://github.com/Aaronminer1/tinnitus-suite.git
   cd tinnitus-suite
   npm install
   ```

2. **Open the folder in VS Code:**
   ```bash
   code .
   ```

3. **Open GitHub Copilot Chat** (click the Copilot icon in the sidebar or press `Ctrl+Shift+I`)

4. **Select Claude Opus 4.6** as your model in the Copilot model picker (dropdown at the top of the chat panel)

5. **Plug in your Android phone** via USB and accept the debugging prompt if it appears

6. **Type this in Copilot Chat:**
   > Deploy to my connected Android phone

   That's it. Copilot will:
   - Build the web assets (`npx vite build`)
   - Sync them to the Android project (`npx cap sync android`)
   - Build the APK (`./gradlew assembleDebug`)
   - Install it on your phone (`adb install`)

7. **Open the app** on your phone — it'll appear as "Tinnitus Suite" in your app drawer

### Updating to a new version

When there's a new version:

```bash
cd tinnitus-suite
git pull
npm install
```

Then just tell Copilot: **"Deploy to my connected phone"** — it handles the rest.

### Troubleshooting

| Problem | Fix |
|---|---|
| `adb devices` shows nothing | Check USB cable, re-enable USB debugging, try a different USB port |
| "unauthorized" next to device | Unlock your phone and tap "Allow" on the USB debugging prompt |
| Build fails on Java | Make sure Java 17+ is installed: `java -version` |
| `sdkmanager` not found | Install Android SDK command-line tools or set `ANDROID_HOME` |
| Gradle fails to download | Check internet connection; Gradle downloads dependencies on first build |

---

## Build for production (web)

```bash
npm run build
npm run preview
```

The `dist/` folder contains a fully static site you can host anywhere.

---

## How to use

1. **Create a profile** — multi-user support, all data stays local
2. **Calibrate your volume** — 6-step guide with a 1 kHz reference tone
3. **Take the hearing test** — Quick (9 freqs), Standard (12), or Fine (16 up to 16 kHz)
4. **Review your audiogram** — per-ear thresholds, asymmetry warnings, NIHL detection
5. **Find your tinnitus tone** — logarithmic sweep starting at your worst frequency
6. **Start therapy** — choose in-app notched noise OR system-wide streaming filter
7. **For streaming:** enable the notch, open Spotify/YouTube/Pandora — the filter applies to all audio

---

## Scientific basis

This app implements **Tailor-Made Notched Music Training (TMNMT)** based on:

- **Okamoto et al. 2010** — "Listening to tailor-made notched music reduces tinnitus loudness and tinnitus-related auditory cortex activity" (*PNAS*)
- **Pantev, Okamoto & Teismann 2012** — "Music-induced cortical plasticity and lateral inhibition in the human auditory cortex as foundations for tonal tinnitus treatment" (*Frontiers in Systems Neuroscience*)

Key implementation details from the research:
- **1-octave notch width** (ERB-scaled) — wider than the 0.5-octave many apps use
- **Music carrier preferred** — the studies used music, not noise
- **12–20 dB notch depth** — deeper notches had no additional benefit
- **1–2 hours daily** — the clinical protocol duration

See [TINNITUS_RESEARCH.md](TINNITUS_RESEARCH.md) for the research notes that informed the current implementation.

---

## Known Side Effects & Safety

Sound therapy — including TMNMT — can produce adverse effects. Users should be aware of:

| Effect | Description | What the App Does |
|---|---|---|
| **Rebound effect** | Tinnitus may temporarily seem louder immediately after therapy stops | 90-second gradual fade-out prevents abrupt offset |
| **Residual excitation** | In rare cases, sound exposure temporarily *increases* tinnitus | Post-session check-in prompts users to report worsening |
| **New/changed tones** | ~32% of participants in one NMT study reported transient new tones | Session tracking + guidance to reduce settings or stop |
| **Reactive tinnitus worsening** | Sound-sensitive subtypes may worsen with aggressive therapy | Reactive screening + conservative defaults (lower vol, shorter sessions) |
| **Volume-related damage** | Audiogram EQ can add up to +18 dB above slider level | Effective peak dB display + graduated warnings at 65/72 dB |

**If your tinnitus consistently worsens after sessions, stop using sound therapy and consult an audiologist.**

See [TINNITUS_RESEARCH.md](TINNITUS_RESEARCH.md#65--known-adverse-reactions--contraindications) for full adverse reaction data and references.

---

## Requirements & browser support

| Browser | Status |
|---|---|
| Chrome / Edge 90+ | ✅ Full support |
| Firefox 90+ | ✅ Full support |
| Safari 15+ | ✅ Full support |
| Mobile Chrome/Safari | ✅ Works (use earbuds) |
| Android native (API 28+) | ✅ Full support + streaming notch |

Requires **Web Audio API** (all modern browsers support this).

---

## Privacy

- No server. No analytics. No cookies.
- All data (audiogram, sessions, calibration) is stored **only in your browser's localStorage**.
- The Android app stores nothing beyond what the WebView's localStorage holds.
- Clearing browser/app data removes all stored results.

---

## Contributing

Pull requests welcome. To run the dev server with hot reload:

```bash
npm run dev
```

---

## License

MIT — free to use, modify, and distribute.

---

## ⚠️ Disclaimer

**THIS IS EXPERIMENTAL SOFTWARE. USE AT YOUR OWN RISK.**

- This tool is **not a medical device**
- It has **not been approved, certified, or reviewed** by any medical authority, government agency, or regulatory body (including but not limited to the FDA, CE, TGA, MHRA, or Health Canada)
- It is **not intended to diagnose, treat, cure, or prevent** any disease or medical condition
- Results from this tool **should not be used** to make medical or clinical decisions
- The authors and contributors accept **no liability** for any harm, hearing damage, or adverse effects arising from use of this software
- **Do not use headphone volumes that cause discomfort** — stop immediately if you experience pain or worsening symptoms
- Always consult a **qualified audiologist or ENT specialist** for professional hearing assessment and tinnitus management

**Known adverse effects:** Sound therapy, including the notched sound techniques implemented in this app, has been documented to cause temporary increases in tinnitus loudness (rebound effect), new or changed tinnitus tones, and residual excitation in a subset of users. Approximately 32% of participants in one NMT study reported adverse reactions. Users with reactive tinnitus or hyperacusis are at elevated risk. See the [Known Side Effects & Safety](#known-side-effects--safety) section and [TINNITUS_RESEARCH.md](TINNITUS_RESEARCH.md) for details and references.
