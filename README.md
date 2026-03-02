# 🔊 Tinnitus Suite

> ⚠️ **EXPERIMENTAL SOFTWARE — NOT A MEDICAL DEVICE**  
> This program has not been reviewed, tested, or approved by any medical authority, regulatory body (FDA, CE, etc.), or healthcare organization. It is provided as-is for experimental and educational purposes only. **Use entirely at your own risk.** Do not use this as a substitute for professional medical advice, diagnosis, or treatment. If you have concerns about your hearing or tinnitus, consult a qualified audiologist or physician.

**A free, open-source tinnitus assessment and therapy tool.**  
No account, no subscription, no data sent anywhere. Everything runs locally in your browser.

🌐 **Live app:** [aaronminer1.github.io/tinnitus-suite](https://aaronminer1.github.io/tinnitus-suite/)

---

## What it does

| Feature | Description |
|---|---|
| **Pure-tone hearing test** | Audiogram across 250 Hz – 20 kHz using the Hughson-Westlake bracketing method |
| **Tinnitus tone finder** | Logarithmic frequency sweep to pinpoint your exact tinnitus pitch |
| **Notched noise therapy** | Pink/brown/white noise with a precision spectral notch at your tinnitus frequency |
| **Audiogram intelligence** | Identifies noise-induced hearing loss (NIHL) notch, recommends noise type, auto-routes to your worse ear |
| **Volume calibration** | Guided calibration so levels are consistent across any device |
| **PWA support** | Install as a standalone app on any device |

---

## Use it online (no install)

Just open your browser and go to:

```
https://aaronminer1.github.io/tinnitus-suite/
```

Works on Chrome, Edge, Firefox, and Safari. Use **headphones** for the hearing test.

---

## Install locally

### Requirements
- [Node.js](https://nodejs.org/) v18 or higher (includes npm)
- A modern browser

### macOS / Linux

```bash
git clone https://github.com/Aaronminer1/tinnitus-suite.git
cd tinnitus-suite
npm install
npm start
```

Then open [http://localhost:5173](http://localhost:5173).

### Windows

Open **Command Prompt** or **PowerShell**:

```powershell
git clone https://github.com/Aaronminer1/tinnitus-suite.git
cd tinnitus-suite
npm install
npm start
```

Then open [http://localhost:5173](http://localhost:5173).

> **Don't have Git?** Download the ZIP from the green **Code** button above, extract it, then open a terminal in that folder and run `npm install && npm start`.

---

## Build for production

```bash
npm run build
npm run preview
```

The `dist/` folder contains a fully static site you can host anywhere (Netlify, Vercel, a USB drive, a local web server, etc.).

---

## How to use

1. **Choose your listening device** — headphones (recommended) or speakers
2. **Calibrate your volume** — follow the 6-step guide to set a consistent reference level
3. **Take the hearing test** — choose Quick (10 freqs), Standard (13), or Fine (18, up to 20 kHz)
4. **Find your tinnitus tone** — sweep until it matches, then fine-tune
5. **Start therapy** — notched noise plays with the spectral notch centred on your frequency

Sessions are saved in your browser's local storage — no data leaves your device.

---

## Requirements & browser support

| Browser | Status |
|---|---|
| Chrome / Edge 90+ | ✅ Full support |
| Firefox 90+ | ✅ Full support |
| Safari 15+ | ✅ Full support |
| Mobile Chrome/Safari | ✅ Works (use earbuds) |

Requires **Web Audio API** (all modern browsers support this).

---

## Privacy

- No server. No analytics. No cookies.
- All data (audiogram, sessions, calibration) is stored **only in your browser's localStorage**.
- Clearing browser data removes all stored results.

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
