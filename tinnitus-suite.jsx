import { useState, useRef, useEffect, useCallback, Component } from "react";

// ─── Capacitor native bridge for system-wide audio notch ──────────────────────
// Uses Android DynamicsProcessing API to apply notch filter to ALL device audio
// (Pandora, Spotify, YouTube, etc.) — no capture/DRM issues.
const SystemNotch = (() => {
  try {
    // Capacitor.Plugins is available when running inside the native shell
    const cap = window.Capacitor;
    if (cap && cap.Plugins && cap.Plugins.SystemNotch) return cap.Plugins.SystemNotch;
    // Fallback: registerPlugin style (Capacitor 5+)
    if (cap && cap.registerPlugin) return cap.registerPlugin("SystemNotch");
  } catch (_) {}
  // Web fallback — methods exist but always report unavailable
  return {
    isAvailable: async () => ({ available: false, apiLevel: 0 }),
    enable:      async () => ({ enabled: false }),
    disable:     async () => ({ enabled: false }),
    setFrequency:async () => ({}),
    getStatus:   async () => ({ enabled: false, available: false }),
  };
})();

// ─── Constants ────────────────────────────────────────────────────────────────
// ── Frequency presets — user selects resolution before the test starts ──────
// Top limit is 16 kHz — 18 kHz and 20 kHz are beyond reliable consumer earbud range.
// At 18-20 kHz the Hughson-Westlake protocol climbs to 90+ dBHL where any gain formula
// that isn't perfectly clamped generates clipping harmonics heard as spurious low-pitch buzz.
// Standard clinical audiometry: 250 Hz – 8 kHz. Extended high-frequency: up to 16 kHz.
const FREQ_QUICK    = [500,1000,2000,4000,6000,8000,10000,12000,16000];
const FREQ_STANDARD = [250,500,1000,2000,3000,4000,6000,8000,10000,12000,14000,16000];
const FREQ_FINE     = [250,500,750,1000,1500,2000,3000,4000,5000,6000,7000,8000,
                        10000,12000,14000,16000];
const TEST_MODES = [
  {id:"quick",    label:"QUICK",    freqs:FREQ_QUICK,    est:"~7 min",
   desc:"9 frequencies · 500 Hz – 16 kHz · Recommended first-time screening"},
  {id:"standard", label:"STANDARD", freqs:FREQ_STANDARD, est:"~11 min",
   desc:"12 frequencies · 250 Hz – 16 kHz · Full extended clinical audiogram"},
  {id:"fine",     label:"FINE",     freqs:FREQ_FINE,     est:"~17 min",
   desc:"16 frequencies · 250 Hz – 16 kHz · Maximum resolution — every 500 Hz – 1 kHz step"},
];
const TEST_FREQS = FREQ_STANDARD; // consumed by legacy fallbacks only
const EARS = ["left","right"];

const CATS = [
  {max:15,  label:"Normal",      color:"#00d4b4"},
  {max:25,  label:"Near Normal", color:"#26de81"},
  {max:40,  label:"Mild Loss",   color:"#ffd32a"},
  {max:55,  label:"Moderate",    color:"#ffa502"},
  {max:70,  label:"Mod-Severe",  color:"#ff6348"},
  {max:90,  label:"Severe",      color:"#ff4757"},
  {max:130, label:"Profound",    color:"#a29bfe"},
];

const NOISE_TYPES = [
  {id:"music",   label:"Notched Music ★",desc:"Upload your music — strongest evidence (Okamoto 2010)", color:"#ffd32a",rec:true},
  {id:"notched", label:"Notched White",   desc:"Therapeutic — silence at tinnitus frequency",            color:"#00d4b4",rec:false},
  {id:"white",   label:"White Noise",     desc:"Equal energy across all frequencies",                    color:"#e2e8f0",rec:false},
  {id:"pink",    label:"Pink Noise",      desc:"Softer highs, sounds more natural",                     color:"#fd79a8",rec:false},
  {id:"brown",   label:"Brown Noise",     desc:"Deep rumble, like rain on a rooftop",                   color:"#e17055",rec:false},
];

const K = {
  bg:"#07090f", card:"#0c0f1c", border:"#1e2e4a",
  teal:"#00d4b4", red:"#ff4757", amber:"#ffa502",
  muted:"#7a9bbf", dim:"#1c2a3e", text:"#e8f0fa", sub:"#9db8d4",
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const mkCtx = () => new (window.AudioContext || window.webkitAudioContext)();
// Reference at 80 dB → gain=1.0 dBFS; safe peak is 0.9 (-1 dBFS).
// Old ref=60 caused gain≥1.0 at vol≥60 → hard digital clipping.
const dBtoG = (db) => Math.min(0.9, Math.max(1e-6, Math.pow(10, (db - 80) / 20)));
const catFor = (db) => CATS.find(c => db <= c.max) || CATS[CATS.length-1];
const hzFmt  = (f)  => f >= 1000 ? `${(f/1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`;

// Log-scale slider conversion
const logSlider = (FMIN, FMAX, SMAX=10000) => ({
  f2s: f => Math.round(Math.log2(f/FMIN) / Math.log2(FMAX/FMIN) * SMAX),
  s2f: s => Math.round(FMIN * Math.pow(FMAX/FMIN, s/SMAX)),
  SMAX,
});

// Update slider gradient imperatively (no re-render)
const setSliderGrad = (el, pct, color) => {
  if (el) el.style.background = `linear-gradient(to right,${color} ${pct}%,${K.dim} ${pct}%)`;
};

// Core noise buffer factory — overlap-add crossfade for a perfectly seamless loop.
//
// Why overlap-add?  At the loop boundary, buffer[N-1] → buffer[0] is a hard cut.
// We fix this by generating N + fade_samps extra samples into a temp array, then
// blending the overflow (indices N..N+fade) back into the start (indices 0..fade)
// using a Hann window.  After blending, buffer[0] ≈ what sample[N] would have been
// (the natural continuation), so the loop is perceptually seamless.
//
// 30-second buffers: below the threshold of rhythm perception for stochastic noise
// (~8-10 s is clearly detectable; 30 s is not.)
function makeNoiseBuf(ctx, secs, genFn) {
  const sr   = ctx.sampleRate;
  const n    = Math.floor(sr * secs);
  const fade = Math.floor(sr * 0.08); // 80 ms Hann overlap region
  const buf  = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const tmp = new Float32Array(n + fade);
    genFn(tmp);                          // fill n + fade samples (each channel independently seeded)
    // Blend the overflow back into the start
    for (let i = 0; i < fade; i++) {
      const w  = 0.5 - 0.5 * Math.cos(Math.PI * i / fade); // Hann: 0 → 1
      tmp[i] = tmp[n + i] * (1 - w) + tmp[i] * w;
    }
    buf.getChannelData(c).set(tmp.subarray(0, n));
  }
  return buf;
}

function mkWhite(ctx) {
  return makeNoiseBuf(ctx, 30, (tmp) => {
    for (let i = 0; i < tmp.length; i++) tmp[i] = Math.random() * 2 - 1;
  });
}

function mkPink(ctx) {
  // Voss-McCartney pink noise via 7-stage IIR.
  // Pre-warm 2000 samples so the filter state is fully settled before the buffer starts —
  // a cold-start transient baked into the loop boundary was causing the "click" in the old code.
  return makeNoiseBuf(ctx, 30, (tmp) => {
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < 2000; i++) {           // discard warm-up samples
      const w = Math.random()*2-1;
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      b6=w*0.115926;
    }
    for (let i = 0; i < tmp.length; i++) {
      const w = Math.random()*2-1;
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      tmp[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
    }
  });
}

function mkBrown(ctx) {
  // Brownian (red) noise via leaky integrator.
  // Pre-warm 500 samples so the integrator DC offset has decayed.
  return makeNoiseBuf(ctx, 30, (tmp) => {
    let last = 0;
    for (let i = 0; i < 500; i++) { const w=Math.random()*2-1; last=(last+0.02*w)/1.02; }
    for (let i = 0; i < tmp.length; i++) {
      const w = Math.random()*2-1;
      last = (last + 0.02*w) / 1.02;
      tmp[i] = last * 3.5;
    }
  });
}

// ─── Global CSS ───────────────────────────────────────────────────────────────
const CSS = `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${K.bg};}
  @keyframes glow{0%,100%{box-shadow:0 0 10px rgba(0,212,180,0.2)}50%{box-shadow:0 0 30px rgba(0,212,180,0.55)}}
  @keyframes ring{to{transform:scale(1.6);opacity:0}}
  @keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{opacity:0.45}50%{opacity:1}}
  @keyframes bar{0%,100%{transform:scaleY(0.25)}50%{transform:scaleY(1)}}
  input[type=range]{-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;cursor:pointer;}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;cursor:pointer;}
  .sl-teal::-webkit-slider-thumb{background:${K.teal};box-shadow:0 0 10px rgba(0,212,180,0.7);}
  .sl-red::-webkit-slider-thumb{background:${K.red};box-shadow:0 0 12px rgba(255,71,87,0.8);width:24px;height:24px;}
  .sl-purple::-webkit-slider-thumb{background:#a29bfe;box-shadow:0 0 8px rgba(162,155,254,0.6);}
  .sl-amber::-webkit-slider-thumb{background:${K.amber};box-shadow:0 0 8px rgba(255,165,2,0.6);}
  .sl-blue::-webkit-slider-thumb{background:#74b9ff;box-shadow:0 0 8px rgba(116,185,255,0.6);}
  button{cursor:pointer;border:none;}
  button:focus{outline:none;}
  ::-webkit-scrollbar{width:4px;}
  ::-webkit-scrollbar-thumb{background:${K.dim};border-radius:2px;}
  /* ── Touch / mobile friendly (pointer:coarse = touchscreen) ────────────── */
  @media(pointer:coarse){
    button{min-height:44px;}
    input[type=range]{height:10px;}
    input[type=range]::-webkit-slider-thumb{width:28px!important;height:28px!important;}
  }
  /* ── Narrow screens: tighter padding, word wrap, reduced letter spacing ── */
  @media(max-width:480px){
    body{font-size:14px;}
    *{letter-spacing:0.05em!important;word-break:break-word;overflow-wrap:break-word;}
    input[type=range]{letter-spacing:0!important;}
    .panel{padding:14px!important;border-radius:10px!important;}
  }
  /* ── iPhone/Android notch: honour safe area insets ─────────────── */
  #root{padding-bottom:env(safe-area-inset-bottom,0px);}
`;

// ─── UI Atoms ─────────────────────────────────────────────────────────────────
const Panel = ({ch, s, hi}) => (
  <div className="panel" style={{background:K.card,border:`1px solid ${hi||K.border}`,borderRadius:14,padding:22,animation:"up 0.3s ease",...s}}>
    {ch}
  </div>
);

const Lbl = ({t, c, sz=13, s}) => (
  <div style={{fontFamily:"'Courier New',monospace",fontSize:sz,letterSpacing:"0.14em",color:c||K.sub,...s}}>{t}</div>
);

const Big = ({t, sz=24, c, s}) => (
  <div style={{fontFamily:"system-ui",fontWeight:700,fontSize:sz,color:c||K.text,letterSpacing:"0.04em",...s}}>{t}</div>
);

// Simple controlled slider (state-driven, for non-frequency params)
const SldC = ({val, min, max, step, cls, color, onCh}) => {
  const pct = ((val-min)/(max-min))*100;
  return (
    <input type="range" min={min} max={max} step={step} value={val}
      onChange={e => onCh(parseFloat(e.target.value))} className={cls}
      style={{width:"100%", background:`linear-gradient(to right,${color} ${pct}%,${K.dim} ${pct}%)`}}
    />
  );
};

// ERB (Equivalent Rectangular Bandwidth) — scales notch width with frequency
// Formula: ERB(f) = 24.7 * (4.37*f/1000 + 1)  [Glasberg & Moore 1990]
const erbHz  = (f) => 24.7 * (4.37 * f / 1000 + 1);
// Convert ERB at frequency f to octaves: octaves = log2((f + ERB/2) / (f - ERB/2))
const erbOct = (f) => {
  const e = erbHz(f);
  return Math.log2((f + e / 2) / Math.max(f - e / 2, 1));
};

