# Ruby's voice

Ruby speaks with a [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v2Pro
model fine-tuned on the two `AI voice*.aac` clips in
`frontend/public/assets`. Everything runs on this machine, so no audio leaves
it. GPT-SoVITS is MIT licensed, which permits commercial use.

## Running it

Two processes, in separate terminals:

```powershell
# 1. The site
npm start

# 2. Ruby's voice (takes ~1 minute to load the model)
cd python\ruby_voice
..\gpt_sovits\.venv\Scripts\python.exe sovits_server.py
```

Then open <http://127.0.0.1:5000/ruby-test.html> in Chrome or Edge.

The voice server listens on `127.0.0.1:5055` and the backend proxies to it, so
the browser never talks to it directly. Override the address with
`RUBY_VOICE_URL` if needed.

The first reply after startup takes about 15 seconds while the GPT weights and
CUDA graph warm up. After that, expect roughly 3 seconds for a short reply and
up to about 10 for a long one.

## How it fits together

| Piece | File |
| --- | --- |
| Intent matching and answers | `backend/src/services/ruby-brain.js` |
| Route briefing: facts and phrasing | `backend/src/services/route-narration.js` |
| Place briefing: facts and phrasing | `backend/src/services/point-narration.js` |
| HTTP routes (`/api/ruby/ask`, `/narrate/route`, `/narrate/point`, `/speak`, `/voice-status`) | `backend/src/routes/ruby.js` |
| Shared Mars elevation sampler | `backend/src/services/mars-elevation.js` |
| Route briefing UI | `frontend/public/js/route-briefing.js` |
| Place briefing UI | `frontend/public/js/place-briefing.js` |
| Chat assistant: UI | `frontend/public/js/ruby-widget.js` |
| Chat assistant: brain | `backend/src/services/ruby-brain.js` |
| Chat assistant: AI client, prompts, place index | `openrouter.js`, `ruby-prompt.js`, `gazetteer.js` in `backend/src/services/` |
| Test page | `frontend/public/ruby-test.html` |
| Voice server | `sovits_server.py` |
| Hindi auditioning (XTTS) | `speak_hindi.py` |

The voice server exposes `GET /health` and `POST /tts` → `audio/wav` on port
5055, and the backend proxies to it.

## Spoken route briefings

In the Route Planning view, **Ask Ruby to explain this route** sends the
calculated route to `/api/ruby/narrate/route` and speaks the result. Example
output for a 35.6 km traverse near Valles Marineris:

> Balanced route from the Valles Marineris rim to the survey waypoint is 35.6
> kilometers. At your assumed 0.15 kilometers per hour that is 237 hours 36
> minutes of driving, about 59.4 sols. Of 912 route cells, 39 are caution. The
> longest caution stretch is 170 meters about 21.7 kilometers in.

Design rules, because a confident voice makes wrong numbers dangerous:

- **Every figure is read from the planner output**, or computed with the same
  formula `makeEstimate()` uses in `mission-planner.js`. Nothing is estimated
  or smoothed, so Ruby can never contradict the screen.
- **Phrasing is templated, not generated.** No language model is involved, so
  there is nothing that can invent a number.
- **Breached budgets lead.** If oxygen, energy, sols, distance, slope or
  roughness exceed a limit you entered, that goes in the spoken summary rather
  than a footnote.
- **Assumptions are labelled aloud.** Time, energy and oxygen are arithmetic on
  your inputs, and Ruby says so.
- **Data quality is stated.** Coarse 1 km fallback terrain, snapped endpoints
  and an unavailable vision layer are all mentioned.

The reply is split into `summary` and `detail` because `/speak` caps one
utterance at 600 characters; "Tell me more" speaks the rest. A 340-character
summary takes roughly 15 to 18 seconds to synthesize.

The same endpoint can narrate a user-drawn traverse: the Mission Planner's
custom-route audit builds a payload of the same shape, and the narrator treats
missing fields as absent rather than failing.

## Ask Ruby: the chat assistant

In the Explore view a robot button sits in the bottom-right corner. It opens a
small chat overlay where you can ask anything. It hides in the other views.

Each question goes to `POST /api/ruby/ask` together with the data for the
currently selected place (the same `/api/point` and `/api/cell` payloads the
panel shows) and the last few turns of conversation. Ruby tries these in order
and the reply says which one answered, shown as a badge on the message:

| Step | Handles | Badge |
| --- | --- | --- |
| Small talk (short messages only) | greetings, thanks, "who are you" | none |
| Map terms | "what is thermal inertia", "what does this slope mean" (adds the local value) | Map guide |
| Elevation | coordinates or any named place, via the real DEM | Map data |
| Selected place | "how steep is it here", "is it cold", "what rocks are here" | Map data |
| Built-in Mars facts | gravity, sol length, atmosphere, and so on | Mars facts |
| AI model | everything else, with the place's data supplied as context | AI answer |
| Fallback | says what it cannot do and what it can; never blank | none |

Rules that keep the numbers trustworthy:

- **Measured values never come from the model.** If the data has them, steps
  3 and 4 answer. The model is told to quote the supplied data exactly and to
  say "I do not have that measurement" rather than estimate.
- **A question about another place is not answered with the selected place's
  data.** `gazetteer.js` indexes the 2,052 named features so "how steep is
  Arsia Mons?" with Jezero selected is recognised as a different place.
- **Questions that ask "why" go to the model** when it is available, since the
  data says what a value is, not why. Without a key, Ruby says so and gives
  the data.
- **The climate numbers are labelled as model values.** "Right now" questions
  are answered with "I don't have live weather for this spot".

### Setting up the AI model

Put an OpenRouter key in `.env` as `OPENROUTER_API_KEY` (or `OPEN_ROUTER_KEY`).
The key is read only on the server and never sent to the browser;
`GET /api/ruby/ai-status` reports whether one is set without revealing it. The
file is re-read on each question, so adding a key needs no restart. Only the
`OPENROUTER_*` entries are read: nothing in this app loads `.env` wholesale, and
doing so would start applying `HOST` and `PORT`.

Models are free ones, tried in order until one answers:
`nvidia/nemotron-3-ultra-550b-a55b:free`, `cohere/north-mini-code:free`, then
`google/gemma-4-31b-it:free`. Override with `OPENROUTER_MODEL`. Choose **one
model per provider**: when this was built, both Gemma models returned
"temporarily rate-limited upstream" at the same moment because the provider
throttles its free tier as one shared pool.

Free-tier behaviour worth knowing:

- Several free models are "thinking" models that spend most of their token
  budget on hidden reasoning (620 of 667 tokens in one measurement). The
  request allows 1000 tokens so they still have room to answer, and a reply
  with no text counts as a failure and moves on to the next model.
- A 401 (bad key) stops immediately, because every model would fail the same
  way. A 403 means one model refuses the account, so the next is tried.
- At most 15 AI calls per minute are allowed, as a cost guard.
- Model text is cleaned before it is shown: markdown, emoji and curly quotes
  are removed. A separate `speech` version also spells out symbols (`-63°C`
  becomes "minus 63 degrees Celsius") and strips thousands separators, which
  the voice would otherwise read as "twenty-one, nine hundred".

The overlay's header shows which place Ruby is talking about and whether its
data has loaded. Replies can be spoken automatically (toggle in the header,
remembered per browser) or played individually with the Play button. The
microphone button appears in Chrome and Edge.

## Spoken place briefings

In the Explore view, selecting a location shows a **Ruby's briefing** panel.
**Explain this place** posts the `/api/point` and `/api/cell` payloads the panel
already fetched to `/api/ruby/narrate/point`, so no extra lookups happen. Ruby
speaks an overview, then offers each topic as its own button: Terrain, Surface
and hazards, Geology, Climate, Sunlight, Rover weather (inside Gale only), and
How to read this.

Example for Jezero Crater:

> You are looking at Jezero, a crater about 45 kilometers across, at 18.38
> north and 77.58 east. The ground here sits 2644 meters below the Mars datum.

and under Geology:

> The mapped geologic unit here is HNt, Hesperian and Noachian transition unit.
> That makes this terrain roughly three to three point seven billion years old.

Topics are separate utterances because a full description runs past the
600-character limit of `/speak`. The same rules as the route briefing apply:
values come only from the two services, the plain-language bands
(`gentle`/`moderate`/`steep`, dust-dominated through rock-dominated, clear sky
through dust-storm level) are copied from the thresholds `map.js` already
displays, and the "How to read this" topic states the grid resolutions and that
temperature, wind and dust are climate-model values rather than measurements.

Three details that needed care for speech:

- **IAU descriptor terms are translated.** "Olympus Mons, a mons" became
  "Olympus Mons, a volcano"; `FEATURE_TYPE_WORDS` maps the common Mars terms.
- **Rover weather strings are rewritten.** The panel shows `-71 to -5 °C`,
  which the TTS frontend mangles, so `speakRawValue` turns it into "minus 71 to
  minus 5 degrees Celsius" and `777 Pa` into "777 pascals".
- **Slope and grade are not mixed.** The ~200 m slope and the 1 km cell grade
  come from different grids, so quoting both together would imply one
  measurement. The grade is only spoken alongside the cell slope.

If both services fail, Ruby says so outright rather than delivering a briefing
that describes nothing.

## Rebuilding the voice from scratch

```powershell
cd python\ruby_voice

# 1. Slice the source clips and transcribe them with Whisper.
#    Produces dataset/wavs/*.wav plus dataset/ruby.list.
.venv\Scripts\python.exe build_dataset.py --model medium

# 2. Fine-tune both stages (~10 minutes on an RTX 2050).
.venv\Scripts\python.exe train_ruby.py
```

`train_ruby.py` writes `SoVITS_weights_v2Pro/ruby_e8_s384.pth` and
`GPT_weights_v2Pro/ruby-e15.ckpt` inside `python/gpt_sovits`. If you retrain,
delete `python/gpt_sovits/logs/ruby/logs_s2_v2Pro/*` first: training otherwise
resumes from the finished checkpoint, reports success, and never writes new
weights.

## Room sound

The model reproduces Ruby's timbre but outputs a dry, studio-clean signal,
whereas her source recordings were made in a real room. `reverb.py` adds a
small room tail back: `rt60=0.70 s`, `wet=0.26`, matching the roughly 86 dB/s
decay measured in the source clips. This is on by default and adds no noise,
with high-frequency content staying level with the source (0.07% of energy in
the 4-8 kHz band against the source's 0.11%).

Tune it, or turn it off:

```powershell
# Audition several settings on already-generated audio, then listen
# to samples_reverb/ and pick one.
.venv\Scripts\python.exe audition_reverb.py

# Run the server with your choice
..\gpt_sovits\.venv\Scripts\python.exe sovits_server.py --reverb-wet 0.14
..\gpt_sovits\.venv\Scripts\python.exe sovits_server.py --reverb-wet 0   # fully dry
```

### Room tone is available but off

The source clips also hold a *steady* broadband floor about 25 dB below speech,
which reverb cannot reproduce because a tail decays between words while that
floor is constant. Adding it back does match the source on paper:

| Version | Speech-to-floor (source: ~25 dB) |
| --- | --- |
| Dry model output | 229 dB (pauses are digital silence) |
| Reverb only (default) | 78 dB |
| Reverb + room tone | 25 dB |

In practice it is plainly audible as hiss, because a constant noise floor is
far more noticeable than that measurement suggests, so it stays off. Enable it
with `--room-tone-db 34` (fainter) or `--room-tone-db 25` (matches the source).

If you do use it, note that the noise is lowpassed four times over. A single
gentle rolloff left it 3-4 times brighter than the source clips, which cut off
near 10 kHz, and that excess high-frequency energy was what made it hiss.

## Things worth knowing

**The reference clip dominates output quality.** GPT-SoVITS copies tone from a
single reference clip at inference time, and it must be 3 to 10 seconds long.
Sweeping all 16 training clips against one sentence produced speaker-similarity
scores from 0.57 to 0.78, so this is the most effective knob available.
`DEFAULT_REFERENCE` in `sovits_server.py` holds the winner. Two clips made
synthesis collapse to 1.4 seconds of unusable audio, so re-run that comparison
before changing it.

**Avoid thousands separators in Ruby's replies.** The text frontend splits on
commas, so "2,644" is spoken as "two, six hundred forty-four". `formatNumber`
in `ruby-brain.js` deliberately emits plain digits.

**The source clips limit the ceiling.** They are clean speech (Demucs measured
99.7% vocals) but band-limited to about 10 kHz, which is the signature of
roughly 22 kHz audio upsampled to 48 kHz. They also appear to be AI-generated
already, so this is a clone of a synthetic voice. Measured against the original
clips, generated audio scores about 0.78 where the clips score 0.97 against
themselves. Longer, full-bandwidth recordings of the same voice would raise
that ceiling more than any further tuning.

## Environment notes

Two separate virtual environments, because the projects pin conflicting
versions (`numpy<2` and `transformers<5` for GPT-SoVITS, newer for XTTS):

- `python/ruby_voice/.venv` (Python 3.13): XTTS, Demucs, Whisper, dataset tools
- `python/gpt_sovits/.venv` (Python 3.11): GPT-SoVITS; it does not support 3.13

Both pin torch 2.8 with CUDA 12.6. Newer torch pulls in `torchcodec`, which
needs FFmpeg 4-7 shared libraries; only FFmpeg 8 and 9 are currently published,
so it cannot load on Windows.

Three upstream details needed adapting for a single 4 GB GPU on Windows.
`train_ruby.py` applies them idempotently in `patch_upstream_for_single_gpu_windows`,
so the `gpt_sovits` clone stays disposable:

1. Dataloader worker counts (4 for SoVITS, 12+ for GPT validation) exhaust RAM
   and fail with "WinError 1455: The paging file is too small".
2. The GPT stage forces `DDPStrategy`, whose gloo backend cannot bind on
   Windows.
3. The bucket sampler queries the distributed process group whenever CUDA is
   present, even when distributed was never initialised.

`compat/jieba_fast/` aliases `jieba_fast` to pure-Python `jieba`. The real
package is a C extension with no Windows wheel, and the inference module
imports the Chinese text frontend eagerly even for English.
