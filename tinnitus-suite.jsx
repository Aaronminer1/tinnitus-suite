import { useState, useRef, useEffect, useCallback, Component } from "react";

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
  {id:"notched",label:"Notched White",desc:"Therapeutic — silence at tinnitus frequency",color:"#00d4b4",rec:true},
  {id:"white",  label:"White Noise",  desc:"Equal energy across all frequencies",       color:"#e2e8f0",rec:false},
  {id:"pink",   label:"Pink Noise",   desc:"Softer highs, sounds more natural",         color:"#fd79a8",rec:false},
  {id:"brown",  label:"Brown Noise",  desc:"Deep rumble, like rain on a rooftop",       color:"#e17055",rec:false},
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
          onClick={()=>{
            try { sessionStorage.setItem("tinnitus_disclaimer_accepted","1"); } catch(_){}
            onAccept();
          }}
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
    try { localStorage.setItem("tinnitus_cal_date", new Date().toISOString().slice(0,10)); } catch(_){}
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
function HearingTest({onComplete, onSkip}) {
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
    // Old formula (db-85)/20*0.6 clipped at ~89 dBHL — produced distortion harmonics
    // heard as spurious low-pitch buzz during high-level threshold searches.
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(dBtoG(db), ctx.currentTime + 0.08);
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g);
    if (ear !== "both" && ctx.destination.channelCount >= 2) {
      // Route to one ear — same approach as ToneFinder (no splitter needed)
      const mg = ctx.createChannelMerger(2);
      g.connect(mg, 0, ear === "left" ? 0 : 1);
      mg.connect(ctx.destination);
    } else { g.connect(ctx.destination); }
    o.start(); osc.current = o; gn.current = g;
  };

  const advance = (res) => {
    if (freqIdx < freqs.length-1) {
      setFreqIdx(freqIdx+1); setDB(60); setHwPhase("descend"); setStep("ready"); setLastAns(null);
    } else if (earIdx === 0) {
      setEarDone(true);
    } else {
      onComplete(res);
    }
  };

  const answer = (heard) => {
    if (step !== "respond" && step !== "playing") return;
    clearTimeout(tmr.current); stopTone(); setLastAns(heard);
    const key = `${EARS[earIdx]}_${freqs[freqIdx]}`;
    if (heard) {
      if (hwPhase === "ascend") {
        // Heard while ascending — this level is the threshold
        const r = {...results, [key]: dB};
        setResults(r); setTimeout(() => advance(r), 400);
      } else {
        // Still descending — step down 10 dB
        const next = Math.max(0, dB - 10);
        setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
      }
    } else {
      // Not heard — switch to ascending phase and step up 5 dB
      if (hwPhase === "descend") setHwPhase("ascend");
      const next = dB + 5;
      if (next > 110) {
        const r = {...results, [key]: 110};
        setResults(r); setTimeout(() => advance(r), 400);
      } else {
        setDB(next); setTimeout(() => { setStep("ready"); setLastAns(null); }, 400);
      }
    }
  };

  const runTrial = () => {
    setStep("countdown"); setLastAns(null);
    let c = 3; setCdCount(c);
    const tick = setInterval(() => {
      c--;
      if (c <= 0) {
        clearInterval(tick); setCdCount(null); setStep("playing");
        tmr.current = setTimeout(() => {
          playTone(freqs[freqIdx], dB, EARS[earIdx]);
          tmr.current = setTimeout(() => { stopTone(); setStep("respond"); }, 1800);
        }, 400 + Math.random()*1200);
      } else { setCdCount(c); }
    }, 1000);
  };

  const switchEar = () => {
    setEarDone(false); setEarIdx(1); setFreqIdx(0); setDB(60); setHwPhase("descend"); setStep("ready"); setLastAns(null);
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
        {TEST_MODES.map(m=>(
          <div key={m.id} onClick={()=>setTestMode(m.id)}
            style={{background:K.card,border:`1px solid ${K.border}`,borderRadius:14,padding:20,marginBottom:10,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor=K.teal}
            onMouseLeave={e=>e.currentTarget.style.borderColor=K.border}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <Big t={m.label} sz={20} c={K.teal}/>
              <Lbl t={m.est} c={K.amber} sz={13}/>
            </div>
            <Lbl t={m.desc} s={{lineHeight:1.8}}/>
          </div>
        ))}
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
            <Lbl t="Starting at 60 dBHL and descending 10 dB each time you hear it. When you first miss, it rises in 5 dB steps — that converging level is your threshold. This Hughson-Westlake method matches clinical ISO 8253-1 audiometry. Each ear is tested independently." s={{lineHeight:1.9,fontSize:13}}/>
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
        <Panel s={{marginBottom:20,borderColor:K.amber+"44"}} ch={<>
          <Lbl t="⚠ NOTABLE FINDING" c={K.amber} s={{marginBottom:8}}/>
          <Lbl t={<>Your highest threshold was at <span style={{color:K.text}}>{hzFmt(worstF)}</span> ({Math.round(worstV)} dBHL — {catFor(worstV).label}). High-frequency loss frequently co-occurs with tinnitus. The tone finder will start here.</>} s={{lineHeight:1.9,fontSize:14}}/>
        </>}/>
      )}

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