// ─── User Helpers ─────────────────────────────────────────────────────────────
const USER_COLORS = ["#00d4b4","#ffa502","#fd79a8","#a29bfe","#26de81","#74b9ff","#fdcb6e","#e17055"];
const mkUid = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`;
const getAllUsers = () => { try{return JSON.parse(localStorage.getItem("tinnitus_users")||"[]");}catch(_){return[];} };
const saveUsers  = (us) => { try{localStorage.setItem("tinnitus_users",JSON.stringify(us));}catch(_){} };
const uKey  = (uid,k)   => `tu_${uid}_${k}`;
const uGet  = (uid,k)   => { try{return localStorage.getItem(uKey(uid,k));}catch(_){return null;} };
const uSet  = (uid,k,v) => { try{localStorage.setItem(uKey(uid,k),v);}catch(_){} };
const uGetJ = (uid,k,d) => { try{const s=uGet(uid,k);return s?JSON.parse(s):d;}catch(_){return d;} };
const uSetJ = (uid,k,v) => uSet(uid,k,JSON.stringify(v));
const uDel  = (uid,k)   => { try{localStorage.removeItem(uKey(uid,k));}catch(_){} };

// ─── Step Bar ─────────────────────────────────────────────────────────────────
function StepBar({phase}) {
  const steps = [{n:1,label:"HEARING TEST"},{n:2,label:"TONE FINDER"},{n:3,label:"THERAPY"}];
  const idx = {intro:0,tintype:0,test:1,testresults:1,tone:2,octavecheck:2,therapy:3}[phase]||0;
  return (
    <div style={{display:"flex",alignItems:"center",marginBottom:28}}>
      {steps.map((s,i) => {
        const done=idx>i+1, active=idx===i+1, col=(done||active)?K.teal:K.muted;
        return (
          <div key={i} style={{display:"flex",alignItems:"center",flex:i<2?1:"none"}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5}}>
              <div style={{width:32,height:32,borderRadius:"50%",border:`2px solid ${col}`,
                background:active?"rgba(0,212,180,0.12)":done?K.teal:"transparent",
                display:"flex",alignItems:"center",justifyContent:"center",
                color:done?K.bg:col,fontWeight:"bold",fontSize:13,
                fontFamily:"'Courier New',monospace",flexShrink:0,
                animation:active?"glow 2s ease-in-out infinite":"none"}}>
                {done?"✓":s.n}
              </div>
              <Lbl t={s.label} c={(done||active)?K.teal:K.muted} s={{whiteSpace:"nowrap"}}/>
            </div>
            {i<2 && <div style={{flex:1,height:2,background:done?K.teal:K.dim,margin:"0 8px",marginBottom:18,transition:"background 0.5s"}}/>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Tinnitus Type Screen ─────────────────────────────────────────────────────
function TinnitusTypeScreen({onTonal, onNoise, onUnsure}) {
  const types = [
    {
      id:"tonal", icon:"🎵",
      title:"Pure Tone / Whistle",
      desc:"A steady single pitch — like a ringing, whistling, or humming at one clear frequency. You could try to match it to a musical note.",
      color:K.teal,
      action: onTonal,
      btnLabel:"THIS IS MINE → NOTCHED THERAPY",
    },
    {
      id:"noise", icon:"📻",
      title:"Noise / Static / Hiss",
      desc:"A broad rushing, hissing, or static sound with no clear pitch — like white noise, steam, or TV static. Cannot be matched to a tone.",
      color:"#a29bfe",
      action: onNoise,
      btnLabel:"THIS IS MINE → BROADBAND MASKING",
    },
    {
      id:"unsure", icon:"🔀",
      title:"Not Sure / Mixed",
      desc:"Your tinnitus changes character, has multiple tones, or you're not certain which category it fits.",
      color:K.amber,
      action: onUnsure,
      btnLabel:"NOT SURE → DO HEARING TEST FIRST",
    },
  ];
  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <Big t="WHAT DOES YOUR TINNITUS SOUND LIKE?" sz={22}/>
        <Lbl t="THIS DETERMINES WHICH THERAPY APPROACH WILL WORK FOR YOU" s={{textAlign:"center",marginTop:6,fontSize:13,letterSpacing:"0.16em"}}/>
      </div>
      <Panel s={{marginBottom:14,borderColor:"#1e2a3e"}} ch={<>
        <Lbl t="WHY THIS MATTERS" c={K.amber} s={{marginBottom:8}}/>
        <Lbl t="Notched sound therapy only works for tonal tinnitus — it requires a precise frequency target to create the notch around. For noise-type tinnitus, broadband masking (plain white/pink noise) is the appropriate approach and can still significantly reduce distress." s={{lineHeight:1.9,fontSize:14}}/>
      </>}/>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {types.map(t=>(
          <Panel key={t.id} hi={t.color+"44"} s={{cursor:"pointer",transition:"all 0.2s"}} ch={
            <div style={{display:"flex",gap:16,alignItems:"flex-start"}}>
              <div style={{fontSize:32,flexShrink:0,marginTop:2}}>{t.icon}</div>
              <div style={{flex:1}}>
                <div style={{fontFamily:"system-ui",fontWeight:700,fontSize:15,color:t.color,marginBottom:5}}>{t.title}</div>
                <Lbl t={t.desc} s={{lineHeight:1.8,fontSize:14,marginBottom:12}}/>
                <button onClick={t.action} style={{fontFamily:"system-ui",fontWeight:600,fontSize:14,letterSpacing:"0.1em",padding:"10px 20px",background:`rgba(${t.id==="tonal"?"0,212,180":t.id==="noise"?"162,155,254":"255,165,2"},0.1)`,border:`1px solid ${t.color}`,borderRadius:6,color:t.color,transition:"all 0.15s"}}>
                  {t.btnLabel}
                </button>
              </div>
            </div>
          }/>
        ))}
      </div>
    </div>
  );
}

// ─── Octave Confusion Check ───────────────────────────────────────────────────
function OctaveCheck({freq, vol, earRoute, onConfirm, onOctaveUp, onOctaveDown}) {
  const [step,      setStep]   = useState("intro"); // intro | playing | asked
  const [playingHz, setPlayingHz] = useState(null);

  const ac  = useRef(null);
  const osc = useRef(null);
  const gn  = useRef(null);
  const tmr = useRef(null);

  const audio = () => {
    if (!ac.current) ac.current = new (window.AudioContext||window.webkitAudioContext)();
    if (ac.current.state==="suspended") ac.current.resume();
    return ac.current;
  };

  const play = (hz) => {
    const ctx = audio();
    try { osc.current && osc.current.stop(); } catch(_){}
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    // Inherit volume from ToneFinder — same perceived level for a fair octave comparison
    g.gain.linearRampToValueAtTime(dBtoG(vol || 65), ctx.currentTime + 0.08);
    o.type = "sine"; o.frequency.value = hz;
    o.connect(g);
    // Route to same ear the tinnitus was matched in
    const route = earRoute || "both";
    if (route !== "both" && ctx.destination.channelCount >= 2) {
      const merger = ctx.createChannelMerger(2);
      g.connect(merger, 0, route === "left" ? 0 : 1);
      merger.connect(ctx.destination);
    } else { g.connect(ctx.destination); }
    o.start(); osc.current = o; gn.current = g; setPlayingHz(hz);
  };

  const stop = () => {
    if (gn.current && ac.current) {
      try { gn.current.gain.linearRampToValueAtTime(0, ac.current.currentTime+0.08); } catch(_){}
    }
    const o = osc.current;
    setTimeout(()=>{try{o&&o.stop();}catch(_){}osc.current=null;}, 130);
    setPlayingHz(null);
  };

  useEffect(()=>()=>{
    clearTimeout(tmr.current);
    try{osc.current&&osc.current.stop();}catch(_){}
    try{ac.current&&ac.current.close();}catch(_){}
  },[]);

  const candidates = [
    {hz: Math.round(freq/2),  label:"½ × (one octave DOWN)", action: onOctaveDown},
    {hz: freq,                label:"Your matched frequency", action: onConfirm},
    {hz: Math.min(Math.round(freq*2), 20000), label:"2× (one octave UP)", action: onOctaveUp},
  ].filter(c => c.hz >= 200 && c.hz <= 20000);

  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:22}}>
        <Big t="OCTAVE CONFUSION CHECK"/>
        <Lbl t="A COMMON MATCHING ERROR — LET'S VERIFY YOUR FREQUENCY" s={{textAlign:"center",marginTop:5,fontSize:14}}/>
      </div>

      <Panel s={{marginBottom:14,borderColor:K.amber+"44"}} ch={<>
        <Lbl t="⚠ WHAT IS OCTAVE CONFUSION?" c={K.amber} s={{marginBottom:8}}/>
        <Lbl t="It's common to accidentally match your tinnitus to a frequency that's exactly double or half the true value — they can sound deceptively similar. Studies show roughly 1 in 15 people make this error in self-directed matching. Getting this wrong means the notch will be placed at the wrong frequency and therapy won't work." s={{lineHeight:1.9,fontSize:14}}/>
      </>}/>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t={`YOU MATCHED: ${hzFmt(freq)}`} c={K.teal} s={{marginBottom:14,fontSize:12}}/>
        <Lbl t="Listen to each tone below and pick the one that sounds most like your tinnitus:" s={{marginBottom:16,lineHeight:1.8,fontSize:14}}/>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {candidates.map((c,i)=>{
            const isPlaying = playingHz===c.hz;
            return (
              <div key={i} style={{display:"flex",gap:10,alignItems:"center",padding:"12px 14px",background:K.dim,borderRadius:8,border:`1px solid ${isPlaying?K.teal:K.border}`}}>
                <button onClick={()=>isPlaying?stop():play(c.hz)} style={{width:36,height:36,borderRadius:"50%",background:isPlaying?"rgba(0,212,180,0.15)":"transparent",border:`1px solid ${isPlaying?K.teal:K.muted}`,color:isPlaying?K.teal:K.muted,fontSize:14,flexShrink:0,transition:"all 0.15s"}}>
                  {isPlaying?"⏹":"▶"}
                </button>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"'Courier New',monospace",fontSize:15,fontWeight:700,color:isPlaying?K.teal:K.text}}>{hzFmt(c.hz)}</div>
                  <Lbl t={c.label} s={{fontSize:13}}/>
                </div>
                <button onClick={()=>{stop();c.action(c.hz);}} style={{padding:"8px 16px",background:"rgba(0,212,180,0.06)",border:`1px solid ${K.teal}`,borderRadius:6,color:K.teal,fontFamily:"system-ui",fontWeight:600,fontSize:14,transition:"all 0.15s"}}>
                  THIS ONE ✓
                </button>
              </div>
            );
          })}
        </div>
      </>}/>

      <Panel s={{borderColor:K.dim}} ch={<>
        <Lbl t="💡 TIP" s={{marginBottom:6}}/>
        <Lbl t="Play each tone in sequence. Try to match not just the pitch but the quality. If two sound equally similar, choose the lower one — high-frequency tinnitus is sometimes perceived an octave lower than it actually is." s={{lineHeight:1.9,fontSize:13}}/>
      </>}/>
    </div>
  );
}

// ─── Account Screen ───────────────────────────────────────────────────────────
function AccountScreen({onSelect}) {
  const [users,   setUsers]   = useState(getAllUsers);
  const [adding,  setAdding]  = useState(false);
  const [newName, setNewName] = useState("");

  const addUser = () => {
    const name = newName.trim();
    if (!name) return;
    const id    = mkUid();
    const color = USER_COLORS[users.length % USER_COLORS.length];
    const u     = {id, name, color, createdAt: new Date().toISOString()};
    const updated = [...users, u];
    saveUsers(updated);
    setUsers(updated);
    setNewName(""); setAdding(false);
    onSelect(u, "begin");
  };

  return (
    <div style={{animation:"up 0.3s ease", maxWidth:640, margin:"0 auto"}}>
      <div style={{textAlign:"center", marginBottom:28}}>
        <Big t={<>TINNITUS <span style={{color:K.text}}>SUITE</span></>} sz={28} c={K.teal} s={{marginBottom:4}}/>
        <Lbl t="SELECT OR CREATE A PROFILE" s={{textAlign:"center",fontSize:11}}/>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14, marginBottom:20}}>
        {users.map(u => {
          const audios   = uGetJ(u.id,"audiograms",[]);
          const tones    = uGetJ(u.id,"tones",[]);
          const sessions = uGetJ(u.id,"sessions",[]);
          const totalMins = Math.round(sessions.reduce((a,s)=>a+(s.duration||0),0)/60);
          const lastTone  = tones.length ? tones[tones.length-1].freq : null;
          const hasReady  = audios.length>0 && lastTone;
          return (
            <div key={u.id} style={{background:K.card,borderRadius:12,padding:"18px 20px",border:`1px solid ${u.color}44`}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                <div style={{width:44,height:44,borderRadius:22,background:u.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:700,color:"#111",flexShrink:0}}>
                  {u.name[0].toUpperCase()}
                </div>
                <div>
                  <div style={{fontWeight:700,fontSize:16,letterSpacing:"0.05em"}}>{u.name.toUpperCase()}</div>
                  <div style={{fontSize:11,color:K.muted}}>
                    {audios.length} test{audios.length!==1?"s":""} · {lastTone ? `${lastTone} Hz` : "no tone yet"} · {totalMins} min therapy
                  </div>
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                {hasReady && (
                  <button onClick={()=>onSelect(u,"therapy")} style={{flex:1,padding:"8px 0",background:K.teal,color:"#111",border:"none",borderRadius:8,fontWeight:700,fontSize:12,letterSpacing:"0.08em",cursor:"pointer"}}>
                    ▶ THERAPY
                  </button>
                )}
                <button onClick={()=>onSelect(u,"begin")} style={{flex:hasReady?1:"auto",width:hasReady?"auto":"100%",padding:"8px 14px",background:K.card,color:K.teal,border:`1px solid ${K.teal}`,borderRadius:8,fontWeight:700,fontSize:12,letterSpacing:"0.08em",cursor:"pointer"}}>
                  {hasReady ? "↺ RE-TEST" : "BEGIN →"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {adding ? (
        <div style={{background:K.card,borderRadius:12,padding:"16px 18px",border:`1px solid ${K.teal}44`,display:"flex",gap:10,alignItems:"center"}}>
          <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&addUser()}
            placeholder="Enter name…"
            style={{flex:1,background:"#111",border:`1px solid ${K.teal}`,borderRadius:8,padding:"8px 12px",color:K.text,fontSize:14,outline:"none",fontFamily:"system-ui"}}
          />
          <button onClick={addUser} style={{padding:"8px 18px",background:K.teal,color:"#111",border:"none",borderRadius:8,fontWeight:700,fontSize:12,letterSpacing:"0.06em",cursor:"pointer"}}>ADD</button>
          <button onClick={()=>{setAdding(false);setNewName("");}} style={{padding:"8px 12px",background:"transparent",color:K.muted,border:`1px solid ${K.muted}44`,borderRadius:8,cursor:"pointer",fontSize:16}}>✕</button>
        </div>
      ) : (
        <button onClick={()=>setAdding(true)} style={{width:"100%",padding:"13px 0",background:"transparent",color:K.teal,border:`2px dashed ${K.teal}55`,borderRadius:12,fontWeight:700,fontSize:13,letterSpacing:"0.1em",cursor:"pointer",fontFamily:"'Courier New',monospace"}}>
          + ADD PROFILE
        </button>
      )}
    </div>
  );
}

// ─── Intro ────────────────────────────────────────────────────────────────────
// ─── Disclaimer ──────────────────────────────────────────────────────────────
function Disclaimer({onAccept}) {
  const [checked, setChecked] = useState(false);
  return (
    <div style={{animation:"up 0.4s ease",maxWidth:640,margin:"0 auto"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <Big t={<>TINNITUS <span style={{color:K.text}}>SUITE</span></>} sz={30} c={K.teal} s={{marginBottom:4}}/>
        <Lbl t="HEARING ASSESSMENT & PERSONALISED SOUND THERAPY" s={{textAlign:"center",fontSize:12,marginBottom:20}}/>
        <div style={{fontSize:36,marginBottom:12}}>⚠️</div>
        <Big t="EXPERIMENTAL SOFTWARE" sz={26} c={K.amber} s={{marginBottom:6}}/>
        <Lbl t="IMPORTANT — PLEASE READ BEFORE USING" c={K.amber} s={{textAlign:"center",fontSize:14,letterSpacing:"0.16em"}}/>
      </div>
      <Panel hi={K.amber+"88"} s={{marginBottom:16}} ch={
        <div style={{lineHeight:2,fontSize:14,color:K.text}}>
          <div style={{fontWeight:700,color:K.amber,marginBottom:14,fontSize:15}}>THIS IS NOT A MEDICAL DEVICE</div>
          <div style={{display:"grid",gap:10}}>
            {[
              "This software has NOT been approved, certified, or reviewed by the FDA, CE, Health Canada, TGA, MHRA, or any other regulatory body",
              "It is NOT intended to diagnose, treat, cure, or prevent any disease or medical condition",
              "Results must NOT be used to make any medical or clinical decisions",
              "The authors accept NO liability for any harm, hearing damage, or adverse effects from use of this software",
              "Stop immediately if you experience pain, discomfort, or worsening symptoms",
              "Always consult a qualified audiologist or ENT specialist for professional hearing care",
            ].map((t,i) => (
              <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                <span style={{color:K.amber,flexShrink:0,marginTop:2}}>▸</span>
                <span>{t}</span>
              </div>
            ))}
          </div>
        </div>
      }/>
      <Panel hi={K.border} s={{marginBottom:24}} ch={
        <label style={{display:"flex",alignItems:"flex-start",gap:14,cursor:"pointer"}}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e=>setChecked(e.target.checked)}
            style={{width:22,height:22,flexShrink:0,marginTop:2,accentColor:K.teal,cursor:"pointer"}}
          />
          <span style={{fontSize:14,lineHeight:1.9,color:K.text}}>
            I understand this is experimental software, <strong>not a medical device</strong>, and has not been approved by any regulatory or medical authority. I accept full responsibility for my use of this tool and will consult a medical professional for any health concerns.
          </span>
        </label>
      }/>
      <div style={{textAlign:"center"}}>
        <button
          disabled={!checked}
          onClick={()=>{ onAccept(); }}
          style={{
            fontFamily:"system-ui",fontWeight:700,fontSize:15,letterSpacing:"0.12em",
            padding:"16px 52px",borderRadius:8,border:`1px solid ${checked?K.teal:K.border}`,
            background:checked?"rgba(0,212,180,0.10)":"transparent",
            color:checked?K.teal:K.muted,
            transition:"all 0.2s",
            cursor:checked?"pointer":"not-allowed",
            animation:checked?"glow 2.5s ease-in-out infinite":"none",
          }}
        >
          {checked ? "I UNDERSTAND — CONTINUE →" : "TICK THE BOX ABOVE TO CONTINUE"}
        </button>
      </div>
    </div>
  );
}

function Intro({onStart, onSkip, savedData, onResume}) {
  return (
    <div style={{animation:"up 0.4s ease"}}>
      <div style={{textAlign:"center",marginBottom:36}}>
        <Big t={<>TINNITUS <span style={{color:K.text}}>SUITE</span></>} sz={38} c={K.teal} s={{marginBottom:6}}/>
        <Lbl t="CLINICAL HEARING ASSESSMENT & PERSONALISED SOUND THERAPY" s={{textAlign:"center",fontSize:14,letterSpacing:"0.18em"}}/>
      </div>
      <Panel s={{marginBottom:14}} ch={
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:20}}>
          {[
            {n:"01",t:"HEARING TEST",d:"Multi-frequency pure tone audiometry for both ears with full audiogram (up to 16 kHz)"},
            {n:"02",t:"TONE FINDER", d:"Sweep and match the exact frequency of your tinnitus ringing"},
            {n:"03",t:"THERAPY",     d:"Notched noise calibrated to suppress your specific tinnitus frequency"},
          ].map(s=>(
            <div key={s.n} style={{borderLeft:`2px solid ${K.teal}`,paddingLeft:12}}>
              <Lbl t={s.n} c={K.teal} sz={18} s={{opacity:0.25,marginBottom:8}}/>
              <div style={{fontFamily:"system-ui",fontWeight:600,fontSize:12,color:K.text,marginBottom:6}}>{s.t}</div>
              <Lbl t={s.d} s={{lineHeight:1.9,fontSize:13}}/>
            </div>
          ))}
        </div>
      }/>
      <Panel s={{marginBottom:28,borderColor:"#2a1f0a"}} ch={<>
        <Lbl t="⚠ BEFORE YOU BEGIN" c={K.amber} s={{marginBottom:10}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {["Wear headphones or earbuds — needed for per-ear testing","Find a quiet room free of background noise","Volume calibration will be guided in the next step — leave device volume as-is","This is a screening tool, not a medical diagnosis"].map(t=>(
            <Lbl key={t} t={`▸ ${t}`} s={{lineHeight:1.8,fontSize:14}}/>
          ))}
        </div>
      </>}/>
      {savedData && (
        <Panel s={{marginBottom:14,borderColor:K.teal+"55"}} ch={<>
          <Lbl t="↩ PREVIOUS SESSION DATA FOUND" c={K.teal} s={{marginBottom:8}}/>
          <Lbl t={`Hearing test complete · Last tinnitus match: ${hzFmt(savedData.freq)}`} s={{fontSize:14,lineHeight:1.8,marginBottom:12}}/>
          <button onClick={onResume} style={{width:"100%",padding:"13px",background:"rgba(0,212,180,0.1)",border:`1px solid ${K.teal}`,borderRadius:7,color:K.teal,fontFamily:"system-ui",fontWeight:600,fontSize:13,letterSpacing:"0.1em"}}>
            RESUME → TONE FINDER & THERAPY ↗
          </button>
        </>}/>
      )}
      <div style={{textAlign:"center"}}>
        <button onClick={onStart} style={{fontFamily:"system-ui",fontWeight:700,fontSize:14,letterSpacing:"0.14em",padding:"16px 52px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal,animation:"glow 2.5s ease-in-out infinite"}}>
          {savedData ? "RE-TEST FROM SCRATCH →" : "BEGIN ASSESSMENT →"}
        </button>
        <div style={{marginTop:16}}>
          <button onClick={onSkip} style={{fontFamily:"system-ui",fontWeight:500,fontSize:12,letterSpacing:"0.1em",padding:"10px 28px",background:"transparent",border:`1px solid ${K.muted}`,borderRadius:8,color:K.muted,transition:"all 0.2s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=K.muted;e.currentTarget.style.color=K.muted;}}>
            SKIP TO TONE FINDER & THERAPY →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Calibration ─────────────────────────────────────────────────────────────
// Anchors all dBHL measurements to a fixed output level.
// CAL_GAIN = 0.10 ≡ –20 dBFS; user raises device volume until tone is just audible.
const CAL_GAIN = 0.10;

function Calibration({onConfirm, onSkip}) {
  const [calPlaying, setCalPlaying] = useState(false);
  const calAc  = useRef(null);
  const calOsc = useRef(null);
  const calGn  = useRef(null);

  const startCalTone = () => {
    if (!calAc.current) calAc.current = mkCtx();
    if (calAc.current.state === "suspended") calAc.current.resume();
    const ctx = calAc.current;
    try { calOsc.current && calOsc.current.stop(); } catch(_){}
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 1000;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(CAL_GAIN, ctx.currentTime + 0.12);
    o.connect(g); g.connect(ctx.destination);
    o.start(); calOsc.current = o; calGn.current = g;
    setCalPlaying(true);
  };

  const stopCalTone = () => {
    if (calGn.current && calAc.current) {
      try { calGn.current.gain.linearRampToValueAtTime(0, calAc.current.currentTime + 0.1); } catch(_){}
    }
    const o = calOsc.current;
    setTimeout(() => { try { o && o.stop(); } catch(_){} calOsc.current = null; }, 150);
    setCalPlaying(false);
  };

  const confirm = () => {
    stopCalTone();
    onConfirm();
  };

  useEffect(() => () => {
    try { calOsc.current && calOsc.current.stop(); } catch(_){}
    try { calAc.current && calAc.current.close(); } catch(_){}
  }, []);

  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <Big t="VOLUME CALIBRATION"/>
        <Lbl t="SET SYSTEM VOLUME BEFORE TESTING" s={{textAlign:"center",marginTop:5,fontSize:14}}/>
      </div>

      <Panel s={{marginBottom:14,borderColor:K.amber+"55"}} ch={<>
        <Lbl t="⚠ WHY THIS MATTERS" c={K.amber} s={{marginBottom:8}}/>
        <Lbl t="Hearing thresholds (dBHL) are only meaningful relative to a fixed output level. Without this step, the same score could appear at wildly different system volumes — making the audiogram unreliable for calibrating your therapy volume." s={{lineHeight:1.9,fontSize:14}}/>
      </>}/>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="HOW TO CALIBRATE" c={K.teal} s={{marginBottom:14,fontSize:14}}/>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[
            {n:"1", t: "Put on your headphones or earbuds"},
            {n:"2", t: "Set your device volume to the MINIMUM (mute or 0)"},
            {n:"3", t: "Press PLAY below — you will hear a soft 1 kHz reference tone"},
            {n:"4", t: "Slowly raise your system volume until the tone is JUST barely audible"},
            {n:"5", t: "Add 2–3 volume steps more so it's comfortably soft — not silent, not loud"},
            {n:"6", t: "Press CONFIRM — do not change system volume for the rest of the session"},
          ].map(({n,t})=>(
            <div key={n} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
              <div style={{width:24,height:24,borderRadius:"50%",border:`1px solid ${K.teal}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Courier New',monospace",fontSize:14,color:K.teal}}>{n}</div>
              <Lbl t={t} s={{lineHeight:1.8,fontSize:14,paddingTop:3}}/>
            </div>
          ))}
        </div>

        {/* Reference tone player */}
        <div style={{marginTop:22,padding:"20px",background:K.dim,borderRadius:10,textAlign:"center"}}>
          <Lbl t="1 kHz REFERENCE TONE" c={K.teal} s={{marginBottom:12,fontSize:14}}/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:16,marginBottom:12}}>
            <button
              onClick={calPlaying ? stopCalTone : startCalTone}
              style={{width:64,height:64,borderRadius:"50%",fontSize:24,
                background:calPlaying?"rgba(0,212,180,0.15)":"rgba(0,212,180,0.05)",
                border:`2px solid ${calPlaying?K.teal:K.border}`,
                color:calPlaying?K.teal:K.muted,
                animation:calPlaying?"glow 2s ease-in-out infinite":"none",transition:"all 0.2s"}}>
              {calPlaying ? "⏹" : "▶"}
            </button>
            <div style={{textAlign:"left"}}>
              <Lbl t={calPlaying ? "PLAYING — raise system volume now" : "Tap to play reference tone"} c={calPlaying?K.teal:K.muted} s={{fontSize:14,marginBottom:4}}/>
              {calPlaying && (
                <div style={{display:"flex",gap:4,alignItems:"flex-end",height:20}}>
                  {[0,1,2,3,4].map(i=>(
                    <div key={i} style={{width:5,background:K.teal,borderRadius:2,
                      animation:`bar ${0.4+i*0.1}s ease-in-out infinite`,animationDelay:`${i*0.07}s`,
                      height:`${10+i*3}px`,transformOrigin:"bottom",opacity:0.7}}/>
                  ))}
                </div>
              )}
            </div>
          </div>
          <Lbl t="Fixed reference: 1 kHz · gain = –20 dBFS · plays continuously until you stop it" s={{fontSize:12,color:K.sub}}/>
        </div>
      </>}/>

      <Panel s={{marginBottom:14,borderColor:"#1e2a3e"}} ch={<>
        <Lbl t="⚠ IMPORTANT" c={K.amber} s={{marginBottom:6}}/>
        <Lbl t="After confirming, keep the headphones on — do not touch your system volume controls until the hearing test is finished. Changing volume mid-test corrupts your thresholds." s={{lineHeight:1.9,fontSize:14}}/>
      </>}/>

      <button
        onClick={confirm}
        style={{width:"100%",padding:"16px",background:"rgba(0,212,180,0.09)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal,fontFamily:"system-ui",fontWeight:700,fontSize:14,letterSpacing:"0.12em",marginBottom:12}}>
        ✓ VOLUME SET — CONFIRM &amp; CONTINUE
      </button>

      <div style={{textAlign:"center"}}>
        <button onClick={onSkip} style={{fontFamily:"system-ui",fontSize:14,padding:"8px 20px",background:"transparent",border:`1px solid ${K.muted}`,borderRadius:7,color:K.muted,transition:"all 0.2s"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=K.muted;e.currentTarget.style.color=K.muted;}}>
          SKIP CALIBRATION → CONTINUE
        </button>
      </div>
    </div>
  );
}

