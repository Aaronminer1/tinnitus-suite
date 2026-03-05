# Scientific Critique of the Tinnitus Suite Algorithm

## Overview

This critique compares the implementation in `tinnitus-suite.jsx` against the primary
scientific literature establishing Tailor-Made Notched Music Training (TMNMT):

- **Okamoto H, Stracke H, Stoll W, Pantev C (2010).** "Listening to tailor-made notched
  music reduces tinnitus loudness and tinnitus-related auditory cortex activity."
  *PNAS* 107(3):1207–1210. DOI: 10.1073/pnas.0911268107
- **Pantev C, Okamoto H, Teismann H (2012).** "Music-induced cortical plasticity and
  lateral inhibition in the human auditory cortex as foundations for tonal tinnitus
  treatment." *Front. Syst. Neurosci.* 6:50. DOI: 10.3389/fnsys.2012.00050
- **Teismann H, Okamoto H, Pantev C (2011).** "Short and intense tailor-made notched music
  training against tinnitus: the tinnitus frequency matters." *PLoS ONE* 6:e24685.

---

## Summary Scorecard

| Parameter | Science Specifies | App Implements | Match |
|---|---|---|---|
| Carrier signal | Patient's own music | White/Pink/Brown noise | ❌ WRONG |
| Notch width | 1 octave (fixed) | ~1.5×ERB per stage (~0.05 oct at 4 kHz) | ❌ FAR TOO NARROW |
| Notch shape | Simple bandstop filter | 3-stage cascaded BiquadFilter | ⚠️ Over-engineered |
| Dosage | 1–2 hours/day × 12 months | 60-min session, no longitudinal protocol | ⚠️ Unclear |
| Short-term effect | ≤2 weeks after 5-day intensive | Single session | ❌ Insufficient |
| Tinnitus matching | Multi-day, 1/24-oct resolution, forced-choice | Single-session log-scale slider | ⚠️ Unreliable |
| Octave verification | Explicit forced-choice check | ✅ Included | ✅ OK |
| Audiogram EQ | Not studied | Peaking filters at threshold frequencies | ⚠️ Unstudied |
| Hearing loss limit | ≤35–50 dB HL | Applied regardless | ⚠️ Unvalidated |
| Tinnitus type | Tonal only (≤8 kHz) | Any tinnitus | ⚠️ Scope creep |

---

## Critical Finding 1: Wrong Carrier Signal (MAJOR)

### What the science says
The original Okamoto (2010) study used **patients' own self-chosen enjoyable music**.
This choice was deliberate and mechanistically important, not arbitrary.

The paper explicitly tested notched broadband noise and found it **caused Zwicker tone
hallucinations** — an auditory illusion resembling tinnitus. The paper specifically chose
music to avoid generating this side effect:

> *"Our additional behavioral study demonstrated that notched music could not elicit a
> Zwicker tone, whereas notched broadband noise could."*
> — Okamoto et al. 2010, Discussion

Music also engages the brain's **attention and dopaminergic reward networks**:

> *"Joyful listening to music activates the reward system of the brain and leads to release
> of dopamine, which plays an important role in cortical reorganization."*
> — Okamoto et al. 2010, Discussion

Pantev (2012) further specifies that the ideal music type is **rock or pop** because it
has a flat, high-energy spectrum covering the full frequency range, including the high
frequencies where tinnitus typically occurs:

> *"While rock or pop music usually already contains a relatively flat spectrum, including
> a comparatively significant amount of high-frequency energy, this does not hold true for
> other music types, such as vocal music or single instruments."*

### What the app does
```js
// tinnitus-suite.jsx — noise generators as primary therapy carriers
function mkWhite(ctx) { /* flat spectrum random noise */ }
function mkPink(ctx)  { /* -3dB/oct noise */ }
function mkBrown(ctx) { /* -6dB/oct noise */ }
```

The app uses white, pink, and brown noise as the carrier signal. Based on the original
research, this is the wrong medium for two reasons:

1. **Noise may produce Zwicker tone hallucinations** at the notch edge — essentially
   creating a new phantom sound while trying to suppress the existing one.
2. **Noise lacks the emotional engagement** necessary to activate the dopaminergic
   reward system that the researchers believe potentiates cortical reorganization.
3. **Passive listening to noise** does not recruit sustained top-down attention the way
   favourite music does. Pantev (2012) showed that attention *strengthens* lateral
   inhibition: patients who actively attend to the sound show stronger neural effects.

### Recommendation
Replace noise carriers with music playback. Load a user-provided audio file and apply
the notch filter to that file's spectrum in real-time. This is the only validated carrier.

---

## Critical Finding 2: Notch Width Orders of Magnitude Too Narrow (MAJOR)

### What the science says
Every TMNMT study uses a **notch of exactly 1 octave width** centered at the tinnitus
frequency (for example, if tinnitus is at 4 kHz, the notch removes energy from ~2.83 kHz
to ~5.66 kHz):