// ─── Tone Finder ──────────────────────────────────────────────────────────────
function ToneFinder({hearingResults, onComplete}) {
  const {f2s, s2f, SMAX} = logSlider(200, 20000);

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
function NoiseTherapy({tinnitusFreq:initF, hearingResults, noiseTypeOnly}) {
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

  // ERB-scaled notch width — auto-calculated, no user guess needed
  const [nDepth,   setNDepth]   = useState(30);
  const [sleepMins, setSleepMins] = useState(0); // 0 = off; auto-fade timer
  const [sleepEnded, setSleepEnded] = useState(false); // true after sleep timer fires
  const [sessions, setSessions] = useState(() => {  // persistent session history
    try { return JSON.parse(localStorage.getItem("tinnitus_sessions") || "[]"); } catch(_) { return []; }
  });

  const tfRef   = useRef(initF);
  const playRef = useRef(false); playRef.current = playing;
  const ntRef   = useRef(noiseTypeOnly ? "white" : "notched"); ntRef.current = nType;
  const volRef  = useRef(initVol); volRef.current = vol;
  const ndRef   = useRef(30); ndRef.current = nDepth;

  const slRef    = useRef(null);
  const canRef   = useRef(null);
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
    const buf = getBuffer(type); // use cached buffer — no regeneration on param change
    const src = ctx.createBufferSource(); src.buffer=buf; src.loop=true;
    const gain = ctx.createGain(); gain.gain.value = dBtoG(vl);
    const an = ctx.createAnalyser(); an.fftSize=2048; analyR.current=an;
    if (!noiseTypeOnly) {
      // 3-stage ERB-scaled notch cascade for therapeutic TMNMT shaping:
      //   Stage 1 — deep tight notch at exact tinnitus frequency
      //   Stage 2 — wider shallower notch (broadens the notch skirts)
      //   Stage 3 — slight low-side notch (compensates for biquad asymmetry above 8kHz)
      const ow = erbOct(tf) * 1.5;         // 1.5× ERB in octaves
      const ho = ow * 0.5;
      const lf = tf / Math.pow(2, ho);
      const hf = tf * Math.pow(2, ho);
      const Q  = tf / (hf - lf);
      const n1 = ctx.createBiquadFilter(); n1.type="notch"; n1.frequency.value=tf;       n1.Q.value=Q;      n1.gain.value=-nd;
      const n2 = ctx.createBiquadFilter(); n2.type="notch"; n2.frequency.value=tf;       n2.Q.value=Q*0.65; n2.gain.value=-nd*0.5;
      const n3 = ctx.createBiquadFilter(); n3.type="notch"; n3.frequency.value=tf*0.955; n3.Q.value=Q*1.4;  n3.gain.value=-nd*0.3;
      src.connect(n1); n1.connect(n2); n2.connect(n3); n3.connect(gain);
    } else { src.connect(gain); }
    gain.connect(an); an.connect(ctx.destination);
    src.start(); srcR.current=src; gainR.current=gain;
  };

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
      if (!noiseTypeOnly) {
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
    // Save session to localStorage if it ran for > 30 s
    const dur = elapsedRef.current;
    if (dur > 30) {
      try {
        const saved = JSON.parse(localStorage.getItem("tinnitus_sessions") || "[]");
        saved.push({ date: new Date().toISOString(), duration: dur, frequency: tfRef.current });
        if (saved.length > 200) saved.splice(0, saved.length - 200);
        localStorage.setItem("tinnitus_sessions", JSON.stringify(saved));
        setSessions([...saved]);
      } catch(_) {}
    }
    setPlaying(false);
  };

  const startPlaying = (tf) => {
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
    stopAudio(); clearInterval(timerR.current); cancelAnimationFrame(animR.current);
    buildGraph(ntRef.current,volRef.current,ndRef.current,tf||tfRef.current);
    timerR.current = setInterval(()=>setElapsed(e=>e+1),1000);
    drawCanvas();
  };

  useEffect(()=>{
    if(gainR.current&&ac.current)
      gainR.current.gain.setTargetAtTime(dBtoG(vol),ac.current.currentTime,0.05);
  },[vol]);

  useEffect(()=>{ restart(); },[nType,nDepth]);

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
  const erbWidth = erbOct(dispF) * 1.5;

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
              <Lbl t={`ERB notch: ±${Math.round(erbHz(dispF)/2)} Hz (${erbWidth.toFixed(2)} oct)`} s={{fontSize:12,marginTop:2}}/>
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
          </div>
        </div>
      }/>

      <Panel s={{marginBottom:14}} ch={<>
        <Lbl t="NOISE TYPE" s={{marginBottom:10}}/>
        {slopeRec && (
          <div style={{padding:"7px 10px",background:"rgba(253,121,168,0.07)",border:"1px solid rgba(253,121,168,0.3)",borderRadius:7,marginBottom:10,fontFamily:"'Courier New',monospace",fontSize:12,lineHeight:1.7,color:"#fd79a8"}}>
            Your sloping audiogram → <strong>pink noise recommended</strong> (softer highs, easier on damaged hair cells)
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {NOISE_TYPES.filter(n=>noiseTypeOnly ? n.id!=="notched" : true).map(n=>(
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

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <Panel ch={<>
          <Lbl t="VOLUME" s={{marginBottom:6}}/>
          <Big t={`${vol} dB`} sz={26} c="#a29bfe" s={{marginBottom:10}}/>
          <SldC val={vol} min={5} max={80} step={1} cls="sl-purple" color="#a29bfe" onCh={setVol}/>
          <Lbl t="▸ Set BELOW tinnitus loudness — do not mask it. Masking prevents habituation. You should still be able to hear your tinnitus faintly beneath the noise." s={{marginTop:8,lineHeight:1.8,fontSize:13,color:K.amber}}/>
        </>}/>
        {!noiseTypeOnly && (
          <Panel ch={<>
            <Lbl t="NOTCH DEPTH" s={{marginBottom:6}}/>
            <Big t={<>–{nDepth} <span style={{fontSize:14}}>dB</span></>} sz={26} c="#4ade80" s={{marginBottom:10}}/>
            <SldC val={nDepth} min={10} max={60} step={5} cls="sl-teal" color="#4ade80" onCh={setNDepth}/>
            <Lbl t="Width auto-calculated from ERB at your frequency — no guesswork needed." s={{marginTop:8,lineHeight:1.8,fontSize:13}}/>
            <Lbl t={`Notch: ${hzFmt(Math.round(dispF/Math.pow(2,erbWidth*0.5)))} – ${hzFmt(Math.round(dispF*Math.pow(2,erbWidth*0.5)))}`} c={K.teal} s={{fontSize:12,marginTop:4}}/>
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

      {sessions.length > 0 && (
        <Panel s={{marginBottom:14,borderColor:K.dim}} ch={<>
          <Lbl t="📊 SESSION HISTORY" s={{marginBottom:10}}/>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,textAlign:"center"}}>
            <div style={{background:K.dim,borderRadius:8,padding:"10px 4px"}}>
              <Big t={sessions.length} sz={22} c={K.teal}/>
              <Lbl t="sessions" s={{fontSize:12,marginTop:2}}/>
            </div>
            <div style={{background:K.dim,borderRadius:8,padding:"10px 4px"}}>
              <Big t={`${totalHours}h`} sz={22} c={K.amber}/>
              <Lbl t="total time" s={{fontSize:12,marginTop:2}}/>
            </div>
            <div style={{background:K.dim,borderRadius:8,padding:"10px 4px"}}>
              <Big t={streak} sz={22} c="#a29bfe"/>
              <Lbl t={`day streak`} s={{fontSize:12,marginTop:2}}/>
            </div>
          </div>
          <Lbl t="Sessions > 30 s are saved automatically. Aim for 60–120 min daily for best results." s={{marginTop:10,lineHeight:1.8,fontSize:13}}/>
        </>}/>
      )}

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
function NavBar({phase, onBack, onRestart}) {
  const canBack = phase !== "intro" && phase !== "disclaimer" && phase !== "calibration";
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <button onClick={onBack} style={{
        display:"flex",alignItems:"center",gap:6,
        padding:"7px 14px",background:"transparent",
        border:`1px solid ${canBack?K.border:"transparent"}`,
        borderRadius:6,color:canBack?K.muted:"transparent",
        fontFamily:"'Courier New',monospace",fontSize:14,
        cursor:canBack?"pointer":"default",transition:"all 0.15s",
        pointerEvents:canBack?"auto":"none",
      }}
        onMouseEnter={e=>canBack&&(e.currentTarget.style.borderColor=K.teal,e.currentTarget.style.color=K.teal)}
        onMouseLeave={e=>canBack&&(e.currentTarget.style.borderColor=K.border,e.currentTarget.style.color=K.muted)}
      >
        ← BACK
      </button>
      {phase!=="intro" && phase!=="disclaimer" && phase!=="calibration" && (
        <button onClick={onRestart} style={{
          padding:"7px 14px",background:"transparent",
          border:`1px solid ${K.border}`,borderRadius:6,
          color:K.muted,fontFamily:"'Courier New',monospace",fontSize:14,
          cursor:"pointer",transition:"all 0.15s",
        }}
          onMouseEnter={e=>(e.currentTarget.style.borderColor="#ff4757",e.currentTarget.style.color="#ff4757")}
          onMouseLeave={e=>(e.currentTarget.style.borderColor=K.border,e.currentTarget.style.color=K.muted)}
        >
          ↺ START OVER
        </button>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState(() => {
    try { return sessionStorage.getItem("tinnitus_disclaimer_accepted") ? "intro" : "disclaimer"; }
    catch(_) { return "disclaimer"; }
  });
  // Audiogram + tinnitus frequency persist across browser/PWA sessions via localStorage
  const [hRes, setHRes] = useState(() => {
    try { const s = localStorage.getItem("tinnitus_audiogram"); return s ? JSON.parse(s) : null; } catch(_) { return null; }
  });
  const [tFreq, setTFreq] = useState(() => {
    try { return parseInt(localStorage.getItem("tinnitus_freq"), 10) || 9400; } catch(_) { return 9400; }
  });
  const [tVol,        setTVol]      = useState(55);
  const [tEar,        setTEar]      = useState("both");
  const [noiseOnly,   setNoiseOnly] = useState(false);

  const goFromIntro = () => {
    // Skip calibration if already done today, otherwise calibrate before hearing test
    try {
      const calDone = localStorage.getItem("tinnitus_cal_date") === new Date().toISOString().slice(0,10);
      setPhase(calDone ? "tintype" : "calibration");
    } catch(_) { setPhase("calibration"); }
  };

  const goTherapy = (f, noiseType=false) => {
    setTFreq(f); setNoiseOnly(noiseType); setPhase("therapy");
  };

  const restart = () => {
    setPhase("intro"); setHRes(null); setTFreq(9400); setTVol(55); setTEar("both"); setNoiseOnly(false);
    try { localStorage.removeItem("tinnitus_audiogram"); localStorage.removeItem("tinnitus_freq"); } catch(_) {}
  };

  const back = () => {
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

  return (
    <div style={{minHeight:"100vh",background:K.bg,color:K.text,padding:"24px 16px max(60px,env(safe-area-inset-bottom,60px))"}}>
      <style>{CSS}</style>
      <div style={{maxWidth:700,margin:"0 auto"}}>
        <NavBar phase={phase} onBack={back} onRestart={restart}/>
        <ErrorBoundary>
          {phase!=="intro"&&phase!=="tintype"&&phase!=="disclaimer"&&phase!=="calibration"&&<StepBar phase={phase}/>}

          {phase==="disclaimer"  &&<Disclaimer onAccept={()=>setPhase("intro")}/>}

          {phase==="calibration" &&<Calibration onConfirm={()=>setPhase("tintype")} onSkip={()=>setPhase("tintype")}/>}

          {phase==="intro"       &&<Intro
              savedData={hRes ? {freq: tFreq} : null}
              onResume={()=>setPhase("tone")}
              onStart={goFromIntro}
              onSkip={goFromIntro}/>}

          {phase==="tintype"     &&<TinnitusTypeScreen
              onTonal={()=>setPhase("test")}
              onNoise={()=>goTherapy(9400, true)}
              onUnsure={()=>setPhase("test")}/>}

          {phase==="test"        &&<HearingTest
              onComplete={r=>{
                setHRes(r);
                try { localStorage.setItem("tinnitus_audiogram", JSON.stringify(r)); } catch(_){}
                setPhase("testresults");
              }}
              onSkip={()=>setPhase("tone")}/>}

          {phase==="testresults" &&<TestResults
              results={hRes}
              onContinue={()=>setPhase("tone")}/>}

          {phase==="tone"        &&<ToneFinder
              hearingResults={hRes}
              onComplete={(f, vol, ear) => {
                setTFreq(f); setTVol(vol || 55); setTEar(ear || "both");
                try { localStorage.setItem("tinnitus_freq", String(f)); } catch(_){}
                setPhase("octavecheck");
              }}/>}

          {phase==="octavecheck" &&<OctaveCheck
              freq={tFreq}
              vol={tVol}
              earRoute={tEar}
              onConfirm={f=>goTherapy(f, false)}
              onOctaveUp={f=>goTherapy(f, false)}
              onOctaveDown={f=>goTherapy(f, false)}/>}

          {phase==="therapy"     &&<NoiseTherapy
              tinnitusFreq={tFreq}
              hearingResults={hRes}
              noiseTypeOnly={noiseOnly}/>}
        </ErrorBoundary>
      </div>
    </div>
  );
}