// ─── Hearing Test ─────────────────────────────────────────────────────────────
function HearingTest({onComplete, onSkip, calibrated}) {
  const [testMode, setTestMode] = useState(null); // null = show resolver screen first
  const [earIdx,  setEarIdx]  = useState(0);
  const [freqIdx, setFreqIdx] = useState(0);
  const [dB,      setDB]      = useState(60); // 60 dBHL start (better centre for tinnitus population)
  const [results, setResults] = useState({});
  const [step,    setStep]    = useState("ready");
  const [cdCount, setCdCount] = useState(null);
  const [lastAns, setLastAns] = useState(null);
  const [earDone, setEarDone] = useState(false);
  const [hwPhase, setHwPhase] = useState("descend"); // Hughson-Westlake: descend→ascend bracketing
  const [ascendHits, setAscendHits] = useState(0);    // count ascending "heard" at same level for 2/3 rule
  const [ascendTrials, setAscendTrials] = useState(0); // total ascending trials at same level
  const [catchTrialsDone, setCatchTrialsDone] = useState(0);
  const [falsePositives, setFalsePositives]   = useState(0);
  const [toneActuallyPlayed, setToneActuallyPlayed] = useState(false); // gate pre-tone responses

  // Active frequency list — derived from selected mode, used by all functions below
  const freqs  = testMode ? TEST_MODES.find(m=>m.id===testMode).freqs : FREQ_STANDARD;
  const fLabel = (f) => f >= 1000 ? `${(f/1000).toFixed(f%1000===0?0:1)}k` : `${f}`;

  const ac  = useRef(null);
  const osc = useRef(null);
  const gn  = useRef(null);
  const tmr = useRef(null);

  const audio = () => {
    if (!ac.current) ac.current = mkCtx();
    if (ac.current.state === "suspended") ac.current.resume();
    return ac.current;
  };

  const stopTone = () => {
    if (gn.current && ac.current) {
      try { gn.current.gain.linearRampToValueAtTime(0, ac.current.currentTime+0.06); } catch(_){}
    }
    const o = osc.current;
    setTimeout(() => { try{ o && o.stop(); }catch(_){} osc.current = null; }, 90);
  };

  const playTone = (freq, db, ear) => {
    const ctx = audio();
    try { osc.current && osc.current.stop(); } catch(_){}
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    // dBtoG reference=80 → gain=0.9 at 80 dBHL, 0.10 at 60 dBHL (matches CAL_GAIN).
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(dBtoG(db), ctx.currentTime + 0.08);
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g);
    if (ear !== "both" && ctx.destination.channelCount >= 2) {
      // Route to one ear with explicit silence on opposite channel
      const mg = ctx.createChannelMerger(2);
      g.connect(mg, 0, ear === "left" ? 0 : 1);
      // Explicit silence on opposite channel — prevents WebView channel bleed
      const silBuf = ctx.createBuffer(1, 128, ctx.sampleRate);
      const silSrc = ctx.createBufferSource();
      silSrc.buffer = silBuf; silSrc.loop = true;
      silSrc.connect(mg, 0, ear === "left" ? 1 : 0);
      silSrc.start();
      mg.connect(ctx.destination);
    } else { g.connect(ctx.destination); }
    o.start(); osc.current = o; gn.current = g;
    setToneActuallyPlayed(true);
  };

  const advance = (res) => {
    // Auto-save intermediate results so a crash doesn't lose the entire test
    try { sessionStorage.setItem("ht_partial", JSON.stringify(res)); } catch(_) {}
    if (freqIdx < freqs.length-1) {
      setFreqIdx(freqIdx+1); setDB(60); setHwPhase("descend"); setAscendHits(0); setAscendTrials(0); setStep("ready"); setLastAns(null);
    } else if (earIdx === 0) {
      setEarDone(true);
    } else {
      try { sessionStorage.removeItem("ht_partial"); } catch(_) {}
      onComplete(res, testMode, !!calibrated, falsePositives, catchTrialsDone);
    }
  };

  const answer = (heard) => {
    if (step !== "respond" && step !== "playing") return;
    // Gate: reject responses before tone actually played (prevents pre-tone false positives)
    if (!toneActuallyPlayed) return;
    clearTimeout(tmr.current); stopTone(); setLastAns(heard); setToneActuallyPlayed(false);
    const key = `${EARS[earIdx]}_${freqs[freqIdx]}`;

    // Check if this was a catch trial (no-tone presentation)
    if (step === "respond" && catchPendingR.current) {
      catchPendingR.current = false;
      setCatchTrialsDone(c => c + 1);
      if (heard) setFalsePositives(fp => fp + 1); // false positive — said YES to silence
      setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
      return;
    }

    if (heard) {
      if (hwPhase === "ascend") {
        // Hughson-Westlake 2-of-3 rule: need 2 ascending "heard" at same level
        const newHits = ascendHits + 1;
        const newTrials = ascendTrials + 1;
        if (newHits >= 2) {
          // Threshold confirmed at this level
          const r = {...results, [key]: dB};
          setResults(r); setAscendHits(0); setAscendTrials(0);
          setTimeout(() => advance(r), 400);
        } else if (newTrials >= 3) {
          // 3 trials done but didn't get 2 hits — step up 5 dB and reset
          setAscendHits(0); setAscendTrials(0);
          const next = dB + 5;
          if (next > 110) {
            const r = {...results, [key]: 110};
            setResults(r); setTimeout(() => advance(r), 400);
          } else {
            setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
          }
        } else {
          setAscendHits(newHits); setAscendTrials(newTrials);
          // Need to re-descend 10 dB and come back up per H-W protocol
          const next = Math.max(0, dB - 10);
          setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
        }
      } else {
        // Descending — step down 10 dB
        // FIX: if already at 0 dBHL, record threshold as 0 (excellent hearing)
        if (dB <= 0) {
          const r = {...results, [key]: 0};
          setResults(r); setTimeout(() => advance(r), 400);
        } else {
          const next = Math.max(0, dB - 10);
          setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
        }
      }
    } else {
      // Not heard — switch to ascending phase and step up 5 dB
      if (hwPhase === "descend") { setHwPhase("ascend"); setAscendHits(0); setAscendTrials(0); }
      else {
        // Ascending miss — count as trial but not hit
        const newTrials = ascendTrials + 1;
        if (newTrials >= 3 && ascendHits < 2) {
          // Failed 2/3 — step up and retry
          setAscendHits(0); setAscendTrials(0);
        } else {
          setAscendTrials(newTrials);
        }
      }
      const next = dB + 5;
      if (next > 110) {
        const r = {...results, [key]: 110};
        setResults(r); setTimeout(() => advance(r), 400);
      } else {
        setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
      }
    }
  };

  const catchPendingR = useRef(false); // true if current trial is a catch (no-tone)
  const runTrial = () => {
    setStep("countdown"); setLastAns(null); setToneActuallyPlayed(false);
    catchPendingR.current = false;

    // ~15% chance of catch trial (no tone) for false-positive detection
    const isCatch = Math.random() < 0.15;
    if (isCatch) catchPendingR.current = true;

    let c = 3; setCdCount(c);
    const tick = setInterval(() => {
      c--;
      if (c <= 0) {
        clearInterval(tick); setCdCount(null); setStep("playing");
        // Variable random delay 400-1600ms
        tmr.current = setTimeout(() => {
          if (isCatch) {
            // Catch trial — no tone, just wait then ask
            setToneActuallyPlayed(true); // allow response
            // Variable silence duration 1200-2200ms (matches tone duration range)
            tmr.current = setTimeout(() => { setStep("respond"); }, 1200 + Math.random()*1000);
          } else {
            playTone(freqs[freqIdx], dB, EARS[earIdx]);
            // Variable tone duration 1200-2200ms (clinical standard: 1-3s)
            const toneDur = 1200 + Math.random() * 1000;
            tmr.current = setTimeout(() => { stopTone(); setStep("respond"); }, toneDur);
          }
        }, 400 + Math.random()*1200);
      } else { setCdCount(c); }
    }, 1000);
  };

  const switchEar = () => {
    setEarDone(false); setEarIdx(1); setFreqIdx(0); setDB(60); setHwPhase("descend");
    setAscendHits(0); setAscendTrials(0); setStep("ready"); setLastAns(null);
  };

  useEffect(() => () => {
    clearTimeout(tmr.current);
    try { osc.current && osc.current.stop(); } catch(_){}
  }, []);

  const done = earIdx * freqs.length + freqIdx;
  const pct  = (done / (2*freqs.length)) * 100;

  // ── Mode chooser — shown before first tone ────────────────────────────────
  if (!testMode) {
    return (
      <div style={{animation:"up 0.3s ease"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <Big t="PURE TONE AUDIOMETRY"/>
          <Lbl t="CHOOSE TEST RESOLUTION" s={{textAlign:"center",marginTop:5,fontSize:14}}/>
        </div>
        <Lbl t="Use headphones or earbuds in a quiet room. Each mode tests both ears." s={{textAlign:"center",marginBottom:16,fontSize:13}}/>
        {TEST_MODES.map(m=>{
          const FMIN=200, FMAX=16000;
          const logP = f => Math.log2(f/FMIN)/Math.log2(FMAX/FMIN)*100;
          return (
          <div key={m.id} onClick={()=>setTestMode(m.id)}
            style={{background:K.card,border:`1px solid ${K.border}`,borderRadius:14,padding:20,marginBottom:10,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=K.teal}
            onMouseLeave={e=>e.currentTarget.style.borderColor=K.border}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <Big t={m.label} sz={20} c={K.teal}/>
              <Lbl t={m.est} c={K.amber} sz={13}/>
            </div>
            <Lbl t={m.desc} s={{lineHeight:1.8,marginBottom:10}}/>
            {/* Visual frequency coverage bar */}
            <div style={{position:"relative",height:18,background:K.dim,borderRadius:3,marginBottom:3}}>
              {m.freqs.map(f=>(
                <div key={f} title={hzFmt(f)} style={{position:"absolute",left:`${logP(f)}%`,top:"50%",
                  transform:"translate(-50%,-50%)",width:3,height:12,
                  background:K.teal,borderRadius:2,opacity:0.85}}/>
              ))}
            </div>
            <div style={{position:"relative",height:12}}>
              {[250,500,1000,2000,4000,8000,16000].map(f=>(
                <span key={f} style={{position:"absolute",left:`${logP(f)}%`,transform:"translateX(-50%)",
                  fontSize:7,color:K.sub,fontFamily:"'Courier New',monospace"}}>
                  {f>=1000?`${f/1000}k`:f}
                </span>
              ))}
            </div>
          </div>
          );
        })}
        <div style={{textAlign:"center",marginTop:14}}>
          <button onClick={onSkip} style={{fontFamily:"system-ui",fontSize:12,padding:"8px 24px",background:"transparent",border:`1px solid ${K.muted}`,borderRadius:7,color:K.muted,transition:"all 0.2s",letterSpacing:"0.1em"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=K.muted;e.currentTarget.style.color=K.muted;}}>
            SKIP HEARING TEST → GO TO THERAPY
          </button>
        </div>
      </div>
    );
  }

  if (earDone) {
    return (
      <div style={{animation:"up 0.3s ease"}}>
        <Panel s={{textAlign:"center",padding:52}} ch={<>
          <div style={{fontSize:60,marginBottom:20}}>👂</div>
          <Big t="LEFT EAR COMPLETE" sz={26} c={K.teal} s={{marginBottom:14}}/>
          <Lbl t={<>Now switch to test your <span style={{color:K.text}}>RIGHT EAR</span>. Seat the right earbud comfortably, then continue.</>}
            s={{fontSize:12,lineHeight:1.9,maxWidth:360,margin:"0 auto 32px",display:"block"}}/>
          <button onClick={switchEar} style={{fontFamily:"system-ui",fontWeight:700,fontSize:14,letterSpacing:"0.12em",padding:"16px 48px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal}}>
            TEST RIGHT EAR →
          </button>
        </>}/>
      </div>
    );
  }

  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:20}}>
        <Big t="PURE TONE AUDIOMETRY"/>
        <Lbl t={`${EARS[earIdx]==="left"?"◄ LEFT EAR":"RIGHT EAR ►"} · ${fLabel(freqs[freqIdx])}Hz · ${dB} dBHL`} s={{textAlign:"center",marginTop:5,fontSize:14}}/>
      </div>

      {/* False-positive warning if catch-trial failure rate > 30% */}
      {catchTrialsDone >= 2 && falsePositives / catchTrialsDone > 0.3 && (
        <Panel s={{marginBottom:14,borderColor:K.red+"55"}} ch={<>
          <Lbl t="⚠ RESPONSE ACCURACY CONCERN" c={K.red} s={{marginBottom:6}}/>
          <Lbl t={`You responded "heard" to ${falsePositives} of ${catchTrialsDone} silent catch trials. This may indicate you're pressing YES before confirming the tone. Please listen carefully and only respond YES when you're certain you heard something.`} s={{lineHeight:1.8,fontSize:13}}/>
        </>}/>
      )}

      <Panel s={{marginBottom:14}} ch={<>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
          <Lbl t="OVERALL PROGRESS"/>
          <Lbl t={`${Math.round(pct)}%`} c={K.teal}/>
        </div>
        <div style={{background:K.dim,borderRadius:3,height:4,marginBottom:16}}>
          <div style={{background:`linear-gradient(90deg,${K.teal},#00a896)`,width:`${pct}%`,height:"100%",borderRadius:3,transition:"width 0.5s"}}/>
        </div>
        <div style={{display:"flex",gap:12}}>
          {EARS.map((ear,ei) => (
            <div key={ear} style={{flex:1}}>
              <Lbl t={ear==="left"?"◄ LEFT":"RIGHT ►"} s={{marginBottom:6,fontSize:12}}/>
              <div style={{display:"flex",gap:2}}>
                {freqs.map((f,fi) => {
                  const isDone = results[`${ear}_${f}`] !== undefined;
                  const isActive = earIdx===ei && freqIdx===fi;
                  return (
                    <div key={f} style={{flex:1,height:22,borderRadius:3,minWidth:0,
                      background:isDone?"rgba(0,212,180,0.18)":isActive?"rgba(0,212,180,0.32)":"transparent",
                      border:`1px solid ${isDone?K.teal:isActive?K.teal:K.dim}`,
                      display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.3s"}}>
                      {isDone&&<span style={{fontSize:8,color:K.teal}}>✓</span>}
                      {isActive&&!isDone&&<span style={{fontSize:7,color:K.teal,animation:"pulse 1.5s infinite"}}>●</span>}
                    </div>
                  );
                })}
              </div>
              <div style={{display:"flex",gap:2,marginTop:2}}>
                {freqs.map((f,fi)=>(
                  <div key={f} style={{flex:1,textAlign:"center",minWidth:0,overflow:"hidden"}}>
                    <Lbl t={fLabel(f)} s={{fontSize:6,color:earIdx===ei&&freqIdx===fi?K.teal:K.sub}}/>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </>}/>

      <Panel s={{marginBottom:14,minHeight:210,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center"}} ch={<>
        {step==="ready"&&<>
          <div style={{fontSize:44,marginBottom:16}}>🎧</div>
          <Lbl t="READY TO TEST" c={K.text} sz={12} s={{marginBottom:6}}/>
          <Lbl t={`${EARS[earIdx]==="left"?"◄ Left":"Right ►"} ear · ${hzFmt(freqs[freqIdx])} · ${dB} dBHL`} s={{marginBottom:lastAns===false?12:28,lineHeight:1.7}}/>
          {lastAns===false&&<Lbl t={`Not heard — volume increased to ${dB} dBHL`} c={K.amber} s={{marginBottom:20,fontSize:14}}/>}
          <button onClick={runTrial} style={{fontFamily:"system-ui",fontWeight:600,fontSize:13,letterSpacing:"0.12em",padding:"13px 36px",background:"rgba(0,212,180,0.1)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal}}>▶ PLAY TONE</button>
        </>}

        {step==="countdown"&&<>
          <div style={{fontFamily:"system-ui",fontSize:80,fontWeight:700,color:K.teal,lineHeight:1,marginBottom:16,animation:"pulse 1s ease-in-out infinite"}}>{cdCount}</div>
          <Lbl t="GET READY TO LISTEN…" s={{fontSize:12}}/>
        </>}

        {step==="playing"&&<>
          <div style={{display:"flex",gap:6,alignItems:"flex-end",height:60,marginBottom:20}}>
            {[0,1,2,3,4].map(i=>(
              <div key={i} style={{width:9,background:K.teal,borderRadius:4,opacity:0.75,
                animation:`bar ${0.5+i*0.12}s ease-in-out infinite`,animationDelay:`${i*0.08}s`,
                height:`${20+i*9}px`,transformOrigin:"bottom"}}/>
            ))}
          </div>
          <Lbl t="TONE PLAYING — DID YOU HEAR IT?" c={K.text} sz={13} s={{marginBottom:20}}/>
          <div style={{display:"flex",gap:12}}>
            <button onClick={()=>answer(true)} style={{padding:"13px 28px",background:"rgba(0,212,180,0.1)",border:`1px solid ${K.teal}`,borderRadius:7,color:K.teal,fontFamily:"system-ui",fontWeight:600,fontSize:12}}>✓ YES, HEARD IT</button>
            <button onClick={()=>answer(false)} style={{padding:"13px 28px",background:"rgba(255,71,87,0.1)",border:`1px solid ${K.red}`,borderRadius:7,color:K.red,fontFamily:"system-ui",fontWeight:600,fontSize:12}}>✗ DIDN'T HEAR</button>
          </div>
        </>}

        {step==="respond"&&<>
          <Lbl t="DID YOU HEAR A TONE?" c={K.text} sz={14} s={{marginBottom:8}}/>
          <Lbl t="Press YES even if very faint" s={{marginBottom:28,lineHeight:1.7}}/>
          <div style={{display:"flex",gap:12}}>
            <button onClick={()=>answer(true)} style={{padding:"16px 40px",background:"rgba(0,212,180,0.12)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal,fontFamily:"system-ui",fontWeight:700,fontSize:15}}>✓ YES</button>
            <button onClick={()=>answer(false)} style={{padding:"16px 40px",background:"rgba(255,71,87,0.12)",border:`1px solid ${K.red}`,borderRadius:8,color:K.red,fontFamily:"system-ui",fontWeight:700,fontSize:15}}>✗ NO</button>
          </div>
        </>}
      </>}/>

      <Panel s={{borderColor:K.dim}} ch={
        <div style={{display:"flex",gap:20}}>
          <div style={{flex:1}}>
            <Lbl t="CURRENT LEVEL" s={{marginBottom:6}}/>
            <Big t={<>{dB}<span style={{fontSize:13}}> dBHL</span></>} sz={30} c={K.teal}/>
            <Lbl t={catFor(dB).label+" zone"} c={catFor(dB).color} s={{marginTop:4,fontSize:13}}/>
          </div>
          <div style={{flex:2,borderLeft:`1px solid ${K.dim}`,paddingLeft:20}}>
            <Lbl t="HOW IT WORKS" s={{marginBottom:8}}/>
            <Lbl t="Starting at 60 dBHL and descending 10 dB each time you hear it. When you first miss, it rises in 5 dB steps. Threshold is confirmed when you hear 2-of-3 ascending presentations at the same level. ~15% of trials are silent catch trials to verify response accuracy. This Hughson-Westlake method follows clinical ISO 8253-1 audiometry. Each ear is tested independently." s={{lineHeight:1.9,fontSize:13}}/>
          </div>
        </div>
      }/>
      <div style={{textAlign:"center",marginTop:14}}>
        <button onClick={onSkip} style={{fontFamily:"system-ui",fontSize:12,padding:"8px 24px",background:"transparent",border:`1px solid ${K.muted}`,borderRadius:7,color:K.muted,transition:"all 0.2s",letterSpacing:"0.1em"}}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=K.muted;e.currentTarget.style.color=K.muted;}}>
          SKIP HEARING TEST → GO TO THERAPY
        </button>
      </div>
    </div>
  );
}

// ─── Test Results ─────────────────────────────────────────────────────────────
function TestResults({results, onContinue}) {
  const rf   = resFreqs(results);
  const avgL = rf.reduce((s,f)=>s+(results[`left_${f}`]||0),0)/rf.length;
  const avgR = rf.reduce((s,f)=>s+(results[`right_${f}`]||0),0)/rf.length;

  let worstF=rf[0]||250, worstV=-1;
  rf.forEach(f=>{
    const a=((results[`left_${f}`]||0)+(results[`right_${f}`]||0))/2;
    if(a>worstV){worstV=a;worstF=f;}
  });

  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:22}}>
        <Big t="AUDIOGRAM RESULTS"/>
        <Lbl t={`HEARING THRESHOLDS · BOTH EARS · ${rf.length} FREQUENCIES`} s={{textAlign:"center",marginTop:5,fontSize:14}}/>
      </div>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="AUDIOGRAM (dBHL — lower is better)" s={{marginBottom:16}}/>
        <div style={{position:"relative",height:210,paddingLeft:36,paddingBottom:28}}>
          {[0,15,25,40,55,70,90,110].map(d=>(
            <div key={d} style={{position:"absolute",left:0,right:0,top:`${(d/110)*100}%`}}>
              <span style={{position:"absolute",left:0,fontSize:8,color:K.sub,transform:"translateY(-50%)",fontFamily:"'Courier New',monospace"}}>{d}</span>
              <div style={{position:"absolute",left:34,right:0,top:"50%",borderTop:d===15||d===25?`1px dashed rgba(0,212,180,0.22)`:`1px solid ${K.dim}`}}/>
            </div>
          ))}
          <div style={{position:"absolute",left:34,right:0,top:0,height:`${(25/110)*100}%`,background:"rgba(0,212,180,0.05)"}}/>
          <div style={{position:"absolute",left:36,top:"2%",fontSize:8,color:"rgba(0,212,180,0.4)",fontFamily:"'Courier New',monospace"}}>NORMAL</div>

          {["left","right"].map(ear=>{
            const col=ear==="left"?K.teal:"#fd79a8", sym=ear==="left"?"X":"O";
            const logPct = (f) => Math.log2(f/rf[0]) / Math.log2(rf[rf.length-1]/rf[0]) * 100;
            return (
              <svg key={ear} style={{position:"absolute",left:34,top:0,width:"calc(100% - 34px)",height:"100%",overflow:"visible"}}>
                {rf.map((f,fi)=>{
                  if(fi===0)return null;
                  const y1=(results[`${ear}_${rf[fi-1]}`]||0)/110*100;
                  const y2=(results[`${ear}_${f}`]||0)/110*100;
                  return <line key={fi} x1={`${logPct(rf[fi-1])}%`} y1={`${y1}%`} x2={`${logPct(f)}%`} y2={`${y2}%`} stroke={col} strokeWidth="1.5" opacity="0.5"/>;
                })}
                {rf.map((f,fi)=>{
                  const yv=(results[`${ear}_${f}`]||0)/110*100;
                  return <text key={fi} x={`${logPct(f)}%`} y={`${yv}%`} textAnchor="middle" dominantBaseline="middle" fill={col} fontSize={rf.length>13?"9":"12"} fontWeight="bold">{sym}</text>;
                })}
              </svg>
            );
          })}
          {(()=>{ const logPct=(f)=>Math.log2(f/rf[0])/Math.log2(rf[rf.length-1]/rf[0])*100; return (
          <div style={{position:"absolute",left:34,right:0,bottom:0}}>
            {rf.map(f=>(
              <span key={f} style={{position:"absolute",left:`${logPct(f)}%`,transform:"translateX(-50%)",fontSize:7,color:K.sub,fontFamily:"'Courier New',monospace"}}>
                {f>=1000?`${f/1000}k`:f}
              </span>
            ))}
          </div>
          );})()}
        </div>
        <div style={{display:"flex",gap:24,justifyContent:"center",marginTop:8}}>
          <Lbl t="✕ LEFT EAR" c={K.teal}/>
          <Lbl t="○ RIGHT EAR" c="#fd79a8"/>
        </div>
      </>}/>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        {[["LEFT",avgL,"◄"],["RIGHT",avgR,"►"]].map(([ear,avg,arrow])=>{
          const ct=catFor(avg);
          return (
            <Panel key={ear} hi={ct.color+"44"} ch={<>
              <Lbl t={`${arrow} ${ear} EAR`} s={{marginBottom:6}}/>
              <Big t={<>{Math.round(avg)}<span style={{fontSize:13}}> dBHL</span></>} sz={32} c={ct.color} s={{marginBottom:4}}/>
              <div style={{fontFamily:"system-ui",fontWeight:600,fontSize:13,color:ct.color,marginBottom:4}}>{ct.label}</div>
            </>}/>
          );
        })}
      </div>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="FREQUENCY BREAKDOWN (dBHL)" s={{marginBottom:12}}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(60px,1fr))",gap:6}}>
          {rf.map(f=>{
            const l=results[`left_${f}`]||0, r=results[`right_${f}`]||0;
            const ct=catFor((l+r)/2);
            const lbl = f>=1000?`${(f/1000).toFixed(f%1000===0?0:1)}k`:`${f}`;
            return (
              <div key={f} style={{background:K.dim,borderRadius:8,padding:"10px 4px",textAlign:"center",border:`1px solid ${ct.color}33`}}>
                <Lbl t={`${lbl}Hz`} s={{fontSize:12,marginBottom:4}}/>
                <div style={{fontFamily:"system-ui",fontSize:14,fontWeight:700,color:ct.color,marginBottom:2}}>{Math.round((l+r)/2)}</div>
                <Lbl t={`L:${l} R:${r}`} s={{fontSize:8}}/>
              </div>
            );
          })}
        </div>
      </>}/>

      {worstV >= 25 && (
        <Panel s={{marginBottom:14,borderColor:K.amber+"44"}} ch={<>
          <Lbl t="⚠ NOTABLE FINDING" c={K.amber} s={{marginBottom:8}}/>
          <Lbl t={<>Your highest threshold was at <span style={{color:K.text}}>{hzFmt(worstF)}</span> ({Math.round(worstV)} dBHL — {catFor(worstV).label}). High-frequency loss frequently co-occurs with tinnitus. The tone finder will start here.</>} s={{lineHeight:1.9,fontSize:14}}/>
        </>}/>
      )}

      {/* Asymmetric hearing warning */}
      {(() => {
        const asymFreqs = rf.filter(f => {
          const l = results[`left_${f}`]||0, r = results[`right_${f}`]||0;
          return Math.abs(l - r) >= 20;
        });
        if (!asymFreqs.length) return null;
        return (
          <Panel s={{marginBottom:14,borderColor:K.red+"44"}} ch={<>
            <Lbl t="⚠ SIGNIFICANT EAR ASYMMETRY" c={K.red} s={{marginBottom:8}}/>
            <Lbl t={<>Your left and right ears differ by ≥20 dB at {asymFreqs.length === 1
              ? hzFmt(asymFreqs[0])
              : `${asymFreqs.length} frequencies (${asymFreqs.map(f=>hzFmt(f)).join(', ')})`
            }. A difference this large may warrant clinical evaluation. Unilateral hearing loss has causes (e.g., acoustic neuroma) that bilateral loss does not.</>} s={{lineHeight:1.9,fontSize:14}}/>
            <div style={{display:"flex",gap:12,marginTop:10}}>
              {asymFreqs.slice(0,4).map(f => {
                const l=results[`left_${f}`]||0, r=results[`right_${f}`]||0;
                return <div key={f} style={{background:K.dim,borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
                  <Lbl t={hzFmt(f)} s={{fontSize:11,marginBottom:3}}/>
                  <div style={{fontSize:12}}><span style={{color:K.teal}}>L:{l}</span> <span style={{color:"#fd79a8"}}>R:{r}</span></div>
                </div>;
              })}
            </div>
          </>}/>
        );
      })()}

      <div style={{textAlign:"center"}}>
        <button onClick={onContinue} style={{fontFamily:"system-ui",fontWeight:700,fontSize:14,letterSpacing:"0.12em",padding:"16px 48px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal}}>CONTINUE TO TONE FINDER →</button>
      </div>
    </div>
  );
}

// Derive tested frequencies from hearingResults keys — works for any test resolution
const resFreqs = (hRes) => {
  if (!hRes) return TEST_FREQS;
  const fs = [...new Set(
    Object.keys(hRes).filter(k=>k.startsWith("left_")).map(k=>parseInt(k.split("_")[1],10))
  )].sort((a,b)=>a-b);
  return fs.length ? fs : TEST_FREQS;
};

// Nearest hearing threshold lookup — for volume calibration and audiogram overlay
// Returns { freq, L, R, avg, cat } for the closest tested frequency to f
const nearestThresh = (f, hRes) => {
  if (!hRes) return null;
  const rf = resFreqs(hRes);
  const nf = rf.reduce((a, b) => Math.abs(b-f) < Math.abs(a-f) ? b : a);
  const L = hRes[`left_${nf}`]  || 0;
  const R = hRes[`right_${nf}`] || 0;
  return { freq: nf, L, R, avg: (L+R)/2, cat: catFor((L+R)/2) };
};

// ─── History Screen ───────────────────────────────────────────────────────────
const HIST_COLORS = ["#00d4b4","#ffa502","#fd79a8","#a29bfe","#26de81","#74b9ff"];
function HistoryScreen({user}) {
  const [tab, setTab] = useState("audiogram");
  const audiograms = uGetJ(user.id,"audiograms",[]);
  const tones      = uGetJ(user.id,"tones",[]);
  const sessions   = uGetJ(user.id,"sessions",[]);
  const totalMins  = sessions.reduce((a,s)=>a+(s.duration||0),0)/60;

  const streak = (() => {
    if (!sessions.length) return 0;
    const days = [...new Set(sessions.map(s=>s.date.slice(0,10)))].sort().reverse();
    const today = new Date().toISOString().slice(0,10);
    const yest  = new Date(Date.now()-86400000).toISOString().slice(0,10);
    if (days[0]!==today && days[0]!==yest) return 0;
    let st = 1;
    for (let i=1; i<days.length; i++) {
      const diff = (new Date(days[i-1]) - new Date(days[i])) / 86400000;
      if (diff <= 1) st++; else break;
    }
    return st;
  })();

  const AudiogramTab = () => {
    const recent   = audiograms.slice(-6);
    const allFreqs = [500,1000,2000,3000,4000,6000,8000];
    const W=400, H=220, pl=40, pr=10, pt=18, pb=32;
    const iw=W-pl-pr, ih=H-pt-pb;
    const xOf = f  => pl + iw*Math.log2(f/250)/Math.log2(20000/250);
    const yOf = db => pt + ih*(db+10)/120;
    return (
      <div style={{overflowX:"auto"}}>
        {recent.length===0 && <div style={{color:K.muted,textAlign:"center",padding:40}}>No hearing tests recorded yet.</div>}
        {recent.length>0 && (<>
          <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",maxWidth:W,display:"block",margin:"0 auto"}}>
            {[-10,0,20,40,60,80,100].map(db=>(
              <g key={db}>
                <line x1={pl} x2={W-pr} y1={yOf(db)} y2={yOf(db)} stroke="#333" strokeWidth={db===0?1.2:0.5}/>
                <text x={pl-4} y={yOf(db)+4} fontSize={8} fill={K.muted} textAnchor="end">{db}</text>
              </g>
            ))}
            {allFreqs.map(f=>(
              <g key={f}>
                <line x1={xOf(f)} x2={xOf(f)} y1={pt} y2={H-pb} stroke="#333" strokeWidth={0.5}/>
                <text x={xOf(f)} y={H-pb+12} fontSize={8} fill={K.muted} textAnchor="middle">{f>=1000?`${f/1000}k`:f}</text>
              </g>
            ))}
            {recent.map((ag,i)=>{
              const col  = HIST_COLORS[recent.length-1-i] || "#666";
              const opac = 0.4 + (i/Math.max(recent.length-1,1))*0.6;
              const newest = i===recent.length-1;
              const lpts = allFreqs.filter(f=>ag.results&&ag.results[`left_${f}`]!=null).map(f=>`${xOf(f)},${yOf(ag.results[`left_${f}`])}`).join(" ");
              const rpts = allFreqs.filter(f=>ag.results&&ag.results[`right_${f}`]!=null).map(f=>`${xOf(f)},${yOf(ag.results[`right_${f}`])}`).join(" ");
              return (
                <g key={i}>
                  {lpts && <polyline points={lpts} fill="none" stroke={col} strokeWidth={newest?2:1.4} strokeOpacity={opac} strokeDasharray={newest?"none":"4,3"}/>}
                  {rpts && <polyline points={rpts} fill="none" stroke={col} strokeWidth={newest?1.5:1} strokeOpacity={opac*0.7} strokeDasharray="2,2"/>}
                </g>
              );
            })}
            <text x={pl} y={pt-4} fontSize={8} fill={K.muted}>— left (solid)   - - right</text>
          </svg>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8,justifyContent:"center"}}>
            {recent.map((ag,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:K.muted}}>
                <div style={{width:16,height:3,background:HIST_COLORS[recent.length-1-i]||"#666",borderRadius:2}}/>
                {new Date(ag.date).toLocaleDateString()} {ag.mode||""}
              </div>
            ))}
          </div>
        </>)}
      </div>
    );
  };

  const TonesTab = () => (
    <div>
      {tones.length===0 && <div style={{color:K.muted,textAlign:"center",padding:40}}>No tones selected yet.</div>}
      {[...tones].reverse().map((t,i,arr)=>{
        const prev = arr[i+1];
        const pct  = prev && prev.freq ? Math.round((t.freq-prev.freq)/prev.freq*100) : null;
        return (
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #222"}}>
            <div>
              <span style={{fontSize:18,fontWeight:700,color:K.teal}}>{t.freq} Hz</span>
              <span style={{fontSize:11,color:K.muted,marginLeft:8}}>
                {t.ear==="both"?"Both":t.ear==="left"?"Left":"Right"} · {t.vol||55} dB
              </span>
            </div>
            <div style={{textAlign:"right"}}>
              {pct!==null && <div style={{fontSize:11,color:pct>0?K.amber:pct<0?"#26de81":K.muted}}>{pct>0?"+":""}{pct}%</div>}
              <div style={{fontSize:10,color:K.muted}}>{new Date(t.date).toLocaleDateString()}</div>
            </div>
          </div>
        );
      })}
    </div>
  );

  const SessionsTab = () => (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
        {[{label:"SESSIONS",value:sessions.length},{label:"TOTAL",value:`${Math.round(totalMins)} min`},{label:"STREAK",value:`${streak} day${streak!==1?"s":""}`}].map(c=>(
          <div key={c.label} style={{background:K.card,borderRadius:10,padding:"14px 8px",textAlign:"center",border:"1px solid #222"}}>
            <div style={{fontSize:22,fontWeight:700,color:K.teal}}>{c.value}</div>
            <div style={{fontSize:9,color:K.muted,letterSpacing:"0.1em",marginTop:2}}>{c.label}</div>
          </div>
        ))}
      </div>
      {sessions.length===0 && <div style={{color:K.muted,textAlign:"center",padding:24}}>No sessions yet.</div>}
      {[...sessions].reverse().slice(0,50).map((s,i)=>(
        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #222",fontSize:13}}>
          <span style={{color:K.text}}>{new Date(s.date).toLocaleString()}</span>
          <span style={{color:K.teal}}>{Math.round((s.duration||0)/60)} min · {s.frequency} Hz</span>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{animation:"up 0.3s ease",maxWidth:640,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div style={{width:38,height:38,borderRadius:19,background:user.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:700,color:"#111",flexShrink:0}}>
          {user.name[0].toUpperCase()}
        </div>
        <div>
          <div style={{fontWeight:700,fontSize:16,letterSpacing:"0.05em"}}>{user.name.toUpperCase()}</div>
          <div style={{fontSize:11,color:K.muted}}>HISTORY &amp; PROGRESSION</div>
        </div>
      </div>
      <div style={{display:"flex",gap:4,marginBottom:20,background:K.card,borderRadius:10,padding:4}}>
        {["audiogram","tones","sessions"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"8px 0",background:tab===t?K.teal:"transparent",color:tab===t?"#111":K.muted,border:"none",borderRadius:7,fontWeight:700,fontSize:11,letterSpacing:"0.08em",cursor:"pointer",textTransform:"uppercase",fontFamily:"'Courier New',monospace"}}>
            {t==="audiogram"?"AUDIOGRAM":t==="tones"?"TONES":"SESSIONS"}
          </button>
        ))}
      </div>
      {tab==="audiogram" && <AudiogramTab/>}
      {tab==="tones"     && <TonesTab/>}
      {tab==="sessions"  && <SessionsTab/>}
    </div>
  );
}

// ─── Tone Finder ──────────────────────────────────────────────────────────────
function ToneFinder({hearingResults, userId, onComplete}) {
  const {f2s, s2f, SMAX} = logSlider(200, 20000);

  // ── Cross-session frequency consistency (Critique recommendation #4) ──
  const toneHistory = userId ? uGetJ(userId, "tones", []) : [];
  const pastFreqs   = toneHistory.map(t => t.freq).filter(Boolean);
  const medianFreq  = pastFreqs.length >= 2
    ? (() => { const s = [...pastFreqs].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : Math.round((s[m-1]+s[m])/2); })()
    : null;
  // Variance in cents (perceptually meaningful across frequencies)
  const freqVarianceCents = pastFreqs.length >= 2 && medianFreq
    ? Math.round(Math.sqrt(pastFreqs.reduce((s,f) => s + Math.pow(1200*Math.log2(f/medianFreq), 2), 0) / pastFreqs.length))
    : null;
  const highVariance = freqVarianceCents !== null && freqVarianceCents > 200; // > 2 semitones

  // Pick start frequency from worst test result
  const initF = (() => {
    if (!hearingResults) return 8000;
    let wf=8000, wv=-1;
    resFreqs(hearingResults).forEach(f=>{
      const a=((hearingResults[`left_${f}`]||0)+(hearingResults[`right_${f}`]||0))/2;
      if(a>wv && f>=200 && f<=20000){wv=a;wf=f;}
    });
    return wf;
  })();

  // ── Hearing-data-derived initialisation ──────────────────────────────────
  // Start volume = threshold at initF + 10 dB sensation level.
  // Reference now at 80 dB (=0.9 gain). Floor at 62 ensures gain≥0.12 — audible after calibration.
  // Without audiogram, default 65 → gain≈0.17 (clearly above CAL_GAIN=0.10 threshold reference).
  const initThr   = nearestThresh(initF, hearingResults);
  const initVol   = initThr ? Math.min(75, Math.max(62, Math.round(initThr.avg) + 10)) : 65;

  // Default ear routing to the ear with worse high-frequency average (2k–12k)
  const worseEar  = (() => {
    if (!hearingResults) return "both";
    const hfF = [2000,3000,4000,6000,8000,10000,12000];
    const lAvg = hfF.reduce((s,f)=>s+(hearingResults[`left_${f}`]||0),0)/hfF.length;
    const rAvg = hfF.reduce((s,f)=>s+(hearingResults[`right_${f}`]||0),0)/hfF.length;
    if (Math.abs(lAvg-rAvg) < 10) return "both"; // symmetric — use both ears
    return lAvg > rAvg ? "left" : "right";
  })();

  // NIHL notch detection: 4kHz or 6kHz threshold ≥15dB above 2kHz AND ≥10dB above 8kHz
  const nihlNotch = (() => {
    if (!hearingResults) return null;
    for (const ear of ["left","right"]) {
      const t2=hearingResults[`${ear}_2000`]||0, t4=hearingResults[`${ear}_4000`]||0,
            t6=hearingResults[`${ear}_6000`]||0, t8=hearingResults[`${ear}_8000`]||0;
      if (t4 > t2+15 && t4 > t8+10) return {ear, freq:4000};
      if (t6 > t2+15 && t6 > t8+10) return {ear, freq:6000};
    }
    return null;
  })();

  // Audiogram slope: if high-freq average loss is >20dB worse than low-freq, pink is easier
  const slopeRec  = (() => {
    if (!hearingResults) return null;
    const low  = [250,500,1000].reduce((s,f)=>s+((hearingResults[`left_${f}`]||0)+(hearingResults[`right_${f}`]||0))/2,0)/3;
    const high = [4000,6000,8000].reduce((s,f)=>s+((hearingResults[`left_${f}`]||0)+(hearingResults[`right_${f}`]||0))/2,0)/3;
    return high-low > 20 ? "pink" : null;
  })();
  // ──────────────────────────────────────────────────────────────────────────

  const [dispHz, setDispHz] = useState(initF);
  const [vol,    setVol]    = useState(initVol);   // threshold-calibrated start
  const [wave,   setWave]   = useState("sine");
  const [playing,setPlaying]= useState(false);
  const [sweeping,setSweeping]=useState(false);
  const [earRoute, setEarRoute] = useState(worseEar); // default to worse ear

  // Refs for audio state
  const fRef    = useRef(initF);
  const volRef  = useRef(initVol); volRef.current = vol;
  const waveRef = useRef("sine"); waveRef.current = wave;
  const earRef  = useRef(worseEar); earRef.current = earRoute;
  const playingRef = useRef(false); playingRef.current = playing;
  const slRef   = useRef(null);
  const ac      = useRef(null);
  const oscR    = useRef(null);
  const gainR   = useRef(null);
  const sweepR  = useRef(null);
  const sweepDir= useRef(1);

  const audio = () => {
    if (!ac.current) ac.current = mkCtx();
    if (ac.current.state==="suspended") ac.current.resume();
    return ac.current;
  };

  const setOscF = (f) => {
    if (oscR.current && ac.current)
      oscR.current.frequency.setTargetAtTime(f, ac.current.currentTime, 0.012);
  };

  // Imperatively move slider and update gradient
  const moveSlider = (f) => {
    if (!slRef.current) return;
    const sv = f2s(f);
    slRef.current.value = sv;
    setSliderGrad(slRef.current, sv/SMAX*100, K.teal);
  };

  // Apply a new frequency: update ref, display state, slider, oscillator
  const applyF = (f) => {
    const clamped = Math.max(200, Math.min(20000, Math.round(f)));
    fRef.current = clamped;
    setDispHz(clamped);
    moveSlider(clamped);
    setOscF(clamped);
  };

  // Proportional cent-based nudge — at 8kHz, 1¢ ≈ 4.6 Hz (perceptually meaningful)
  const applyFcents = (cents) => applyF(fRef.current * Math.pow(2, cents / 1200));

  const startTone = () => {
    const ctx = audio();
    // Force resume — browsers can leave AudioContext suspended on first interaction
    if (ctx.state === "suspended") ctx.resume();
    try { oscR.current && oscR.current.stop(); } catch(_){}
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = waveRef.current;
    o.frequency.value = fRef.current;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(dBtoG(volRef.current), ctx.currentTime+0.06);
    o.connect(g);
    const route = earRef.current;
    if (route !== "both" && ctx.destination.channelCount >= 2) {
      // True stereo output — route to specific ear only
      const merger = ctx.createChannelMerger(2);
      g.connect(merger, 0, route === "left" ? 0 : 1);
      merger.connect(ctx.destination);
    } else {
      // Mono output OR both ears — simple direct connection
      g.connect(ctx.destination);
    }
    o.start(); oscR.current=o; gainR.current=g;
    setPlaying(true);
  };

  const stopTone = () => {
    if (gainR.current && ac.current) {
      try { gainR.current.gain.linearRampToValueAtTime(0, ac.current.currentTime+0.08); } catch(_){}
      const o=oscR.current; setTimeout(()=>{try{o&&o.stop();}catch(_){}oscR.current=null;},130);
    }
    clearInterval(sweepR.current); setSweeping(false); setPlaying(false);
  };

  // Slider onChange — React normalises this to the native input event for ranges
  const onSliderChange = (e) => {
    const sv = parseInt(e.target.value, 10);
    const f  = s2f(sv);
    fRef.current = f;
    setDispHz(f);
    setSliderGrad(e.target, sv/SMAX*100, K.teal);
    setOscF(f);
  };

  // Initialise slider gradient after mount
  useEffect(() => {
    if (slRef.current) {
      slRef.current.value = f2s(initF);
      setSliderGrad(slRef.current, f2s(initF)/SMAX*100, K.teal);
    }
  }, []);

  useEffect(() => {
    if (gainR.current && ac.current)
      gainR.current.gain.setTargetAtTime(dBtoG(vol), ac.current.currentTime, 0.02);
  }, [vol]);

  useEffect(() => {
    if (oscR.current) { try { oscR.current.type = wave; } catch(_){} }
  }, [wave]);

  // Restart oscillator when ear routing changes (can't re-route live in Web Audio)
  useEffect(() => {
    if (playingRef.current) {
      try { oscR.current && oscR.current.stop(); } catch(_){} oscR.current = null;
      setTimeout(() => startTone(), 60);
    }
  }, [earRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  const startSweep = () => {
    if (!playing) startTone();
    setSweeping(true); sweepDir.current = 1;
    // Logarithmic sweep: 4¢ per 50 ms = 80¢/sec ≈ 2 octaves/min
    // Linear Hz was imperceptibly slow above 8 kHz and jumpy below 1 kHz
    sweepR.current = setInterval(() => {
      let f = fRef.current * Math.pow(2, sweepDir.current * (4 / 1200));
      if (f >= 20000) { sweepDir.current = -1; f = 20000; }
      if (f <= 200)   { sweepDir.current =  1; f = 200; }
      applyF(Math.round(f));
    }, 50);
  };

  useEffect(()=>()=>{
    clearInterval(sweepR.current);
    try{oscR.current&&oscR.current.stop();}catch(_){}
    try{ac.current&&ac.current.close();}catch(_){}
  },[]);

  const presets=[2000,4000,6000,8000,10000,12000,14000,16000,18000,20000];

  return (
    <div style={{animation:"up 0.3s ease"}}>
      <div style={{textAlign:"center",marginBottom:22}}>
        <Big t="TINNITUS TONE FINDER"/>
        <Lbl t="MATCH THIS TONE TO YOUR TINNITUS RINGING" s={{textAlign:"center",marginTop:5,fontSize:14}}/>
      </div>

      {/* Cross-session frequency consistency panel */}
      {pastFreqs.length >= 2 && medianFreq && (
        <Panel s={{marginBottom:14,borderColor:highVariance?K.amber+"66":K.teal+"44"}} ch={<>
          <Lbl t={`📐 FREQUENCY CONSISTENCY (${pastFreqs.length} PREVIOUS MATCHES)`} c={highVariance?K.amber:K.teal} s={{marginBottom:8,fontSize:12}}/>
          <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:8}}>
            <div>
              <Lbl t="MEDIAN" s={{fontSize:10,marginBottom:2}}/>
              <Big t={hzFmt(medianFreq)} sz={20} c={K.teal}/>
            </div>
            <div>
              <Lbl t="SPREAD (±)" s={{fontSize:10,marginBottom:2}}/>
              <Big t={`${freqVarianceCents}¢`} sz={20} c={highVariance?K.amber:"#a29bfe"}/>
            </div>
            <div>
              <Lbl t="RANGE" s={{fontSize:10,marginBottom:2}}/>
              <Big t={`${hzFmt(Math.min(...pastFreqs))} – ${hzFmt(Math.max(...pastFreqs))}`} sz={14} c={K.sub}/>
            </div>
          </div>
          {highVariance ? (
            <Lbl t="⚠ HIGH VARIANCE — your matches vary by more than 2 semitones across sessions. Take extra time to fine-tune today, and consider doing the Octave Confusion Check carefully. Inconsistent matching reduces therapy effectiveness." s={{lineHeight:1.8,fontSize:13,color:K.amber}}/>
          ) : (
            <Lbl t="✓ Your matches are consistent — good frequency lock. Small day-to-day variation is normal." s={{lineHeight:1.8,fontSize:13,color:K.teal}}/>
          )}
        </>}/>
      )}

      <Panel s={{textAlign:"center",marginBottom:14,position:"relative",overflow:"hidden"}} ch={<>
        <div style={{position:"absolute",inset:0,background:playing?"radial-gradient(ellipse at 50% 0%,rgba(0,212,180,0.05),transparent 60%)":"none",pointerEvents:"none",transition:"all 0.5s"}}/>
        <Big t={hzFmt(dispHz)} sz={56} c={playing?K.teal:K.muted} s={{marginBottom:4,textShadow:playing?"0 0 40px rgba(0,212,180,0.4)":"none",transition:"all 0.3s"}}/>
        <Lbl t={`${Math.round(dispHz)} Hz`} s={{textAlign:"center",marginBottom:24,fontSize:14}}/>

        <div style={{display:"flex",justifyContent:"center",marginBottom:24}}>
          <button onClick={()=>playing?stopTone():startTone()} style={{
            width:80,height:80,borderRadius:"50%",fontSize:28,position:"relative",
            background:playing?"rgba(0,212,180,0.12)":"rgba(0,212,180,0.05)",
            border:`2px solid ${playing?K.teal:K.border}`,color:playing?K.teal:K.muted,
            animation:playing?"glow 2s ease-in-out infinite":"none",transition:"all 0.2s"}}>
            {playing?"⏹":"▶"}
            {playing&&<div style={{position:"absolute",inset:-8,borderRadius:"50%",border:`1px solid ${K.teal}`,animation:"ring 1.5s ease-out infinite",pointerEvents:"none"}}/>}
          </button>
        </div>

        {/* UNCONTROLLED slider — defaultValue + ref + onChange */}
        <div style={{marginBottom:14}}>
          <input type="range" min={0} max={SMAX} step={1}
            defaultValue={f2s(initF)}
            ref={slRef}
            onChange={onSliderChange}
            className="sl-teal"
            style={{width:"100%",background:K.dim}}
          />
          {/* Audiogram overlay — hearing thresholds mapped to slider positions */}
          {hearingResults && (
            <div style={{position:"relative",height:22,marginTop:4}}>
              {resFreqs(hearingResults).filter(f=>f>=200&&f<=20000).map(f=>{
                const pct = f2s(f)/SMAX*100;
                const t   = nearestThresh(f, hearingResults);
                const avg = t ? t.avg : 0;
                const h   = Math.max(3, Math.round(avg/130*18));
                const col = catFor(avg).color;
                const rf2 = resFreqs(hearingResults);
                const active = Math.abs(f - dispHz) === rf2.reduce((best,tf)=>
                  Math.min(best, Math.abs(tf-dispHz)), Infinity);
                return (
                  <div key={f} title={`${hzFmt(f)}: L${Math.round(t?.L||0)} / R${Math.round(t?.R||0)} dBHL`}
                    style={{position:"absolute",left:`${pct}%`,bottom:0,
                      transform:"translateX(-50%)",width:5,height:h,
                      background:col,borderRadius:2,
                      opacity:active?1:0.55,
                      boxShadow:active?`0 0 6px ${col}`:"none",
                      transition:"opacity 0.2s"}}>
                  </div>
                );
              })}
              <div style={{position:"absolute",right:0,top:0,fontSize:8,color:K.sub,fontFamily:"'Courier New',monospace",letterSpacing:0}}>
                audiogram ↑
              </div>
            </div>
          )}
          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:K.sub,marginTop:2,fontFamily:"'Courier New',monospace"}}>
            {["200Hz","500Hz","1kHz","2kHz","4kHz","8kHz","12kHz","16kHz","20kHz"].map(l=><span key={l}>{l}</span>)}
          </div>
        </div>

        {/* Ear routing selector */}
        <div style={{display:"flex",justifyContent:"center",gap:8,marginBottom:12}}>
          {[{id:"left",label:"◄ LEFT"},{id:"both",label:"◄► BOTH"},{id:"right",label:"RIGHT ►"}].map(({id,label})=>(
            <button key={id} onClick={()=>setEarRoute(id)}
              style={{padding:"7px 14px",background:earRoute===id?"rgba(0,212,180,0.12)":"transparent",border:`1px solid ${earRoute===id?K.teal:K.border}`,borderRadius:6,color:earRoute===id?K.teal:K.muted,fontSize:13,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}>
              {label}
            </button>
          ))}
        </div>
        {/* Cent-based proportional tuning — accurate at all frequencies */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:5,marginBottom:5}}>
          {[{l:"−oct",c:-1200},{l:"−semi",c:-100},{l:"−10¢",c:-10},{l:"+10¢",c:10},{l:"+semi",c:100},{l:"+oct",c:1200}].map(({l,c})=>(
            <button key={l} onClick={()=>applyFcents(c)}
              style={{padding:"9px 2px",background:"transparent",border:`1px solid ${K.border}`,borderRadius:6,color:K.muted,fontSize:13,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=K.border;e.currentTarget.style.color=K.muted;}}>
              {l}
            </button>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
          {[{l:"−1¢ (micro)",c:-1},{l:"+1¢ (micro)",c:1}].map(({l,c})=>(
            <button key={l} onClick={()=>applyFcents(c)}
              style={{padding:"7px 4px",background:"transparent",border:`1px solid ${K.border}`,borderRadius:6,color:K.muted,fontSize:12,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=K.teal;e.currentTarget.style.color=K.teal;}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor=K.border;e.currentTarget.style.color=K.muted;}}>
              {l}
            </button>
          ))}
        </div>
      </>}/>

      {/* NIHL notch warning */}
      {nihlNotch && (
        <Panel s={{marginBottom:14,borderColor:K.amber+"66"}} ch={<>
          <Lbl t="⚠ NOISE-INDUCED PATTERN DETECTED" c={K.amber} s={{marginBottom:8}}/>
          <Lbl t={<>Your {nihlNotch.ear} ear shows a classic high-frequency notch at <span style={{color:K.text}}>{hzFmt(nihlNotch.freq)}</span> (≥15 dB worse than neighbours). This noise-induced hearing loss pattern is the most common co-factor for tinnitus. Your tinnitus pitch is typically <span style={{color:K.teal}}>one octave above the notch</span> — try {hzFmt(nihlNotch.freq*2)} as a starting point.</>} s={{lineHeight:1.9,fontSize:13}}/>
        </>}/>
      )}

      {/* Slope recommendation */}
      {slopeRec && (
        <Panel s={{marginBottom:14,borderColor:"#fd79a844"}} ch={<>
          <Lbl t="💡 NOISE TYPE SUGGESTION" c="#fd79a8" s={{marginBottom:6}}/>
          <Lbl t="Your audiogram shows a steep high-frequency slope. In the therapy step, pink noise (−3 dB/octave) will be more comfortable and effective than white noise — it won't over-stimulate your already-stressed high-frequency hair cells." s={{lineHeight:1.9,fontSize:13}}/>
        </>}/>
      )}

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="QUICK JUMP" s={{marginBottom:10}}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
          {presets.map(p=>{
            const near=Math.abs(dispHz-p)<500;
            return (
              <button key={p} onClick={()=>{applyF(p);if(!playing)startTone();}}
                style={{padding:"11px 4px",background:near?"rgba(0,212,180,0.1)":"transparent",
                  border:`1px solid ${near?K.teal:K.border}`,borderRadius:6,
                  color:near?K.teal:K.muted,fontSize:14,fontFamily:"'Courier New',monospace",transition:"all 0.2s"}}>
                {p>=1000?`${p/1000}kHz`:`${p}Hz`}
              </button>
            );
          })}
        </div>
      </>}/>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <Panel ch={<>
          <Lbl t="WAVE TYPE" s={{marginBottom:10}}/>
          {["sine","square","triangle","sawtooth"].map(w=>(
            <button key={w} onClick={()=>setWave(w)} style={{display:"block",width:"100%",textAlign:"left",padding:"9px 10px",marginBottom:4,background:wave===w?"rgba(0,212,180,0.08)":"transparent",border:`1px solid ${wave===w?K.teal:"transparent"}`,borderRadius:5,color:wave===w?K.teal:K.muted,fontSize:12,fontFamily:"'Courier New',monospace",textTransform:"capitalize",transition:"all 0.15s"}}>
              {w}{w==="sine"?" ← best":""}
            </button>
          ))}
        </>}/>
        <Panel ch={<>
          <Lbl t="VOLUME & SWEEP" s={{marginBottom:10}}/>
          <div style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <Lbl t="VOLUME"/><Lbl t={`${vol} dB`} c={K.teal}/>
            </div>
            <SldC val={vol} min={5} max={80} step={1} cls="sl-teal" color={K.teal} onCh={setVol}/>
            {/* Low-vol hint when no audiogram and volume is still quiet */}
            {!hearingResults && vol < 50 && (
              <div style={{marginTop:6,padding:"5px 8px",background:"rgba(255,165,2,0.07)",border:"1px solid rgba(255,165,2,0.25)",borderRadius:5,fontSize:12,fontFamily:"'Courier New',monospace",color:K.amber,lineHeight:1.7}}>
                Can't hear the tone? Raise volume above 55, or turn up system audio
              </div>
            )}
            {/* Threshold annotation — live-updates as slider moves */}
            {(() => {
              const t = nearestThresh(dispHz, hearingResults);
              if (!t) return null;
              const audible = vol > t.avg;
              return (
                <div style={{marginTop:7,padding:"5px 8px",background:K.dim,borderRadius:5,fontSize:12,fontFamily:"'Courier New',monospace",lineHeight:1.7}}>
                  <span style={{color:K.sub}}>Threshold @ {hzFmt(t.freq)}: </span>
                  <span style={{color:t.cat.color}}>{Math.round(t.L)}L / {Math.round(t.R)}R dBHL</span>
                  <span style={{color:audible?K.teal:K.red,marginLeft:8}}>{audible?"✓ audible":"↑ raise vol"}</span>
                </div>
              );
            })()}
          </div>
          <button onClick={sweeping?()=>{clearInterval(sweepR.current);setSweeping(false);}:startSweep}
            style={{width:"100%",padding:"11px",background:sweeping?"rgba(255,165,2,0.1)":"transparent",border:`1px solid ${sweeping?K.amber:K.border}`,borderRadius:6,color:sweeping?K.amber:K.muted,fontSize:14,fontFamily:"'Courier New',monospace",transition:"all 0.2s",marginBottom:8}}>
            {sweeping?"⏹ STOP SWEEP":"↕ AUTO SWEEP (200 Hz– 20 kHz)"}
          </button>
          <Lbl t="Slowly scans the full range — listen for when the tone fuses with your tinnitus" s={{lineHeight:1.8,fontSize:13}}/>
        </>}/>
      </div>

      <Panel s={{marginBottom:14,borderColor:K.dim}} ch={<>
        <Lbl t="💡 TIPS" s={{marginBottom:8}}/>
        <Lbl t={<>▸ Use Auto Sweep and listen for when the tone "fuses" with or disappears into your ringing<br/>▸ Use −semi/+semi (100¢) for fast tuning; −10¢/+10¢ for fine adjustment; ±1¢ for micro-tuning<br/>▸ Use L / BOTH / R buttons to isolate which ear hears the tinnitus tone<br/>▸ Sine wave matches a pure whistle — try others for buzzy or hissy tinnitus<br/>▸ Most high-pitched tinnitus sits between 6 kHz and 16 kHz; ultra-high up to 20 kHz is possible</>} s={{lineHeight:1.9,fontSize:13}}/>
      </>}/>

      <div style={{textAlign:"center"}}>
        <button onClick={()=>{stopTone();onComplete(fRef.current, volRef.current, earRef.current);}} style={{fontFamily:"system-ui",fontWeight:700,fontSize:14,letterSpacing:"0.12em",padding:"16px 48px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:8,color:K.teal}}>
          MATCHED: {hzFmt(dispHz)} → VERIFY OCTAVE
        </button>
        <Lbl t="Next step confirms you haven't accidentally matched the wrong octave" s={{textAlign:"center",marginTop:8,fontSize:13}}/>
      </div>
    </div>
  );
}

// ─── Noise Therapy ────────────────────────────────────────────────────────────
function NoiseTherapy({tinnitusFreq:initF, hearingResults, noiseTypeOnly, userId}) {
  const {f2s, s2f, SMAX} = logSlider(500, 20000);

  // Hearing-calibrated initial volume = threshold at tinnitus freq + 5 dB (just audible)
  // Without audiogram, default to 65 → gain≈0.17, clearly audible after calibration.
  // Floor at 62 → gain≥0.12, always above the CAL_GAIN threshold reference (0.10).
  const thrAtF   = nearestThresh(initF, hearingResults);
  const initVol  = thrAtF ? Math.min(75, Math.max(62, Math.round(thrAtF.avg) + 5)) : 65;

  // Audiogram slope: steep high-freq slope → recommend pink noise carrier
  const slopeRec = (() => {
    if (!hearingResults) return null;
    const low  = [250,500,1000].reduce((s,f)=>s+((hearingResults[`left_${f}`]||0)+(hearingResults[`right_${f}`]||0))/2,0)/3;
    const high = [4000,6000,8000].reduce((s,f)=>s+((hearingResults[`left_${f}`]||0)+(hearingResults[`right_${f}`]||0))/2,0)/3;
    return high-low > 20 ? "pink" : null;
  })();

  const [playing,  setPlaying]  = useState(false);
  // Default noise type: for sloping loss without tonal tinnitus, start on pink (gentler on damaged hair cells)
  const [nType,    setNType]    = useState(noiseTypeOnly ? (slopeRec||"white") : "notched");
  const [vol,      setVol]      = useState(initVol); // threshold-calibrated start
  const [sessMins, setSessMins] = useState(60);
  const [elapsed,  setElapsed]  = useState(0);
  const [dispF,    setDispF]    = useState(initF);
  const [showBimodal, setShowBimodal] = useState(false);

  // ── System-wide notch state (applies to Pandora/Spotify/YouTube/etc.) ──
  const [sysNotchAvail,   setSysNotchAvail]   = useState(false);
  const [sysNotchEnabled, setSysNotchEnabled]  = useState(false);
  const [sysNotchError,   setSysNotchError]    = useState(null);
  const [streamNoiseColor, setStreamNoiseColor] = useState(slopeRec || "white"); // "white"|"pink"|"brown"
  const [streamElapsed,   setStreamElapsed]    = useState(0);
  const [streamSessMins,  setStreamSessMins]   = useState(60);
  const [streamSleepMins, setStreamSleepMins]  = useState(0); // 0 = off; streaming sleep timer
  const [streamSleepEnded,setStreamSleepEnded] = useState(false);
  const [streamTargetHit, setStreamTargetHit]  = useState(false); // true when streaming session reaches target
  const streamTimerR  = useRef(null);
  const streamSleepR  = useRef(null);
  const streamElapsedRef = useRef(0); streamElapsedRef.current = streamElapsed;
  const silentKeepAliveR = useRef(null); // silent oscillator to keep AudioContext alive

  // ── Silent audio keep-alive for streaming mode ──
  // When streaming notch is active but in-app noise isn't playing, Android/Samsung
  // doesn't see any audio session from our app (DynamicsProcessing on session 0
  // is a system effect). This silent oscillator keeps the WebView AudioContext
  // active so the OS treats us as an audio app and won't kill the process.
  const startSilentKeepAlive = () => {
    if (silentKeepAliveR.current) return; // already running
    try {
      const ctx = audio();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // completely inaudible
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      silentKeepAliveR.current = { osc, gain };
    } catch (_) {}
  };
  const stopSilentKeepAlive = () => {
    if (!silentKeepAliveR.current) return;
    try {
      silentKeepAliveR.current.osc.stop();
      silentKeepAliveR.current.osc.disconnect();
      silentKeepAliveR.current.gain.disconnect();
    } catch (_) {}
    silentKeepAliveR.current = null;
  };

  // Probe system-wide notch availability on mount
  useEffect(() => {
    SystemNotch.isAvailable().then(r => setSysNotchAvail(r.available)).catch(() => {});
    // Cleanup: disable system notch and save session when leaving therapy screen
    return () => {
      clearInterval(streamTimerR.current);
      clearTimeout(streamSleepR.current);
      stopSilentKeepAlive();
      // Save if ran > 30s (only if saveStreamSession hasn't already run)
      if (streamElapsedRef.current > 30) {
        saveStreamSession();
      }
      SystemNotch.disable().catch(() => {});
      setSysNotchEnabled(false);
    };
  }, []);

  const saveStreamSession = () => {
    const dur = streamElapsedRef.current;
    if (dur > 30) {
      try {
        const _uid  = userId||"__guest";
        const saved = uGetJ(_uid,"sessions",[]);
        saved.push({ date: new Date().toISOString(), duration: dur, frequency: tfRef.current, type: "streaming" });
        if (saved.length > 200) saved.splice(0, saved.length - 200);
        uSetJ(_uid,"sessions",saved);
        setSessions([...saved]);
      } catch(_) {}
      // Reset to prevent duplicate save during unmount cleanup
      streamElapsedRef.current = 0;
    }
  };

  // Build audiogram array for native plugin (same format as hearingResults keys)
  const buildAudiogramPayload = () => {
    if (!hearingResults) return null;
    const freqs = resFreqs(hearingResults).filter(f => f >= 250 && f <= 12000);
    if (!freqs.length) return null;
    return freqs.map(f => ({
      freq: f,
      left:  hearingResults[`left_${f}`]  || 0,
      right: hearingResults[`right_${f}`] || 0,
    }));
  };

  const toggleSysNotch = async () => {
    setSysNotchError(null);
    try {
      if (sysNotchEnabled) {
        // Stop timer and save session
        clearInterval(streamTimerR.current);
        clearTimeout(streamSleepR.current);
        saveStreamSession();
        setStreamElapsed(0);
        setStreamTargetHit(false);
        setStreamSleepEnded(false);
        stopSilentKeepAlive();
        await SystemNotch.disable();
        setSysNotchEnabled(false);
      } else {
        const audiogram = buildAudiogramPayload();
        const params = { frequency: tfRef.current, depth: -ndRef.current, noiseColor: streamNoiseColor };
        if (audiogram) params.audiogram = audiogram;
        const res = await SystemNotch.enable(params);
        if (res.enabled) {
          setSysNotchEnabled(true);
          // Start silent audio keep-alive so Android sees an active audio session
          startSilentKeepAlive();
          setStreamTargetHit(false);
          setStreamSleepEnded(false);
          // Start timer
          setStreamElapsed(0);
          streamTimerR.current = setInterval(() => setStreamElapsed(e => e + 1), 1000);
          // Start streaming sleep timer if set
          clearTimeout(streamSleepR.current);
          if (streamSleepMins > 0) {
            streamSleepR.current = setTimeout(async () => {
              clearInterval(streamTimerR.current);
              saveStreamSession();
              setStreamElapsed(0);
              stopSilentKeepAlive();
              try { await SystemNotch.disable(); } catch(_) {}
              setSysNotchEnabled(false);
              setStreamSleepEnded(true);
            }, streamSleepMins * 60 * 1000);
          }
        }
      }
    } catch (e) {
      clearInterval(streamTimerR.current);
      clearTimeout(streamSleepR.current);
      stopSilentKeepAlive();
      setSysNotchError(e.message || "Failed to toggle system notch");
      setSysNotchEnabled(false);
    }
  };

  // ERB-scaled notch width — auto-calculated, no user guess needed
  // Capped at 40 dB: published TMNMT research used 12–20 dB. Beyond 40 dB causes biquad ringing.
  const [nDepth,   setNDepth]   = useState(30);

  // Keep system notch in sync with frequency / depth / noise color changes
  useEffect(() => {
    if (sysNotchEnabled) {
      SystemNotch.setFrequency({ frequency: dispF, depth: -nDepth, noiseColor: streamNoiseColor }).catch(() => {});
    }
  }, [dispF, nDepth, streamNoiseColor, sysNotchEnabled]);

  // Detect streaming session target reached
  useEffect(() => {
    if (sysNotchEnabled && streamElapsed >= streamSessMins * 60 && !streamTargetHit) {
      setStreamTargetHit(true);
    }
  }, [streamElapsed, streamSessMins, sysNotchEnabled, streamTargetHit]);

  const [sleepMins, setSleepMins] = useState(0); // 0 = off; auto-fade timer
  const [sleepEnded, setSleepEnded] = useState(false); // true after sleep timer fires
  const [sessions, setSessions] = useState(() => uGetJ(userId||"__guest","sessions",[]));

  // ── Music file carrier state (Okamoto et al. 2010 — music is the evidence-based carrier) ──
  const [musicBuf,    setMusicBuf]    = useState(null);   // decoded AudioBuffer
  const [musicName,   setMusicName]   = useState(null);   // filename for display
  const [musicLoading,setMusicLoading]= useState(false);
  const musicInputRef = useRef(null);

  // Decode uploaded music file into an AudioBuffer
  const handleMusicFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMusicLoading(true);
    try {
      const ctx = audio();
      const arrayBuf = await file.arrayBuffer();
      const decoded  = await ctx.decodeAudioData(arrayBuf);
      setMusicBuf(decoded);
      setMusicName(file.name);
      setNType("music");
    } catch (err) {
      console.error("Music decode error:", err);
      alert("Could not decode that audio file. Try MP3, WAV, OGG, or M4A.");
    } finally {
      setMusicLoading(false);
    }
  };

  const tfRef   = useRef(initF);
  const playRef = useRef(false); playRef.current = playing;
  const ntRef   = useRef(noiseTypeOnly ? "white" : "notched"); ntRef.current = nType;
  const volRef  = useRef(initVol); volRef.current = vol;
  const ndRef   = useRef(30); ndRef.current = nDepth;

  const slRef    = useRef(null);
  const canRef   = useRef(null);
  const streamCanRef = useRef(null);  // streaming notch viz canvas
  const streamAnimR  = useRef(null);  // streaming viz animation frame
  const streamBarsR  = useRef(null);  // persistent bar heights for smooth animation
  const streamColorR = useRef("white"); streamColorR.current = streamNoiseColor;
  const ac       = useRef(null);
  const srcR     = useRef(null);
  const gainR    = useRef(null);
  const analyR   = useRef(null);
  const animR    = useRef(null);
  const timerR   = useRef(null);
  const debR     = useRef(null);
  const sleepR   = useRef(null);
  const elapsedRef = useRef(0); elapsedRef.current = elapsed;
  // Buffer cache — each noise type generated once per session, never regenerated
  const bufCache = useRef({});

  const audio = () => {
    if (!ac.current) ac.current = mkCtx();
    if (ac.current.state==="suspended") ac.current.resume();
    return ac.current;
  };

  // Pre-generate all 3 noise types shortly after mount so first play is instant.
  // Stagger by 50 ms each to avoid a single large blocking chunk.
  useEffect(() => {
    const timers = ['white','pink','brown'].map((t, i) =>
      setTimeout(() => {
        try {
          const ctx = audio();
          if (!bufCache.current[t])
            bufCache.current[t] = t==='pink'?mkPink(ctx):t==='brown'?mkBrown(ctx):mkWhite(ctx);
        } catch(_) {}
      }, 150 + i * 50)
    );
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getBuffer = (type) => {
    const ctx = audio();
    if (!bufCache.current[type])
      bufCache.current[type] = type==="pink"?mkPink(ctx):type==="brown"?mkBrown(ctx):mkWhite(ctx);
    return bufCache.current[type];
  };

  const buildGraph = (type, vl, nd, tf) => {
    const ctx = audio();
    // Music type uses the uploaded AudioBuffer; noise types use generated buffers
    const isMusic = type === "music" && musicBuf;
    const buf = isMusic ? musicBuf : getBuffer(type);
    const src = ctx.createBufferSource(); src.buffer=buf; src.loop=true;
    const gain = ctx.createGain(); gain.gain.value = dBtoG(vl);
    const an = ctx.createAnalyser(); an.fftSize=2048; analyR.current=an;

    // ── Audiogram EQ ─────────────────────────────────────────────────────────
    // Shape the noise spectrum to compensate for the user's hearing loss at each
    // tested frequency. This ensures the therapeutic noise is perceived as
    // spectrally balanced rather than sounding thin at frequencies where the user
    // has significant loss. Without this, e.g. 40 dB loss at 6 kHz means the
    // noise at that band is nearly inaudible, reducing therapeutic efficacy.
    //
    // Method: peaking EQ at each audiogram frequency with gain = threshold × 0.5
    // (50% proportional compensation, capped at +18 dB), Q = 1.8.
    // Only applied where threshold > 10 dBHL (true loss, not measurement noise).
    const buildAudiogramEQ = () => {
      if (!hearingResults) return null;
      const freqs = resFreqs(hearingResults).filter(f => f >= 250 && f <= 12000);
      if (!freqs.length) return null;
      const nodes = freqs.map(f => {
        const l = hearingResults[`left_${f}`]  || 0;
        const r = hearingResults[`right_${f}`] || 0;
        const avg = (l + r) / 2;
        if (avg < 10) return null; // normal hearing at this freq — no compensation needed
        const node = ctx.createBiquadFilter();
        node.type = "peaking";
        node.frequency.value = f;
        node.Q.value = 1.8;
        node.gain.value = Math.min(18, avg * 0.5); // 50% compensation, cap at +18 dB
        return node;
      }).filter(Boolean);
      if (!nodes.length) return null;
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i+1]);
      return { first: nodes[0], last: nodes[nodes.length-1] };
    };
    const eq = buildAudiogramEQ();

    if (type === "notched" || type === "music") {
      // 1-octave notch cascade for therapeutic TMNMT shaping (Okamoto et al. 2010 PNAS):
      //   All published TMNMT studies used a 1-octave-wide notch (tf/√2 to tf×√2).
      //   Music carrier is the evidence-based choice — attention strengthens lateral inhibition.
      //   3-stage biquad cascade for steep roll-off and flat rejection band:
      //   Stage 1 — deep notch at exact tinnitus frequency
      //   Stage 2 — wider shallower notch (broadens the notch skirts to fill 1 oct)
      //   Stage 3 — slight low-side notch (compensates for biquad asymmetry above 8kHz)
      // Nyquist guard: clamp notch frequencies to prevent biquad instability
      const nyq = ctx.sampleRate / 2;
      const safeTf = Math.min(tf, nyq * 0.9); // keep notch center below 90% Nyquist
      const ow = 1.0;                       // 1 octave (Okamoto et al. 2010)
      const ho = ow * 0.5;                  // ±0.5 octave each side of centre
      const lf = safeTf / Math.pow(2, ho);  // tf / √2 ≈ tf × 0.707
      const hf = Math.min(safeTf * Math.pow(2, ho), nyq * 0.95); // clamp upper edge below Nyquist
      const Q  = safeTf / (hf - lf);        // Q ≈ 2.41 for 1-octave notch
      const n1 = ctx.createBiquadFilter(); n1.type="notch"; n1.frequency.value=safeTf;       n1.Q.value=Q;      n1.gain.value=-nd;
      const n2 = ctx.createBiquadFilter(); n2.type="notch"; n2.frequency.value=safeTf;       n2.Q.value=Q*0.65; n2.gain.value=-nd*0.5;
      const n3 = ctx.createBiquadFilter(); n3.type="notch"; n3.frequency.value=safeTf*0.955; n3.Q.value=Q*1.4;  n3.gain.value=-nd*0.3;
      src.connect(n1); n1.connect(n2); n2.connect(n3);
      if (eq) { n3.connect(eq.first); eq.last.connect(gain); }
      else    { n3.connect(gain); }
    } else {
      if (eq) { src.connect(eq.first); eq.last.connect(gain); }
      else    { src.connect(gain); }
    }
    gain.connect(an); an.connect(ctx.destination);
    src.start(); srcR.current=src; gainR.current=gain;
  };

  // ── Streaming notch visualizer ─────────────────────────────────────────────
  // Simulates a music-like spectrum with the notch clearly visible.
  // Since the system-wide filter is native (DynamicsProcessing), we don't have
  // a WebAudio analyser node for it — so we animate a convincing music spectrum
  // shape and cut the notch region out to visually communicate what's happening.
  const drawStreamingViz = useCallback(() => {
    cancelAnimationFrame(streamAnimR.current);
    const NUM_BARS = 80;
    if (!streamBarsR.current) {
      streamBarsR.current = new Float32Array(NUM_BARS);
      for (let i = 0; i < NUM_BARS; i++) streamBarsR.current[i] = Math.random() * 0.5;
    }
    const bars = streamBarsR.current;

    const frame = () => {
      streamAnimR.current = requestAnimationFrame(frame);
      const cv = streamCanRef.current;
      if (!cv) return;
      const g = cv.getContext("2d"), W = cv.width, H = cv.height;
      const tf = tfRef.current;
      const loEdge = tf / Math.SQRT2;
      const hiEdge = tf * Math.SQRT2;

      // Smoothly animate bar heights — music-like random motion
      for (let i = 0; i < NUM_BARS; i++) {
        const target = 0.15 + Math.random() * 0.65;
        bars[i] += (target - bars[i]) * 0.12;  // smooth interpolation
      }

      g.fillStyle = K.bg;
      g.fillRect(0, 0, W, H);

      // Frequency range: 20 Hz to 20 kHz (log scale)
      const fMin = 20, fMax = 20000;
      const logMin = Math.log2(fMin), logMax = Math.log2(fMax), logRange = logMax - logMin;

      // Draw notch zone highlight (background)
      const xLo = ((Math.log2(loEdge) - logMin) / logRange) * W;
      const xHi = ((Math.log2(hiEdge) - logMin) / logRange) * W;
      g.fillStyle = "rgba(255,71,87,0.06)";
      g.fillRect(xLo, 0, xHi - xLo, H);

      // Draw bars
      const barW = Math.max(2, (W / NUM_BARS) - 1);
      for (let i = 0; i < NUM_BARS; i++) {
        // Map bar index to frequency (log scale)
        const f = fMin * Math.pow(fMax / fMin, i / (NUM_BARS - 1));
        const x = ((Math.log2(f) - logMin) / logRange) * W;

        // Music-like spectral shape: more energy in low/mid, less in highs
        // Apply noise color tilt: pink = -3 dB/oct, brown = -6 dB/oct (relative to 1 kHz)
        const octFromRef = Math.log2(f / 1000);
        const sColor = streamColorR.current;
        const colorTilt = sColor === "brown" ? -6 * octFromRef
                        : sColor === "pink"  ? -3 * octFromRef : 0;
        const colorScale = Math.pow(10, colorTilt / 20); // dB to linear
        const baseShape = (1.0 - 0.35 * (i / NUM_BARS)) * Math.max(0.05, Math.min(2.0, colorScale));
        let h = bars[i] * baseShape;

        // Apply notch attenuation
        let notchAtten = 1.0;
        const nd = ndRef.current;
        if (f >= loEdge && f <= hiEdge) {
          // Inside the notch — calculate depth based on distance from center
          const distFromCenter = Math.abs(Math.log2(f / tf));
          const halfWidth = 0.5; // half octave
          const ratio = 1.0 - (distFromCenter / halfWidth);
          notchAtten = Math.max(0.02, 1.0 - ratio * (nd / 35));
        } else if (f >= loEdge * 0.7 && f < loEdge) {
          // Transition in
          const t = (f - loEdge * 0.7) / (loEdge - loEdge * 0.7);
          notchAtten = 1.0 - t * 0.4 * (nd / 35);
        } else if (f > hiEdge && f <= hiEdge * 1.4) {
          // Transition out
          const t = 1.0 - (f - hiEdge) / (hiEdge * 1.4 - hiEdge);
          notchAtten = 1.0 - t * 0.4 * (nd / 35);
        }
        h *= notchAtten;

        const barH = Math.max(1, h * (H - 16));

        // Color: notch region is red-tinted, outside is blue
        if (f >= loEdge * 0.85 && f <= hiEdge * 1.15) {
          const atten = 1.0 - notchAtten;
          const r = Math.round(116 + 139 * atten);
          const gn = Math.round(185 - 114 * atten);
          const b = Math.round(255 - 168 * atten);
          g.fillStyle = `rgba(${r},${gn},${b},${0.5 + atten * 0.4})`;
        } else {
          g.fillStyle = `rgba(116,185,255,${0.35 + bars[i] * 0.5})`;
        }
        g.fillRect(x - barW / 2, H - 12 - barH, barW, barH);

        // Glow cap on taller bars
        if (barH > 10) {
          g.fillStyle = "rgba(116,185,255,0.6)";
          g.fillRect(x - barW / 2, H - 12 - barH, barW, 2);
        }
      }

      // Notch center line
      const xTf = ((Math.log2(tf) - logMin) / logRange) * W;
      g.strokeStyle = "rgba(255,71,87,0.7)";
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(xTf, 0); g.lineTo(xTf, H - 12); g.stroke();
      g.setLineDash([]);

      // Notch edge lines
      g.strokeStyle = "rgba(255,71,87,0.25)";
      g.setLineDash([2, 4]);
      g.beginPath(); g.moveTo(xLo, 0); g.lineTo(xLo, H - 12); g.stroke();
      g.beginPath(); g.moveTo(xHi, 0); g.lineTo(xHi, H - 12); g.stroke();
      g.setLineDash([]);

      // Labels
      g.fillStyle = "rgba(255,71,87,0.85)";
      g.font = "10px 'Courier New',monospace";
      g.fillText(hzFmt(tf), Math.min(xTf + 4, W - 70), 12);
      g.fillStyle = "rgba(255,71,87,0.5)";
      g.font = "9px 'Courier New',monospace";
      g.fillText(hzFmt(Math.round(loEdge)), Math.max(xLo - 35, 2), 22);
      g.fillText(hzFmt(Math.round(hiEdge)), Math.min(xHi + 3, W - 50), 22);

      // Frequency axis
      g.fillStyle = K.sub;
      g.font = "8px 'Courier New',monospace";
      [100, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => {
        const fx = ((Math.log2(f) - logMin) / logRange) * W;
        g.fillText(f >= 1000 ? `${f / 1000}k` : f, fx, H - 2);
      });

      // "NOTCH" label in the gap
      g.fillStyle = "rgba(255,71,87,0.3)";
      g.font = "bold 11px system-ui";
      const notchLabelW = g.measureText("NOTCH").width;
      g.fillText("NOTCH", (xLo + xHi) / 2 - notchLabelW / 2, H / 2 + 3);
    };
    frame();
  }, []);

  // Start/stop streaming viz when system notch is toggled
  useEffect(() => {
    if (sysNotchEnabled) {
      drawStreamingViz();
    } else {
      cancelAnimationFrame(streamAnimR.current);
      // Clear canvas when disabled
      const cv = streamCanRef.current;
      if (cv) {
        const g = cv.getContext("2d");
        g.fillStyle = K.bg;
        g.fillRect(0, 0, cv.width, cv.height);
      }
    }
    return () => cancelAnimationFrame(streamAnimR.current);
  }, [sysNotchEnabled, drawStreamingViz]);

  const drawCanvas = useCallback(() => {
    cancelAnimationFrame(animR.current);
    const frame = () => {
      animR.current = requestAnimationFrame(frame);
      const an=analyR.current, cv=canRef.current; if(!an||!cv) return;
      const g=cv.getContext("2d"), W=cv.width, H=cv.height;
      const data=new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(data);
      g.fillStyle=K.bg; g.fillRect(0,0,W,H);
      const sr=ac.current?ac.current.sampleRate:44100;
      const tf=tfRef.current;
      if (ntRef.current === "notched" || ntRef.current === "music") {
        const tx=(Math.log2(tf/20)/Math.log2(sr/2/20))*W;
        g.fillStyle="rgba(255,71,87,0.07)"; g.fillRect(tx-20,0,40,H);
        g.strokeStyle="rgba(255,71,87,0.6)"; g.setLineDash([4,4]);
        g.beginPath(); g.moveTo(tx,0); g.lineTo(tx,H); g.stroke(); g.setLineDash([]);
        g.fillStyle="rgba(255,71,87,0.85)"; g.font="10px 'Courier New',monospace";
        g.fillText(hzFmt(tf), Math.min(tx+4,W-70), 14);
      }
      const gr=g.createLinearGradient(0,H,0,0);
      gr.addColorStop(0,"rgba(0,212,180,0.2)"); gr.addColorStop(1,"rgba(0,212,180,0.85)");
      g.fillStyle=gr;
      const bl=an.frequencyBinCount;
      for(let i=1;i<bl;i++){
        const f=(i/bl)*(sr/2); if(f<20||f>20000) continue;
        const x=(Math.log2(f/20)/Math.log2(20000/20))*W, h=(data[i]/255)*H;
        g.fillRect(x,H-h,2,h);
      }
      g.fillStyle=K.sub; g.font="9px 'Courier New',monospace";
      [100,500,1000,2000,5000,10000,20000].forEach(f=>{
        const x=(Math.log2(f/20)/Math.log2(20000/20))*W;
        g.fillText(f>=1000?`${f/1000}k`:f,x,H-4);
      });
    };
    frame();
  },[]);

  // Pause/resume animation loops when app goes to background/foreground
  // Prevents wasted CPU and potential WebView crashes on Android
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(streamAnimR.current);
        cancelAnimationFrame(animR.current);
      } else {
        if (sysNotchEnabled) drawStreamingViz();
        if (playing) drawCanvas();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [sysNotchEnabled, playing, drawStreamingViz, drawCanvas]);

  const stopAudio = () => {
    if(srcR.current&&gainR.current&&ac.current){
      try{gainR.current.gain.linearRampToValueAtTime(0,ac.current.currentTime+0.3);const s=srcR.current;setTimeout(()=>{try{s.stop();}catch(_){}},350);srcR.current=null;}catch(_){}
    }
  };

  const stop = () => {
    stopAudio();
    clearInterval(timerR.current);
    clearTimeout(sleepR.current);
    cancelAnimationFrame(animR.current);
    // Save session if it ran for > 30 s
    const dur = elapsedRef.current;
    if (dur > 30) {
      try {
        const _uid  = userId||"__guest";
        const saved = uGetJ(_uid,"sessions",[]);
        saved.push({ date: new Date().toISOString(), duration: dur, frequency: tfRef.current });
        if (saved.length > 200) saved.splice(0, saved.length - 200);
        uSetJ(_uid,"sessions",saved);
        setSessions([...saved]);
      } catch(_) {}
    }
    setPlaying(false);
  };

  const startPlaying = (tf) => {
    // If music type selected but no file loaded, don't start
    if (ntRef.current === "music" && !musicBuf) return;
    // Double-notch warning: if streaming notch is active AND we're using a notched type,
    // the system-wide DynamicsProcessing will double-apply the notch to our in-app audio
    if (sysNotchEnabled && (ntRef.current === "notched" || ntRef.current === "music")) {
      setSysNotchError("⚠ In-app notched audio + streaming notch active = double-notching. Consider disabling streaming notch while using in-app therapy, or switch to white/pink/brown noise.");
    }
    setElapsed(0); setSleepEnded(false);
    buildGraph(ntRef.current,volRef.current,ndRef.current,tf||tfRef.current);
    timerR.current = setInterval(()=>setElapsed(e=>e+1),1000);
    clearTimeout(sleepR.current);
    if (sleepMins > 0) {
      sleepR.current = setTimeout(() => {
        if (gainR.current && ac.current) {
          try { gainR.current.gain.linearRampToValueAtTime(0, ac.current.currentTime + 4); } catch(_){}
        }
        setTimeout(() => { stop(); setSleepEnded(true); }, 4200);
      }, sleepMins * 60 * 1000);
    }
    drawCanvas(); setPlaying(true);
  };

  const restart = (tf) => {
    if(!playRef.current) return;
    // Fade out existing audio before starting new graph to prevent click
    if (srcR.current && gainR.current && ac.current) {
      try {
        gainR.current.gain.linearRampToValueAtTime(0, ac.current.currentTime + 0.05);
        const oldSrc = srcR.current;
        setTimeout(() => { try { oldSrc.stop(); } catch(_) {} }, 80);
      } catch(_) {}
      srcR.current = null;
    }
    clearInterval(timerR.current); cancelAnimationFrame(animR.current);
    // Small delay to let fade complete
    setTimeout(() => {
      if (!playRef.current) return;
      buildGraph(ntRef.current,volRef.current,ndRef.current,tf||tfRef.current);
      timerR.current = setInterval(()=>setElapsed(e=>e+1),1000);
      drawCanvas();
    }, 90);
  };

  useEffect(()=>{
    if(gainR.current&&ac.current)
      gainR.current.gain.setTargetAtTime(dBtoG(vol),ac.current.currentTime,0.05);
  },[vol]);

  useEffect(()=>{ restart(); },[nType,nDepth,musicBuf]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFreqSliderChange = (e) => {
    const f = s2f(parseInt(e.target.value,10));
    tfRef.current=f; setDispF(f);
    setSliderGrad(e.target, f2s(f)/SMAX*100, K.red);
    clearTimeout(debR.current);
    debR.current=setTimeout(()=>restart(f),280);
  };

  // Cent-based fine-tune — perceptually uniform at all frequencies
  const fineTune = (cents) => {
    const f = Math.max(500, Math.min(20000, Math.round(tfRef.current * Math.pow(2, cents / 1200))));
    tfRef.current=f; setDispF(f);
    if(slRef.current){slRef.current.value=f2s(f);setSliderGrad(slRef.current,f2s(f)/SMAX*100,K.red);}
    clearTimeout(debR.current);
    debR.current=setTimeout(()=>restart(f),200);
  };

  useEffect(()=>{
    if(slRef.current){
      slRef.current.value=f2s(initF);
      setSliderGrad(slRef.current,f2s(initF)/SMAX*100,K.red);
    }
  },[]);

  useEffect(()=>()=>{
    clearInterval(timerR.current); cancelAnimationFrame(animR.current); clearTimeout(debR.current); clearTimeout(sleepR.current);
    bufCache.current = {}; // invalidate buffers — they belong to the old AudioContext
    try{srcR.current&&srcR.current.stop();}catch(_){}
    try{ac.current&&ac.current.close();}catch(_){}
  },[]);

  const em=Math.floor(elapsed/60), es=elapsed%60;
  const prog=Math.min((elapsed/(sessMins*60))*100,100);
  const erbWidth = 1.0;  // 1-octave notch width (Okamoto et al. 2010 PNAS)

  // Session statistics
  const totalMinutes = sessions.reduce((s, x) => s + Math.floor(x.duration / 60), 0);
  const totalHours = (totalMinutes / 60).toFixed(1);
  const streak = (() => {
    if (!sessions.length) return 0;
    const days = [...new Set(sessions.map(s => s.date.slice(0, 10)))].sort().reverse();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (days[0] !== today && days[0] !== yesterday) return 0;
    let count = 1;
    for (let i = 1; i < days.length; i++) {
      const diff = (new Date(days[i-1]) - new Date(days[i])) / 86400000;
      if (diff === 1) count++; else break;
    }
    return count;
  })();

  return (
    <div style={{animation:"up 0.3s ease"}}>
      {/* ── Evidence disclaimer banner (Critique recommendation #5) ── */}
      {!noiseTypeOnly && (
        <div style={{marginBottom:14,padding:"10px 14px",background:"rgba(255,165,2,0.05)",border:`1px solid ${K.amber}44`,borderRadius:8,display:"flex",gap:10,alignItems:"flex-start"}}>
          <span style={{color:K.amber,fontSize:16,flexShrink:0,marginTop:1}}>⚠</span>
          <Lbl t="TMNMT evidence is preliminary. The original Okamoto 2010 study had only 8 participants per group. A 2025 meta-analysis of 14 RCTs found modest benefit at 3 months (–8.6 THI points) and stronger effects at 6 months (–24.6 points), but not all studies show benefit vs. unnotched sound. This app is a simplified implementation — not a substitute for clinical care." s={{lineHeight:1.7,fontSize:12,color:K.amber}}/>
        </div>
      )}

      <div style={{textAlign:"center",marginBottom:20}}>
        <Big t="SOUND THERAPY"/>
        {noiseTypeOnly
          ? <Lbl t="BROADBAND MASKING · NOISE-TYPE TINNITUS" s={{textAlign:"center",marginTop:5,fontSize:14}}/>
          : <Lbl t={<>NOTCHED NOISE · TARGET: <span style={{color:K.red}}>{hzFmt(dispF)}</span></>} s={{textAlign:"center",marginTop:5,fontSize:14}}/>
        }
      </div>

      {noiseTypeOnly && (
        <Panel s={{marginBottom:14,borderColor:"#1e2a3e"}} ch={<>
          <Lbl t="ℹ BROADBAND MODE" c="#a29bfe" s={{marginBottom:8}}/>
          <Lbl t="Since your tinnitus is noise-type rather than tonal, the notch filter has been disabled. Broadband sound (white, pink, or brown noise) reduces the perceived loudness of your tinnitus through masking, lowers stress, and aids sleep — all clinically validated benefits." s={{lineHeight:1.9,fontSize:14}}/>
        </>}/>
      )}

      <Panel s={{padding:0,overflow:"hidden",marginBottom:14}} ch={
        <canvas ref={canRef} width={620} height={90} style={{width:"100%",height:90,display:"block"}}/>
      }/>

      {!noiseTypeOnly && (
        <Panel s={{marginBottom:14,borderColor:"#3b1a1a"}} ch={<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <Lbl t="🔴 TINNITUS FREQUENCY (NOTCH CENTER)"/>
            <div style={{textAlign:"right"}}>
              <Big t={hzFmt(dispF)} sz={22} c={K.red}/>
              <Lbl t={`1-octave notch: ${hzFmt(Math.round(dispF/Math.SQRT2))} – ${hzFmt(Math.round(dispF*Math.SQRT2))}`} s={{fontSize:12,marginTop:2}}/>
            </div>
          </div>
          <input type="range" min={0} max={SMAX} step={1}
            defaultValue={f2s(initF)} ref={slRef}
            onChange={onFreqSliderChange} className="sl-red"
            style={{width:"100%",marginBottom:6,background:K.dim}}
          />
          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:K.sub,fontFamily:"'Courier New',monospace",marginTop:5,marginBottom:10}}>
            {["500Hz","1kHz","2kHz","4kHz","8kHz","12kHz","16kHz","20kHz"].map(l=><span key={l}>{l}</span>)}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:5}}>
            {[{l:"−oct",c:-1200},{l:"−semi",c:-100},{l:"−10¢",c:-10},{l:"+10¢",c:10},{l:"+semi",c:100},{l:"+oct",c:1200}].map(({l,c})=>(
              <button key={l} onClick={()=>fineTune(c)}
                style={{padding:"8px 2px",background:"transparent",border:`1px solid ${K.border}`,borderRadius:5,color:K.muted,fontSize:13,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=K.red;e.currentTarget.style.color=K.red;}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=K.border;e.currentTarget.style.color=K.muted;}}>
                {l}
              </button>
            ))}
          </div>
        </>}/>
      )}

      <Panel s={{marginBottom:14}} ch={
        <div style={{display:"flex",alignItems:"center",gap:20}}>
          <button onClick={()=>playing?stop():startPlaying()} style={{width:74,height:74,borderRadius:"50%",flexShrink:0,fontSize:26,position:"relative",background:playing?"rgba(0,212,180,0.12)":"rgba(0,212,180,0.05)",border:`2px solid ${playing?K.teal:K.border}`,color:playing?K.teal:K.muted,animation:playing?"glow 2.5s ease-in-out infinite":"none",transition:"all 0.2s"}}>
            {playing?"⏹":"▶"}
            {playing&&<div style={{position:"absolute",inset:-9,borderRadius:"50%",border:`1px solid ${K.teal}`,animation:"ring 2s ease-out infinite",pointerEvents:"none"}}/>}
          </button>
          <div style={{flex:1}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
              <span style={{fontFamily:"system-ui",fontSize:28,fontWeight:700,color:playing?K.teal:K.muted,animation:playing?"pulse 3s ease-in-out infinite":"none"}}>
                {String(em).padStart(2,"0")}:{String(es).padStart(2,"0")}
              </span>
              <Lbl t={`/ ${sessMins} min · ${Math.round(prog)}%`}/>
            </div>
            <div style={{background:K.dim,borderRadius:3,height:4,marginBottom:12}}>
              <div style={{background:`linear-gradient(90deg,${K.teal},#00a896)`,width:`${prog}%`,height:"100%",borderRadius:3,transition:"width 1s linear"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <Lbl t="SESSION TARGET (clinical studies use 60–120 min)"/><Lbl t={`${sessMins} min`} c={K.amber}/>
            </div>
            <SldC val={sessMins} min={15} max={120} step={5} cls="sl-amber" color={K.amber} onCh={setSessMins}/>
            <div style={{marginTop:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <Lbl t="SLEEP TIMER (fade out &amp; stop)"/><Lbl t={sleepMins===0?"OFF":`${sleepMins} min`} c={sleepMins>0?K.teal:K.muted}/>
              </div>
              <div style={{display:"flex",gap:6}}>
                {[{l:"OFF",v:0},{l:"15m",v:15},{l:"30m",v:30},{l:"60m",v:60}].map(({l,v})=>(
                  <button key={v} onClick={()=>setSleepMins(v)} style={{flex:1,padding:"7px 4px",background:sleepMins===v?"rgba(0,212,180,0.1)":"transparent",border:`1px solid ${sleepMins===v?K.teal:K.border}`,borderRadius:5,color:sleepMins===v?K.teal:K.muted,fontSize:13,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {sleepEnded && !playing && (
              <div style={{marginTop:10,padding:"8px 12px",background:"rgba(0,212,180,0.07)",border:"1px solid rgba(0,212,180,0.3)",borderRadius:6,textAlign:"center",fontFamily:"'Courier New',monospace",fontSize:13,color:K.teal}}>
                ✓ SLEEP TIMER — SESSION ENDED · Tap ▶ to start a new session
              </div>
            )}
            {playing && prog >= 100 && (
              <div style={{marginTop:10,padding:"8px 12px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:6,textAlign:"center"}}>
                <Lbl t="✓ SESSION TARGET REACHED" c={K.teal} s={{fontSize:13,fontWeight:700,marginBottom:2}}/>
                <Lbl t="Great work! Keep going or stop to save your session." s={{fontSize:11,color:K.sub}}/>
              </div>
            )}
          </div>
        </div>
      }/>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="SOUND SOURCE" s={{marginBottom:10}}/>
        {slopeRec && (
          <div style={{padding:"7px 10px",background:"rgba(253,121,168,0.07)",border:"1px solid rgba(253,121,168,0.3)",borderRadius:7,marginBottom:10,fontFamily:"'Courier New',monospace",fontSize:12,lineHeight:1.7,color:"#fd79a8"}}>
            Your sloping audiogram → <strong>pink noise recommended</strong> (softer highs, easier on damaged hair cells)
          </div>
        )}
        {/* Music file upload — the evidence-based carrier (Okamoto 2010, Pantev 2012) */}
        {!noiseTypeOnly && (
          <div style={{marginBottom:12,padding:"12px 14px",background:nType==="music"?"rgba(255,211,42,0.06)":"transparent",border:`1px solid ${nType==="music"?"#ffd32a44":K.border}`,borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <span style={{fontSize:20}}>🎵</span>
              <div style={{flex:1}}>
                <Lbl t="NOTCHED MUSIC (STRONGEST EVIDENCE)" c={nType==="music"?"#ffd32a":K.muted} s={{fontSize:13,fontWeight:700}}/>
                <Lbl t="Upload your own music — attention to music strengthens lateral inhibition (Okamoto 2010)" s={{fontSize:12,lineHeight:1.6}}/>
              </div>
            </div>
            <input ref={musicInputRef} type="file" accept="audio/*" onChange={handleMusicFile}
              style={{display:"none"}}/>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={()=>musicInputRef.current?.click()}
                style={{padding:"8px 16px",background:"rgba(255,211,42,0.08)",border:"1px solid #ffd32a",borderRadius:6,color:"#ffd32a",fontFamily:"system-ui",fontWeight:600,fontSize:13,cursor:"pointer",transition:"all 0.15s"}}>
                {musicLoading ? "DECODING…" : musicName ? "CHANGE FILE" : "UPLOAD MUSIC FILE"}
              </button>
              {musicName && (
                <Lbl t={`✓ ${musicName}`} c="#ffd32a" s={{fontSize:12,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}/>
              )}
            </div>
            {!musicBuf && nType==="music" && (
              <Lbl t="↑ Upload a music file to use notched music therapy" c={K.amber} s={{marginTop:6,fontSize:12}}/>
            )}
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {NOISE_TYPES.filter(n => {
            if (noiseTypeOnly) return n.id!=="notched" && n.id!=="music";
            if (n.id==="music") return false; // shown above as special upload section
            return true;
          }).map(n=>(
            <button key={n.id} onClick={()=>setNType(n.id)} style={{padding:"12px",textAlign:"left",background:nType===n.id?"rgba(255,255,255,0.03)":"transparent",border:`1px solid ${nType===n.id?n.color:K.border}`,borderRadius:8,transition:"all 0.15s"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:n.color,flexShrink:0}}/>
                <Lbl t={n.label} c={nType===n.id?n.color:K.muted} s={{fontSize:14}}/>
                {n.rec&&!noiseTypeOnly&&<Lbl t="REC" s={{fontSize:8,color:K.teal,border:`1px solid ${K.teal}`,borderRadius:2,padding:"1px 4px"}}/>}
              </div>
              <Lbl t={n.desc} s={{fontSize:13,lineHeight:1.5}}/>
            </button>
          ))}
        </div>
      </>}/>

      {/* ── System-wide streaming notch (Pandora/Spotify/YouTube/etc.) ── */}
      {!noiseTypeOnly && (
        <Panel s={{marginBottom:14,borderColor:sysNotchEnabled?"#74b9ff66":K.dim}} ch={<>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
            <span style={{fontSize:22}}>📡</span>
            <div style={{flex:1}}>
              <Lbl t="STREAMING MODE — NOTCH YOUR MUSIC" c={sysNotchEnabled?"#74b9ff":K.text} s={{fontSize:14,fontWeight:700}}/>
              <Lbl t="Apply the therapeutic notch to Pandora, Spotify, YouTube, or any audio playing on your phone" s={{fontSize:12,lineHeight:1.6}}/>
            </div>
          </div>

          {sysNotchAvail ? (
            <>
              {/* ── Noise color / spectral tilt selector ── */}
              <div style={{marginBottom:10}}>
                <Lbl t="SPECTRAL TILT" s={{fontSize:11,marginBottom:5}}/>
                <div style={{display:"flex",gap:6}}>
                  {[
                    {id:"white",label:"WHITE",desc:"Flat — no tilt",color:"#dfe6e9"},
                    {id:"pink", label:"PINK", desc:"−3 dB/oct — gentler highs",color:"#fd79a8"},
                    {id:"brown",label:"BROWN",desc:"−6 dB/oct — warm bass focus",color:"#e17055"},
                  ].map(c=>(
                    <button key={c.id} onClick={()=>setStreamNoiseColor(c.id)}
                      style={{flex:1,padding:"8px 4px",
                        background:streamNoiseColor===c.id?`${c.color}18`:"transparent",
                        border:`1px solid ${streamNoiseColor===c.id?c.color:K.border}`,
                        borderRadius:6,cursor:"pointer",textAlign:"center",transition:"all 0.2s"}}>
                      <div style={{fontFamily:"system-ui",fontWeight:700,fontSize:12,
                        color:streamNoiseColor===c.id?c.color:K.muted,letterSpacing:"0.05em"}}>{c.label}</div>
                      <div style={{fontFamily:"'Courier New',monospace",fontSize:9,
                        color:streamNoiseColor===c.id?c.color:K.sub,marginTop:2,opacity:0.8}}>{c.desc}</div>
                    </button>
                  ))}
                </div>
                {streamNoiseColor !== "white" && (
                  <Lbl t={streamNoiseColor === "pink"
                    ? "Pink tilt reduces high-frequency energy — recommended for high-frequency hearing loss"
                    : "Brown tilt strongly emphasises bass — very warm, reduces treble stress"
                  } s={{fontSize:11,lineHeight:1.6,marginTop:5,color:streamNoiseColor==="pink"?"#fd79a8":"#e17055"}}/>
                )}
              </div>

              <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
                <button onClick={toggleSysNotch}
                  style={{flex:"none",padding:"10px 22px",
                    background:sysNotchEnabled?"rgba(116,185,255,0.12)":"rgba(0,212,180,0.06)",
                    border:`1px solid ${sysNotchEnabled?"#74b9ff":K.teal}`,
                    borderRadius:8,color:sysNotchEnabled?"#74b9ff":K.teal,
                    fontFamily:"system-ui",fontWeight:700,fontSize:14,cursor:"pointer",
                    transition:"all 0.2s",
                    animation:sysNotchEnabled?"glow 2.5s ease-in-out infinite":"none"}}>
                  {sysNotchEnabled ? "■ STREAMING NOTCH ON" : "▶ ENABLE STREAMING NOTCH"}
                </button>
                {sysNotchEnabled && (
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:"#74b9ff",animation:"pulse 1.5s infinite"}}/>
                    <Lbl t={`Filtering all audio at ${hzFmt(dispF)}`} c="#74b9ff" s={{fontSize:12}}/>
                  </div>
                )}
              </div>
              {sysNotchEnabled && (()=>{
                const sem = Math.floor(streamElapsed/60), ses = streamElapsed%60;
                const sprog = Math.min((streamElapsed/(streamSessMins*60))*100, 100);
                return (<>
                  <Panel s={{padding:0,overflow:"hidden",marginTop:10,marginBottom:4,borderColor:"#74b9ff33"}} ch={
                    <canvas ref={streamCanRef} width={620} height={110} style={{width:"100%",height:110,display:"block"}}/>
                  }/>

                  {/* ── Streaming session timer ── */}
                  <div style={{marginTop:8,padding:"10px 12px",background:"rgba(116,185,255,0.04)",border:"1px solid rgba(116,185,255,0.15)",borderRadius:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
                      <span style={{fontFamily:"system-ui",fontSize:24,fontWeight:700,color:"#74b9ff",animation:"pulse 3s ease-in-out infinite"}}>
                        {String(sem).padStart(2,"0")}:{String(ses).padStart(2,"0")}
                      </span>
                      <Lbl t={`/ ${streamSessMins} min · ${Math.round(sprog)}%`} c="#74b9ff" s={{fontSize:12}}/>
                    </div>
                    <div style={{background:K.dim,borderRadius:3,height:4,marginBottom:8}}>
                      <div style={{background:"linear-gradient(90deg,#74b9ff,#0984e3)",width:`${sprog}%`,height:"100%",borderRadius:3,transition:"width 1s linear"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <Lbl t="STREAMING SESSION TARGET" s={{fontSize:11}}/>
                      <Lbl t={`${streamSessMins} min`} c="#74b9ff" s={{fontSize:12}}/>
                    </div>
                    <SldC val={streamSessMins} min={15} max={120} step={5} cls="sl-blue" color="#74b9ff" onCh={setStreamSessMins}/>

                    {/* Streaming sleep timer */}
                    <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${K.dim}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <Lbl t="SLEEP TIMER (auto-stop)" s={{fontSize:11}}/>
                        <Lbl t={streamSleepMins===0?"OFF":`${streamSleepMins} min`} c={streamSleepMins>0?"#74b9ff":K.muted} s={{fontSize:11}}/>
                      </div>
                      <div style={{display:"flex",gap:5}}>
                        {[{l:"OFF",v:0},{l:"30m",v:30},{l:"60m",v:60},{l:"90m",v:90},{l:"120m",v:120}].map(({l,v})=>(
                          <button key={v} onClick={()=>setStreamSleepMins(v)} style={{flex:1,padding:"5px 2px",background:streamSleepMins===v?"rgba(116,185,255,0.1)":"transparent",border:`1px solid ${streamSleepMins===v?"#74b9ff":K.border}`,borderRadius:4,color:streamSleepMins===v?"#74b9ff":K.muted,fontSize:11,fontFamily:"'Courier New',monospace",transition:"all 0.15s"}}>
                            {l}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Lbl t="Sessions > 30 s are tracked automatically. Stop the notch to save." s={{fontSize:11,color:K.sub,marginTop:6}}/>
                  </div>

                  {/* Session target reached notification */}
                  {streamTargetHit && (
                    <div style={{marginTop:8,padding:"8px 12px",background:"rgba(0,212,180,0.08)",border:`1px solid ${K.teal}`,borderRadius:6,textAlign:"center"}}>
                      <Lbl t="✓ SESSION TARGET REACHED" c={K.teal} s={{fontSize:13,fontWeight:700,marginBottom:2}}/>
                      <Lbl t="Great work! You can continue or stop the session to save." s={{fontSize:11,color:K.sub}}/>
                    </div>
                  )}

                  <Lbl t={`1-octave notch: ${hzFmt(Math.round(dispF/Math.SQRT2))} – ${hzFmt(Math.round(dispF*Math.SQRT2))} · –${nDepth} dB · ${streamNoiseColor === "pink" ? "pink (−3 dB/oct)" : streamNoiseColor === "brown" ? "brown (−6 dB/oct)" : "flat"} tilt`} s={{fontSize:12,lineHeight:1.7,color:K.sub,marginTop:6}}/>
                </>);
              })()}
              {!sysNotchEnabled && !streamSleepEnded && (
                <Lbl t="HOW IT WORKS: Attaches a system-wide audio effect to your device's output. All audio from any app passes through the therapeutic notch filter. No recording, no DRM issues — it's an inline effect like a system equalizer. Works with any music streaming app." s={{fontSize:12,lineHeight:1.7}}/>
              )}
              {streamSleepEnded && !sysNotchEnabled && (
                <div style={{marginTop:8,padding:"8px 12px",background:"rgba(116,185,255,0.07)",border:"1px solid rgba(116,185,255,0.3)",borderRadius:6,textAlign:"center",fontFamily:"'Courier New',monospace",fontSize:13,color:"#74b9ff"}}>
                  ✓ SLEEP TIMER — STREAMING SESSION ENDED · Tap ▶ to start a new session
                </div>
              )}
              {sysNotchError && (
                <div style={{marginTop:8,padding:"6px 10px",background:"rgba(255,71,87,0.08)",border:"1px solid rgba(255,71,87,0.3)",borderRadius:6}}>
                  <Lbl t={`⚠ ${sysNotchError}`} c={K.red} s={{fontSize:12}}/>
                  <Lbl t="Some devices restrict system-wide audio effects. Use the in-app music upload as an alternative." s={{fontSize:11,color:K.sub,marginTop:4}}/>
                </div>
              )}
            </>
          ) : (
            <div style={{padding:"8px 12px",background:K.dim,borderRadius:6}}>
              <Lbl t="System-wide audio effects require Android 9+ running natively. Use the music file upload above to apply the notch to your own music files instead." s={{fontSize:12,lineHeight:1.7}}/>
            </div>
          )}
        </>}/>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <Panel ch={<>
          <Lbl t="VOLUME" s={{marginBottom:6}}/>
          <Big t={`${vol} dB`} sz={26} c="#a29bfe" s={{marginBottom:10}}/>
          <SldC val={vol} min={5} max={80} step={1} cls="sl-purple" color="#a29bfe" onCh={setVol}/>
          {vol > 72 && (
            <div style={{marginTop:6,padding:"6px 8px",background:"rgba(255,71,87,0.08)",border:"1px solid rgba(255,71,87,0.3)",borderRadius:5}}>
              <Lbl t="⚠ HIGH VOLUME — risk of over-masking. You should still hear your tinnitus faintly. Over-masking prevents habituation, the core therapeutic mechanism." s={{fontSize:11,lineHeight:1.6,color:K.red}}/>
            </div>
          )}
          <Lbl t="▸ Set BELOW tinnitus loudness — do not mask it. Masking prevents habituation. You should still be able to hear your tinnitus faintly beneath the noise." s={{marginTop:8,lineHeight:1.8,fontSize:13,color:K.amber}}/>
        </>}/>
        {!noiseTypeOnly && (
          <Panel ch={<>
            <Lbl t="NOTCH DEPTH" s={{marginBottom:6}}/>
            <Big t={<>–{nDepth} <span style={{fontSize:14}}>dB</span></>} sz={26} c="#4ade80" s={{marginBottom:10}}/>
            <SldC val={nDepth} min={10} max={40} step={5} cls="sl-teal" color="#4ade80" onCh={setNDepth}/>
            <Lbl t="1-octave width per Okamoto et al. (2010 PNAS). Published studies used 12–20 dB depth." s={{marginTop:8,lineHeight:1.8,fontSize:13}}/>
            {nDepth > 30 && (
              <Lbl t="⚠ Deep notch (>30 dB) can cause audible ringing artifacts. Published TMNMT studies used 12–20 dB." s={{marginTop:4,fontSize:12,lineHeight:1.6,color:K.amber}}/>
            )}
            <Lbl t={`Notch: ${hzFmt(Math.round(dispF/Math.SQRT2))} – ${hzFmt(Math.round(dispF*Math.SQRT2))}`} c={K.teal} s={{fontSize:12,marginTop:4}}/>
          </>}/>
        )}
      </div>

      {hearingResults&&(
        <Panel s={{marginBottom:14,borderColor:K.dim}} ch={<>
          <Lbl t="YOUR HEARING PROFILE" s={{marginBottom:10}}/>
          <div style={{display:"flex",gap:8}}>
            {["left","right"].map(ear=>{
              const rfH=resFreqs(hearingResults), avg=rfH.reduce((s,f)=>s+(hearingResults[`${ear}_${f}`]||0),0)/rfH.length;
              const ct=catFor(avg);
              return (
                <div key={ear} style={{flex:1,background:K.dim,borderRadius:8,padding:"10px 12px"}}>
                  <Lbl t={ear==="left"?"◄ LEFT":"RIGHT ►"} s={{fontSize:12,marginBottom:4}}/>
                  <Big t={<>{Math.round(avg)}<span style={{fontSize:13}}> dBHL</span></>} sz={18} c={ct.color}/>
                  <Lbl t={ct.label} c={ct.color} s={{fontSize:12}}/>
                </div>
              );
            })}
          </div>
          {thrAtF && (
            <div style={{marginTop:10,padding:"8px 10px",background:K.bg,borderRadius:7,fontFamily:"'Courier New',monospace",fontSize:12,lineHeight:1.8}}>
              <span style={{color:K.sub}}>Threshold at tinnitus freq ({hzFmt(thrAtF.freq)}): </span>
              <span style={{color:thrAtF.cat.color}}>{Math.round(thrAtF.L)}L / {Math.round(thrAtF.R)}R dBHL</span>
              <br/>
              <span style={{color:K.sub}}>Starting volume set to threshold + 5 dB — raise if noise is inaudible, keep below tinnitus loudness.</span>
            </div>
          )}
        </>}/>
      )}

      <Panel s={{marginBottom:14,borderColor:K.dim}} ch={<>
        <Lbl t={noiseTypeOnly ? "📖 ABOUT BROADBAND MASKING" : "📖 ABOUT NOTCHED NOISE THERAPY"} s={{marginBottom:8}}/>
        {noiseTypeOnly ? (
          <Lbl t="Broadband noise reduces the perceived signal-to-noise ratio of your tinnitus, providing relief without requiring a frequency match. It also reduces stress and helps with sleep. Unlike masking, setting the volume below tinnitus level allows the brain to habituate over time." s={{lineHeight:1.9,fontSize:13}}/>
        ) : (
          <Lbl t={<>
            By removing sound energy at <span style={{color:K.red}}>{hzFmt(dispF)}</span>, lateral inhibition is triggered in adjacent auditory neurons, gradually suppressing the hyperactive cells causing your tinnitus (TMNMT — tailor-made notched noise therapy).<br/><br/>
            ▸ Evidence: A 2025 meta-analysis of 14 RCTs found significant improvement at 3 months (–8.6 THI points) and 6 months (–24.6 THI points) — effects strengthen with time<br/>
            ▸ Works best for tonal (not noise-type) tinnitus<br/>
            ▸ Not all studies show benefit vs. unnotched sound — some people respond, others don't<br/>
            ▸ Recommended: 60–120 min daily for 3–6+ months
          </>} s={{lineHeight:1.9,fontSize:13}}/>
        )}
      </>}/>

      {/* ── Cumulative Session Tracking with daily/weekly progress ── */}
      {(()=>{
        const today = new Date().toISOString().slice(0,10);
        const todaySessions = sessions.filter(s=>s.date.slice(0,10)===today);
        const todayMins = Math.round(todaySessions.reduce((a,s)=>a+(s.duration||0),0)/60);
        const dailyGoal = 60; // 60 min/day evidence-based minimum
        const todayPct = Math.min((todayMins/dailyGoal)*100,100);

        // Last 7 days
        const weekDays = Array.from({length:7},(_,i)=>{
          const d = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
          const daySess = sessions.filter(s=>s.date.slice(0,10)===d);
          const mins = Math.round(daySess.reduce((a,s)=>a+(s.duration||0),0)/60);
          return {date:d, mins, dayLabel:new Date(d).toLocaleDateString(undefined,{weekday:"short"})};
        }).reverse();
        const weekMins = weekDays.reduce((a,d)=>a+d.mins,0);
        const weekTarget = dailyGoal*7;
        const maxDay = Math.max(...weekDays.map(d=>d.mins), dailyGoal);

        return (
          <Panel s={{marginBottom:14,borderColor:todayPct>=100?K.teal+"66":K.dim}} ch={<>
            <Lbl t="📊 DAILY PROGRESS & SESSION TRACKING" s={{marginBottom:12}}/>

            {/* Today's progress */}
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:14}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <Lbl t="TODAY" c={K.text} s={{fontSize:13}}/>
                  <Lbl t={`${todayMins} / ${dailyGoal} min`} c={todayPct>=100?K.teal:K.amber} s={{fontSize:13}}/>
                </div>
                <div style={{background:K.dim,borderRadius:3,height:8,overflow:"hidden"}}>
                  <div style={{background:todayPct>=100?`linear-gradient(90deg,${K.teal},#00a896)`:`linear-gradient(90deg,${K.amber},#ffa502)`,width:`${todayPct}%`,height:"100%",borderRadius:3,transition:"width 0.5s"}}/>
                </div>
                <Lbl t={todayPct>=100?"✓ Daily target reached!":"Evidence-based target: 60–120 min/day"} c={todayPct>=100?K.teal:K.sub} s={{fontSize:11,marginTop:4}}/>
              </div>
            </div>

            {/* 7-day bar chart */}
            <Lbl t="LAST 7 DAYS" s={{marginBottom:8,fontSize:12}}/>
            <div style={{display:"flex",gap:4,alignItems:"flex-end",height:60,marginBottom:4}}>
              {weekDays.map((d,i)=>{
                const h = maxDay>0 ? Math.max(3, (d.mins/maxDay)*54) : 3;
                const metGoal = d.mins >= dailyGoal;
                const isToday = d.date === today;
                return (
                  <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}} title={`${d.date}: ${d.mins} min`}>
                    <Lbl t={d.mins>0?`${d.mins}`:""} s={{fontSize:8,color:metGoal?K.teal:K.muted}}/>
                    <div style={{width:"100%",height:h,background:metGoal?K.teal:d.mins>0?K.amber+"88":K.dim,borderRadius:2,border:isToday?`1px solid ${K.text}`:"none",transition:"height 0.3s"}}/>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:4,marginBottom:10}}>
              {weekDays.map((d,i)=>(
                <Lbl key={i} t={d.dayLabel} s={{flex:1,textAlign:"center",fontSize:8,color:d.date===today?K.text:K.sub}}/>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderTop:`1px solid ${K.dim}`}}>
              <Lbl t={`Week: ${weekMins} / ${weekTarget} min`} s={{fontSize:12}}/>
              <Lbl t={`${sessions.length} total sessions · ${totalHours}h all-time · ${streak}d streak`} s={{fontSize:12}}/>
            </div>
            <Lbl t="Sessions > 30 s are saved automatically." s={{marginTop:6,lineHeight:1.8,fontSize:12}}/>
          </>}/>
        );
      })()}

      <Panel s={{borderColor:"#1a1a3e",cursor:"pointer"}} ch={<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}} onClick={()=>setShowBimodal(b=>!b)}>
          <Lbl t="🧪 NOT GETTING RESULTS? CLINICAL OPTIONS EXIST" c="#a29bfe" s={{fontSize:14}}/>
          <Lbl t={showBimodal?"▲ HIDE":"▼ SHOW"} c="#a29bfe" s={{fontSize:12}}/>
        </div>
        {showBimodal && (
          <div style={{marginTop:12}}>
            <Lbl t="The most promising clinical treatment (2024) is bimodal neuromodulation — combining sound with mild electrical tongue stimulation. The FDA-approved Lenire device achieved a 91.5% responder rate in a 220-patient real-world study, significantly outperforming sound-only therapy. The tongue stimulation activates the trigeminal nerve, driving spike-timing-dependent plasticity in the auditory brainstem that resets the maladaptive synchrony causing tinnitus. Used 60 min/day for 6–12 weeks. Requires a clinical fitting — search for Lenire providers or contact an audiologist who offers tinnitus neuromodulation." s={{lineHeight:1.9,fontSize:13}}/>
          </div>
        )}
      </>}/>
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  componentDidCatch(error, info) {
    this.setState({ error, info });
    console.error("[TinnitusSuite] Render error:", error);
    console.error("[TinnitusSuite] Component stack:", info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{background:"#0f0508",border:"1px solid #ff4757",borderRadius:12,padding:24,margin:20,fontFamily:"'Courier New',monospace"}}>
          <div style={{color:"#ff4757",fontSize:13,letterSpacing:"0.12em",marginBottom:12}}>⛔ RENDER ERROR CAUGHT</div>
          <div style={{color:"#ff9f9f",fontSize:12,marginBottom:16,lineHeight:1.7}}>{String(this.state.error)}</div>
          <div style={{color:"#664444",fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",maxHeight:240,overflow:"auto"}}>
            {this.state.info?.componentStack}
          </div>
          <button onClick={()=>this.setState({error:null,info:null})}
            style={{marginTop:16,padding:"8px 20px",background:"rgba(255,71,87,0.12)",border:"1px solid #ff4757",borderRadius:6,color:"#ff4757",cursor:"pointer",fontFamily:"'Courier New',monospace",fontSize:14}}>
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


// ─── Nav Bar ─────────────────────────────────────────────────────────────────
function NavBar({phase, currentUser, onBack, onRestart, onHistory, onSwitchUser}) {
  const canBack     = !["accounts","disclaimer","intro"].includes(phase);
  const showRestart = !["accounts","disclaimer","calibration","intro","history"].includes(phase);
  const showHistory = currentUser && !["accounts","disclaimer","history"].includes(phase);
  const showUser    = currentUser && phase !== "accounts";
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,gap:8}}>
      <button onClick={onBack} style={{
        display:"flex",alignItems:"center",gap:6,
        padding:"7px 14px",background:"transparent",
        border:`1px solid ${canBack?K.border:"transparent"}`,
        borderRadius:6,color:canBack?K.muted:"transparent",
        fontFamily:"'Courier New',monospace",fontSize:14,
        cursor:canBack?"pointer":"default",transition:"all 0.15s",
        pointerEvents:canBack?"auto":"none",flexShrink:0,
      }}
        onMouseEnter={e=>canBack&&(e.currentTarget.style.borderColor=K.teal,e.currentTarget.style.color=K.teal)}
        onMouseLeave={e=>canBack&&(e.currentTarget.style.borderColor=K.border,e.currentTarget.style.color=K.muted)}
      >
        ← BACK
      </button>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {showHistory && (
          <button onClick={onHistory} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${K.border}`,borderRadius:6,color:K.muted,fontFamily:"'Courier New',monospace",fontSize:13,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>(e.currentTarget.style.borderColor=K.teal,e.currentTarget.style.color=K.teal)}
            onMouseLeave={e=>(e.currentTarget.style.borderColor=K.border,e.currentTarget.style.color=K.muted)}
          >
            📊 HISTORY
          </button>
        )}
        {showRestart && (
          <button onClick={onRestart} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${K.border}`,borderRadius:6,color:K.muted,fontFamily:"'Courier New',monospace",fontSize:13,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>(e.currentTarget.style.borderColor="#ff4757",e.currentTarget.style.color="#ff4757")}
            onMouseLeave={e=>(e.currentTarget.style.borderColor=K.border,e.currentTarget.style.color=K.muted)}
          >
            ↺ RE-TEST
          </button>
        )}
        {showUser && (
          <button onClick={onSwitchUser} title="Switch user" style={{display:"flex",alignItems:"center",gap:7,padding:"5px 10px 5px 6px",background:"transparent",border:`1px solid ${currentUser.color}66`,borderRadius:20,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>(e.currentTarget.style.borderColor=currentUser.color)}
            onMouseLeave={e=>(e.currentTarget.style.borderColor=currentUser.color+"66")}
          >
            <div style={{width:26,height:26,borderRadius:13,background:currentUser.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#111"}}>
              {currentUser.name[0].toUpperCase()}
            </div>
            <span style={{fontFamily:"'Courier New',monospace",fontSize:12,color:K.text,letterSpacing:"0.04em"}}>{currentUser.name.toUpperCase()}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [phase,       setPhase]       = useState("accounts");
  const [hRes,        setHRes]        = useState(null);
  const [tFreq,       setTFreq]       = useState(9400);
  const [tVol,        setTVol]        = useState(55);
  const [tEar,        setTEar]        = useState("both");
  const [noiseOnly,   setNoiseOnly]   = useState(false);
  const [prevPhase,   setPrevPhase]   = useState("intro");

  const uid = currentUser?.id;

  const selectUser = (user, intent) => {
    setCurrentUser(user);
    const savedHRes  = uGetJ(user.id,"audiogram_latest",null);
    const savedTFreq = parseInt(uGet(user.id,"freq")||"0",10)||9400;
    setHRes(savedHRes); setTFreq(savedTFreq);
    if (intent === "therapy" && savedHRes && savedTFreq) { setPhase("therapy"); return; }
    if (uGet(user.id,"disclaimer") !== "1") { setPhase("disclaimer"); return; }
    setPhase("intro");
  };

  const goFromIntro = () => {
    const calDone = uid && uGet(uid,"cal_date") === new Date().toISOString().slice(0,10);
    setPhase(calDone ? "tintype" : "calibration");
  };

  const goTherapy = (f, noiseType=false) => {
    setTFreq(f); setNoiseOnly(noiseType); setPhase("therapy");
  };

  const restart = () => {
    setPhase("intro"); setHRes(null); setTFreq(9400); setTVol(55); setTEar("both"); setNoiseOnly(false);
    if (uid) { uDel(uid,"audiogram_latest"); uDel(uid,"freq"); }
  };

  const back = () => {
    if (phase === "history") { setPhase(prevPhase); return; }
    const prev = {
      calibration: "intro",
      tintype:     "intro",
      test:        "tintype",
      testresults: "test",
      tone:        hRes ? "testresults" : "tintype",
      octavecheck: "tone",
      therapy:     noiseOnly ? "tintype" : "octavecheck",
    };
    if (prev[phase]) setPhase(prev[phase]);
  };

  const goHistory = () => { setPrevPhase(phase); setPhase("history"); };

  return (
    <div style={{minHeight:"100vh",background:K.bg,color:K.text,padding:"24px 16px max(60px,env(safe-area-inset-bottom,60px))"}}>
      <style>{CSS}</style>
      <div style={{maxWidth:700,margin:"0 auto"}}>
        <NavBar phase={phase} currentUser={currentUser} onBack={back} onRestart={restart} onHistory={goHistory} onSwitchUser={()=>setPhase("accounts")}/>
        <ErrorBoundary>
          {phase!=="accounts"&&phase!=="intro"&&phase!=="tintype"&&phase!=="disclaimer"&&phase!=="calibration"&&phase!=="history"&&<StepBar phase={phase}/>}

          {phase==="accounts"   && <AccountScreen onSelect={selectUser}/>}

          {phase==="history"    && currentUser && <HistoryScreen user={currentUser}/>}

          {phase==="disclaimer" && <Disclaimer onAccept={()=>{ if(uid)uSet(uid,"disclaimer","1"); setPhase("intro"); }}/>}

          {phase==="calibration"&& <Calibration onConfirm={()=>{ if(uid)uSet(uid,"cal_date",new Date().toISOString().slice(0,10)); setPhase("tintype"); }} onSkip={()=>{ if(uid)uSet(uid,"cal_skipped","1"); setPhase("tintype"); }}/>}

          {phase==="intro"      && <Intro
              savedData={hRes ? {freq: tFreq} : null}
              onResume={()=>setPhase("tone")}
              onStart={goFromIntro}
              onSkip={goFromIntro}/>}

          {phase==="tintype"    && <TinnitusTypeScreen
              onTonal={()=>setPhase("test")}
              onNoise={()=>goTherapy(9400, true)}
              onUnsure={()=>setPhase("test")}/>}

          {phase==="test"       && <HearingTest
              calibrated={uid ? uGet(uid,"cal_date") && !uGet(uid,"cal_skipped") : false}
              onComplete={(r, mode, wasCal, falsePosCount, catchCount)=>{
                setHRes(r);
                if (uid) {
                  uSet(uid,"audiogram_latest",JSON.stringify(r));
                  const hist = uGetJ(uid,"audiograms",[]);
                  const entry = {
                    date: new Date().toISOString(),
                    results: r,
                    mode: mode || "standard",
                    calibrated: !!wasCal,
                    falsePositives: falsePosCount || 0,
                    catchTrials: catchCount || 0,
                  };
                  hist.push(entry);
                  if (hist.length>50) hist.splice(0,hist.length-50);
                  uSetJ(uid,"audiograms",hist);
                  // Clear skipped-cal flag for next session
                  try { localStorage.removeItem(`ts_${uid}_cal_skipped`); } catch(_) {}
                }
                setPhase("testresults");
              }}
              onSkip={()=>setPhase("tone")}/>}

          {phase==="testresults"&& <TestResults
              results={hRes}
              onContinue={()=>setPhase("tone")}/>}

          {phase==="tone"       && <ToneFinder
              hearingResults={hRes}
              userId={uid}
              onComplete={(f, vol, ear) => {
                setTFreq(f); setTVol(vol||55); setTEar(ear||"both");
                if (uid) {
                  uSet(uid,"freq",String(f));
                  const hist = uGetJ(uid,"tones",[]);
                  hist.push({date:new Date().toISOString(), freq:f, vol:vol||55, ear:ear||"both"});
                  if (hist.length>100) hist.splice(0,hist.length-100);
                  uSetJ(uid,"tones",hist);
                }
                setPhase("octavecheck");
              }}/>}

          {phase==="octavecheck"&& <OctaveCheck
              freq={tFreq}
              vol={tVol}
              earRoute={tEar}
              onConfirm={f=>goTherapy(f, false)}
              onOctaveUp={f=>goTherapy(f, false)}
              onOctaveDown={f=>goTherapy(f, false)}/>}

          {phase==="therapy"    && <NoiseTherapy
              tinnitusFreq={tFreq}
              hearingResults={hRes}
              noiseTypeOnly={noiseOnly}
              userId={uid}/>}
        </ErrorBoundary>
      </div>
    </div>
  );
}