> *"A frequency band of one octave width centered at the individual tinnitus frequency
> was removed from the music energy spectrum via digital notch filter."*
> — Okamoto et al. 2010, Methods (Music Modification)

This is also specified in the Pantev (2012) short-term follow-up study:

> *"All patients received the target TMNMT, including the removal of the frequency band
> of one octave width centered at the individual tinnitus frequency."*

The notch width has been studied for its effect on cortical inhibition. Okamoto 2005 found
that N1m attenuation depended on notch bandwidth, with the optimal inhibitory effect at
approximately **1 critical band** width (≈ 1 ERB). Optimal notch width for *clinical*
TMNMT has not yet been formally established (Pantev 2012 lists it as an open question),
but all completed clinical studies used 1 octave.

### What the app does
```js
// ERB-scaled notch derived from Glasberg & Moore 1990
function erbOct(f) {
  const erbHz = 24.7 * (4.37 * f / 1000 + 1);
  return Math.log2((f + erbHz) / f);  // ERB width in octaves
}

// 3-stage cascade, total notch ≈ 1.5 × ERB(f)
const ow = erbOct(tf) * 1.5;  // ~0.042 octaves at 4 kHz
```

At 4 kHz, ERB ≈ 190 Hz and `1.5×ERB ≈ 285 Hz`. In octave terms, this equals about
**0.047 octaves**. The literature-standard notch is **1 full octave** — meaning the app's
notch is approximately **21× too narrow** at 4 kHz (and even narrower at higher
frequencies where tinnitus most commonly occurs).

The cascaded notch stages further complicate this: The three `BiquadFilter` nodes of type
`"notch"` each apply a resonant dip, not a flat bandstop. The combined shape is a narrow
resonance dip rather than a flat 1-octave spectral gap. This does not replicate the flat
brick-wall notch applied in the studies.

### Recommendation
Change to a proper 1-octave bandstop filter centered at `tf`:
```
lower edge = tf / sqrt(2)  (~0.707 × tf)
upper edge = tf * sqrt(2)  (~1.414 × tf)
```

---

## Critical Finding 3: Inadequate Tinnitus Frequency Matching (MODERATE)

### What the science says
Pantev (2012) identifies tinnitus frequency determination as a critical and non-trivial
challenge:

> *"Firstly, the tinnitus frequency cannot be measured objectively, but has to be matched
> subjectively by the patient who has to compare test tones of different frequencies to
> his tinnitus percept. [...] There are certain typical pitfalls, such as octave confusion,
> that need to be considered."*

The Pantev group uses:
- A high-frequency audiometer up to 16 kHz
- **1/24th octave frequency resolution**
- Multiple candidate identification followed by **two-forced-choice** comparison
- Repeat sessions on **different days** before finalizing
- Explicit octave disambiguation test across 1–16 kHz

### What the app does
The `ToneFinder` component presents a single continuous slider on a log scale and relies
on the user adjusting it until the tone matches their tinnitus in a single session.

The `OctaveVerification` step is a positive addition that partially addresses octave
confusion — but a single-session, freely adjustable slider still allows:
- Regression toward prominent frequencies (e.g. round numbers)
- Considerable session-to-session variability (typically ±half-octave for untrained users)
- No reliability assessment across days

If the tinnitus frequency is misidentified by even one octave, the notch is placed in the
entirely wrong region and provides no therapeutic benefit.

### Recommendation
- Display the previous session's matched frequency to prompt comparison across sessions
- Add a forced-choice comparison step between the current match and ±1 octave
- Store multiple matches and display the median with variance as a reliability indicator

---

## Critical Finding 4: Session Protocol Missing (MODERATE)

### What the science says
The Okamoto (2010) long-term study required patients to listen for **1–2 hours daily for
12 consecutive months**, for a total of approximately 720 hours of training. This was
necessary for persistent cortical reorganization:

> *"We believed that regular training over the course of several months was necessary
> because many examples from the literature on human cortical plasticity indicate that
> longer-term training induces more persistent and possibly permanent effects."*

The short-term study (Teismann 2011) compressed this to 24 hours over 5 days. While
effective, the relief lasted only about **2 weeks** — far shorter than the 12-month study.

The studies also specify:
- Quiet environment (ambient broadband noise disrupts the spectral notch effect)
- Linear-response closed headphones
- Moderate, comfortable loudness (not prescription SPL)

### What the app does
The `NoiseTherapy` component has:
```js
// 60 minute default timer
const [timeLeft, setTimeLeft] = useState(60 * 60);
```
There is a session timer, which is good. However:
- No longitudinal tracking: the app does not track cumulative therapy hours
- No daily reminder or dosage guidance
- No instruction to use closed headphones in a quiet environment
- Sessions can be run for any duration, including a few minutes, which provides no benefit

### Recommendation
- Add a therapy log showing cumulative hours per week and month
- Show the evidence-based target (1–2 hours/day, sustained over months)
- Add a note warning against use in noisy environments and with earbuds that allow
  ambient sound to contaminate the notched spectrum

---

## Critical Finding 5: Audiogram EQ Has No Scientific Precedent (LOW/MODERATE)

### What the science says
TMNMT as studied applies **only the spectral notch** to the carrier. No study has
investigated adding hearing-loss compensation EQ to the carrier signal as part of the
therapeutic protocol.

### What the app does
```js
// Peaking EQ at each audiogram threshold frequency
node.gain.value = Math.min(18, avg * 0.5); // 50% gain compensation at Q=1.8
```

The audiogram EQ applies peaking filters to boost frequencies where the user has hearing
loss. This serves a legitimate audiological purpose (making the signal audible across the
spectrum), but it has two potential problems:

1. **Interaction with the notch**: Boosting gain near the tinnitus frequency via
   audiogram EQ could partially refill the spectral notch, undermining the therapeutic
   deafferentation that drives lateral inhibition.
2. **Unstudied therapeutic effect**: It is unknown whether hearing-loss compensation
   strengthens, weakens, or is neutral to TMNMT efficacy. Pantev (2012) notes severe
   hearing loss limits TMNMT effectiveness and suggests this needs dedicated research.
   Applying partial compensation without validation could confound outcomes.

The 50% compensation factor (`avg * 0.5`) and the hard cap at 18 dB are arbitrary and
not derived from audiological research. The EQ Q value of 1.8 creates wide-skirt filters
that are not shaped to standard audiogram curves.

### Recommendation
This is a creative addition and the audiological intent is sound. Consider making it
optional and clearly labelling it as "experimental" — separate from the TMNMT component.

---

## Critical Finding 6: Passive Sleep Listening May Be Counterproductive (LOW)

### What the science says
Pantev (2012) showed that **focused auditory attention strengthens lateral inhibition**
in the human auditory cortex. Distracted listening produces weaker cortical effects:

> *"The population-level frequency tuning became sharper when attention was directed to
> the auditory domain."* (Okamoto et al. 2007)

Furthermore, Pantev (2012) raises the open question of whether **passive exposure** to
notched sound (as in animal studies of noise trauma recovery) has the same effect as
the attentive, emotionally engaged listening used in TMNMT.

Patients in the original study were given *their favourite music* specifically to ensure
sustained, attentive engagement throughout the training period. Using background noise as
a sleep aid does not replicate this attentive engagement.

### What the app does
The app includes a sleep timer (`NoSleepManager`) and positions night-time passive
listening as a valid use case.

### Recommendation
Differentiate between:
- **Active therapy**: intentional listening (supported by evidence)
- **Passive background listening**: may help with masking / habituation but is not the
  TMNMT protocol and should not be presented as equivalent

---

## Evidence Quality of TMNMT Itself

It is worth noting that TMNMT's overall evidence base is limited:

| Study | Design | n | Key Finding |
|---|---|---|---|
| Okamoto 2010 | RCT, 12-month | n=8 target, n=8 placebo | ~25% loudness reduction; cortical activity reduced |
| Teismann 2011 | Uncontrolled, 5-day | ~20 | Effect waned within 2 weeks |
| Pantev 2012 | Review | — | Optimal notch width still unknown |
| Hoare 2011 (systematic review) | Meta-analysis | — | Inconclusive; called for larger RCTs |

The original Okamoto (2010) sample of n=8 per group is extremely small. Larger independent
replication studies have had mixed results. **TMNMT is a promising but not yet
conclusively validated treatment.** The app should communicate this to users to set
appropriate expectations.

---

## Constructive Summary

The app is well-engineered and covers the clinical workflow (audiometry → pitch matching
→ octave verification → therapy) with impressive fidelity. The ERB-based notch
parameterisation shows genuine understanding of psychoacoustics. However, the two most
fundamental parameters — **the carrier signal** and **the notch width** — both differ
from the published protocol in ways that are scientifically consequential.

### Priority fixes (ranked):

1. **Switch carrier to music** — Replace noise with user-provided music file playback.
   This is not an aesthetic preference; it is mechanistically required by the TMNMT theory
   and avoids the Zwicker-tone risk that notched noise carries.

2. **Widen the notch to 1 octave** — Change from the current narrow ERB-based cascade
   to a flat bandstop filter spanning `tf/√2` to `tf×√2`. The cascade stages can be
   retained but their combined passband suppression needs to span this full octave range.

3. **Add longitudinal session tracking** — Log cumulative therapy hours per week/month.
   Display progress toward the evidence-based target (1–2 hrs/day over months).

4. **Improve frequency matching reliability** — Store multi-session matches, display
   variance, add cross-day comparison prompts.

5. **Add clear disclaimers** — Inform users that TMNMT evidence is preliminary (n=8
   original study), that the app's carrier/notch parameters differ from studied protocols,
   and that they should consult an audiologist for clinical tinnitus management.

---

*Critique prepared against primary literature. All citations verifiable at the DOIs
listed at the top of this document.*
