# Moobit — exercise recognition core

A test harness for real-time exercise recognition from a phone's front camera. It watches you
exercise and emits a continuous, low-latency stream of exercise state — `exercise`, `phase`, a
0–100 `depth`, `confidence`, `repCount`, `latencyMs`, `frontLeg` — one event per processed frame.

**Scope is recognition only.** No character, no animation, no game state, no exercises beyond
squat, push-up and forward alternating lunge.

The camera placement is fixed and unusual, and it drives almost every design decision here: the
phone lies **on the floor, ~6 ft in front of you, tilted up, in portrait**, using the front camera.

---

## Contents

- [Quick start](#quick-start)
- [Configuring the dev telemetry server](#configuring-the-dev-telemetry-server)
- [Running a test session](#running-a-test-session)
- [Offline tuning, without a device](#offline-tuning-without-a-device)
- [Architecture](#architecture)
- [What the measurements said](#what-the-measurements-said)
- [Latency](#latency)
- [Tuning](#tuning)
- [What must still be validated on a device](#what-must-still-be-validated-on-a-device)
- [Repository layout](#repository-layout)

---

## Quick start

Everything except the two native plugins is shared, so both apps come from one codebase. Setup is
one command per platform.

```bash
npm install
```

### iPhone

**You need a Mac with Xcode.** There is no way around that for iOS. You also need a physical
iPhone — **the iOS Simulator has no camera**, so it cannot run this at all.

```bash
bundle install          # once: installs cocoapods + xcodeproj from the Gemfile
npm run setup:ios       # downloads the model, registers the native plugin, pod install
npm run dev             # Metro + the local telemetry server
npm run ios             # or open ios/MoobitRecog.xcworkspace and hit Run
```

For a physical device you must set a signing team once: open
`ios/MoobitRecog.xcworkspace`, select the **MoobitRecog** target → *Signing & Capabilities* →
pick your Apple ID under *Team*. A free Apple ID works; the build just expires after 7 days.

`npm run setup:ios` exists because creating a file on disk does **not** add it to an Xcode target.
The three plugin sources and the `.task` model all have to be registered in `project.pbxproj`, and
without that the app builds, launches, shows a live camera, and the frame processor plugin simply
never exists. The script does that via the `xcodeproj` gem — the same library CocoaPods uses — so
it is idempotent and produces a valid project rather than a hand-edited one. Dragging the files
into Xcode by hand does the same job if you prefer.

There is no bridging header to create. `PoseFrameProcessorPlugin.m` imports the *generated* Swift
interface header, which Xcode produces automatically. If Xcode offers to make a bridging header,
declining is correct.

### Android

```bash
npm run setup:android   # just downloads the model; Gradle finds everything else
npm run dev
npm run android
```

Gradle compiles everything under `src/main/java` and picks up `src/main/assets` on its own, so
Android needs no equivalent of the Xcode step.

### Checks that need no device at all

```bash
npm test                # 107 unit and end-to-end recognition tests
npm run typecheck
npm run lint
npm run probe:all       # the measurement probes; see "Offline tuning" below
```

### Version pinning, and two footguns already defused

| Package | Pinned | Why |
| --- | --- | --- |
| `react-native` | 0.81.6 | Contemporaneous with the rest of this stack. |
| `react-native-vision-camera` | 4.7.3 | **Not 5.x.** VC5 requires `react-native-nitro-modules`/`nitro-image` and has a reworked frame-processor API with far less documentation. |
| `react-native-worklets-core` | 1.6.3 | What VC4 frame processors use. |
| `react-native-svg` | 15.15.5 | Overlay. **Not Skia** — see [Architecture](#architecture). |
| `com.google.mediapipe:tasks-vision` | 0.10.14 | Android. Could not be resolved from the machine this was written on; if Gradle cannot find it, check [maven.google.com](https://maven.google.com/web/index.html#com.google.mediapipe:tasks-vision) and bump. Only long-stable API surface is used. |
| `MediaPipeTasksVision` | `~> 0.10.14` | iOS, same caveat. |

Two dependency problems are already fixed, and both would otherwise have bitten on the first build:

1. `@babel/plugin-proposal-optional-chaining` and `@babel/plugin-proposal-nullish-coalescing-operator`
   are devDependencies. worklets-core 1.6.3's babel plugin requires them internally under their
   pre-rename names, RN 0.81's preset no longer installs them, and worklets-core does not declare
   them. Without them the build fails with `Cannot find module
   '@babel/plugin-proposal-optional-chaining'`.
2. `androidResources { noCompress += ['task', ...] }` in `android/app/build.gradle`. MediaPipe
   memory-maps the model straight out of the APK; a compressed `.task` cannot be mapped and the
   landmarker fails at runtime with an opaque error.

---

## Configuring the dev telemetry server

The phone POSTs each finished session to a local server so results land in `./sessions/` instead of
having to be pulled off the device. `npm run devserver` prints your machine's LAN addresses on
startup.

Set the address in the app under **settings → DEV TELEMETRY → Dev server**, then press **Test**.

**Android** — either option works:

- *Same WiFi:* set the host to the LAN IP the server printed, e.g. `192.168.1.42`.
- *Over USB:* `npm run adb:reverse`, then set the host to `127.0.0.1`. This forwards both the
  telemetry port (8787) and Metro (8081), and survives moving between networks.

**iOS** — there is no USB reverse-tunnel equivalent, so the phone must be on the **same WiFi** as
your dev machine. Use the LAN IP the server printed. `NSAllowsLocalNetworking` is already set in
`Info.plist`; on iOS 14+ the first attempt triggers a local-network permission prompt.

Safety properties, both enforced rather than documented:

- The client refuses any host outside loopback and RFC1918 ranges, so a typo cannot ship landmark
  data to whatever host happens to answer.
- Every telemetry entry point is guarded by `__DEV__`, which Metro replaces with a literal, so the
  minifier removes the `fetch` calls from release builds entirely. There is no runtime switch.
- The on-device copy is written **first and unconditionally**. A failed POST never loses a session.

---

## Running a test session

1. **Position the phone.** On the floor, ~6 ft away, tilted up, portrait. Anything between about
   10° and 40° of tilt works.
2. **Get in frame.** The dashed silhouette shows where to stand; the badge says what to fix
   ("Step back", "Move to the middle of the frame"). It turns green when you are in frame.
3. **Calibrate.** Press **Recalibrate** and stand still for two seconds. This captures your neutral
   standing pose *from this camera angle*, and every phase threshold is derived relative to it.
   The capture refuses to complete while you are moving, partly out of frame, or not standing —
   including, deliberately, if you are already in a push-up position.
4. **Declare the set.** Pick the exercise and the rep count you intend. The declared exercise is
   what makes the session's accuracy figure meaningful.
5. **Do the set.** Watch the readout: exercise, phase, depth, reps, and latency percentiles.
   **Mark this rep** drops a timestamped marker into the replay log for anything worth revisiting.
6. **Enter what you actually did.** After **End set** the app asks for your own rep count, with
   one-tap buttons for detected−1 / detected / detected+1. The difference is the accuracy number.
7. **Read the summary.** Detected vs actual, p50/p95/p99 latency, mean confidence, unknown-frame
   dropouts, flicker and partial counts, and — for lunges — the front-leg sequence and its
   alternation rate. It lands as JSON plus a row in `sessions/sessions.csv`.

### Verifying the camera flags on your first run

Two settings are the most likely source of a silent wrong answer. Both take seconds to check:

- **Mirror X** — the skeleton should sit on your body, not beside it.
- **Swap left/right labels** — should not be needed. Raise your right hand: the highlighted limb
  should be the one you actually raised. Left limbs are green, right limbs are blue.
- **Frame rotation** — if the skeleton is rotated or squashed relative to your body, try 90/180/270
  and press **Apply**. Wrong rotation yields plausible-looking but wrong joint angles.

---

## Offline tuning, without a device

Tuning thresholds by watching a live overlay is slow and unrepeatable. Two facilities avoid it.

### The measurement probes

These project an anthropometrically proportioned 3D body through a pinhole model of the exact
camera placement and print what the camera would actually see. This is where every threshold in the
config came from.

```bash
npm run probe:geometry   # does the body fit; how badly are joint angles foreshortened
npm run probe:signals    # which candidate signal survives changes in body size and tilt
npm run probe:features   # the feature table the disambiguation weights are set from
npm run probe:run        # the real pipeline over synthetic sessions: 9 scenarios
npm run probe:stress     # 41 adversarial scenarios
```

`probe:run` and `probe:stress` execute the same code the device runs, so a rep count asserted there
is one the phone would produce from the same landmarks. What they cannot tell you is anything about
MediaPipe's real accuracy, real jitter statistics, or real `z` quality.

### Replaying a recorded session

Every session can record its raw landmark stream. Re-run it against changed thresholds:

```bash
npm run replay -- sessions/raw/<id>.jsonl --actual 10 --exercise squat --compare
```

`--compare` reports how far the replay's conclusions diverge from what the device concluded live —
label agreement, phase agreement, mean and max depth delta. That divergence *is* the effect of your
change. Other flags: `--recalibrate`, `--csv out.csv`, `--json dir/`, `--verbose`.

To exercise the whole loop without a phone:

```bash
npx tsx src/dev/makeSyntheticLog.ts sessions/raw/synth.jsonl squat 10
npm run replay -- sessions/raw/synth.jsonl --actual 10 --compare
```

---

## Architecture

```
camera frame
  → native frame-processor plugin (Kotlin / Swift), on VisionCamera's own thread
      → downscale + colour convert (Android only; iOS resizes on the GPU)
      → MediaPipe Pose Landmarker, LIVE_STREAM, GPU delegate
      → returns the newest available landmark result over JSI
  → shared TypeScript core (pure, no platform APIs, worklet-safe)
      → isotropic coordinate transform
      → One Euro smoothing, per landmark, before any angle maths
      → feature extraction
      → framing check / calibration
      → score every registered exercise → pick the active one → step its state machine
  → one RecognitionEvent per frame
```

The brief's recommended stack is used as specified, with three deviations.

**1. `react-native-svg` for the overlay, not Skia.** Current Skia requires Reanimated 4 plus
`react-native-worklets`, which would put a second worklet runtime alongside the `worklets-core` one
VisionCamera's frame processors use. That is the largest install risk in this stack and a debug
overlay does not justify it. Cost: the overlay renders on the JS thread, so it is driven at 15 fps
from a snapshot and has an off switch for latency runs.

**2. VisionCamera 4.7.3, not 5.x.** See the pinning table above.

**3. The classifier runs on the JS thread, not in the frame-processor worklet.** This is a change
from the stated plan. Running the whole core inside a worklet requires every module in its import
graph to survive the worklets-core babel transform, and that cannot be verified without a device; a
default that silently produces no skeleton would be far worse than one costing a few milliseconds.

The core is written worklet-safe — pure, no platform imports, every function carrying a `'worklet'`
directive — so moving it is a change to `src/app/frame/usePosePipeline.ts` alone. Crucially the cost
is not hidden: the worklet→JS hop is measured and **included** in the reported latency, so the
readout tells you exactly what it costs and whether moving it is worth doing.

### Adding an exercise later

Write a module conforming to `ExerciseModule` in `src/core/exercise.ts` and add one entry to
`EXERCISE_REGISTRY`. Nothing in `pipeline.ts` or `disambiguate.ts` names a specific exercise, so
neither changes. A module supplies its depth metric, its per-frame confidence, its own state
machine (most just delegate to the shared reciprocating one), and its own config block.

**Where this does not generalise, stated plainly.** Because `step` is part of the interface, an
isometric hold like a plank can supply a hold-and-timer machine instead — the interface survives
that. What does not survive is the output contract's `phase` enum:
`standing | descending | bottom | ascending` describes a reciprocating movement and has no
vocabulary for "holding". A plank would have to report `bottom` for its whole duration, and `depth`
would have to mean "quality of hold" rather than "progress through a rep". That is a contract
change, not something a module can paper over. Jumping jacks, high knees and bicep curls are all
reciprocating and need nothing new.

---

## What the measurements said

Three of the brief's assumptions did not survive measurement. All numbers are reproducible with
`npm run probe:geometry` and `npm run probe:signals`.

### 1. Knee angle cannot be the squat's primary signal

The brief specified normalising knee angle between a standing ~170° and a full squat ~70–90°. From
this camera there is no 70–90° to normalise against. Knee flexion happens almost entirely along the
camera's depth axis, which barely projects into the image:

| true 3D knee angle | 179.8° → 62.3° | a 117° sweep |
| --- | --- | --- |
| **apparent (image-plane)** | **180.0° → 150.8°** | **a 29° sweep** |

Worse, that residual range varies **±17% with body height** (24.5° at 1.55 m, 34.5° at 1.95 m), so
no fixed pair of angle thresholds transfers between users.

The replacement is `hipRatio = (ankleV − hipV) / (ankleV − shoulderV)` — where the hips sit between
the ankles and the shoulders. A ratio of two image distances cancels the projective scale they
share, and it behaves far better:

| signal | excursion | spread across 1.55–1.95 m | spread across 10–40° tilt |
| --- | --- | --- | --- |
| `hipRatio` | 0.192 | **±4%** | **±2.4%** |
| knee angle | 29° | ±17% | ±7% |

Knee and hip angle are kept as **corroborators**: they must fall roughly as far as the claimed depth
predicts. That is what still rejects a hip hinge, exactly as the brief intended.

Push-up follows the same pattern: primary is shoulder height above the planted wrists (a 35%
relative excursion, using the landmarks a floor camera sees best), with elbow angle as corroborator.
Elbow angle *is* measurable head-on (166° → 132°), but it gives up only 15 of those 34 degrees over
the first 80% of the descent — as a depth metric it compresses the top of the movement into noise,
which is precisely where an animation needs resolution.

### 2. Torso lean angle is unusable from this camera

It measures **0.000° for all three exercises**. From head-on, lean is pure depth and invisible in
the image plane. The brief listed it as a core angle utility and as the push-up orientation cue; it
cannot serve either purpose here.

Replaced by two measures that separate cleanly:

| feature | squat | push-up | gap |
| --- | --- | --- | --- |
| `torsoOverShoulderWidth` | 1.04 – 1.11 | 0.34 – 0.54 | 0.50 |
| bounding-box aspect | 0.54 – 0.97 | 1.72 – 2.33 | 0.75 |

Forward lean does show up from head-on — as *foreshortening* of apparent torso length, not as a
change in apparent angle.

### 3. The lunge front-leg signal was backwards

The brief proposed relative ankle image-y as primary, expecting the near leg to appear **lower**,
with `z` as a doubtful secondary. Both halves are wrong.

| signal | value at full depth | SNR | sign stable through the whole rep? |
| --- | --- | --- | --- |
| ankle image-y | +0.0101 | 6.5× | **no** — negative until ~25% depth |
| **knee image-y** | −0.108 | **70×** | yes |
| **apparent shank length difference** | +0.118 | **76×** | yes |
| ankle `z` | −0.333 | 35× | yes |

Two things are wrong with ankle-y. The **sign**: with the lens 5 cm off the floor tilted up, a
nearer object subtends a *larger* elevation angle, so the near leg appears **higher**. And the
**magnitude**: ankles sit essentially *at* lens height, which is exactly where that vertical
projection difference degenerates. The measured 13 px only acquires a stable sign once the trailing
heel lifts — it is a signal about the heel rising, dressed up as a signal about depth ordering.

The knee, well above lens height, does not degenerate, and the trailing shank foreshortens to almost
nothing so the length ratio is enormous.

So the module **votes across three signals**, weighting the two z-free ones highest because
MediaPipe's `z` is the one quantity whose real-world error a synthetic model cannot predict. Votes
accumulate across a rep and the label latches at the bottom, so a per-frame wobble cannot flip the
answer mid-rep. Front-leg labelling and alternation detection both survive `z` being **zeroed
entirely** and `z` being **40× noisier** than x/y (both are tests).

### 4. Squat *style* moves the apparent knee angle 5.4x — and broke the corroborators

The other probes sweep the setup: body height, tilt, distance, noise. `npm run probe:style` sweeps
the *user*, and it mattered far more.

With the feet planted and the pelvis at a given height, a leg has one degree of freedom left, so
however far the hips fail to travel backward is forced into the knee travelling forward instead. A
knee-dominant squat points the thigh almost straight down a head-on camera's view axis, where it
foreshortens to almost nothing:

| hip setback at full depth | knee travel past ankle | apparent knee flexion |
| --- | --- | --- |
| 0.05 m (knee-dominant) | 0.34 m | 29 deg |
| 0.22 m (typical) | 0.20 m | 134 deg |
| 0.38 m (hip-dominant) | 0.05 m | 156 deg |

`hipRatio` excursion across that entire range: **0.192 → 0.189, a 1.4% spread**, with 8/8 reps and
depth correlation 0.94 at every style. The primary-signal choice holds up.

The corroborators did not. They matched each excursion against an expected magnitude calibrated at
one style, and so scored **0.00 at four of the five styles** — silently dead for essentially every
real user, and quietly draining the confidence margin that separates a squat from a lunge. Rep
counts never moved, which is exactly why it went unnoticed.

They now check **direction and a saturating minimum** rather than a matched magnitude: "the knee
must have flexed by at least ~20 degrees at full depth", which every style satisfies and a
non-flexing movement does not. Corroboration is now 1.00 at all five styles. The same change was
applied to the lunge and push-up corroborators for the same reason.

Worth noting what actually rejects a hip hinge: the **depth metric itself**. The hips barely drop
in a hinge, so `hipRatio` hardly moves and squat depth reads 0. The knee corroborator was never
what was doing that work.

### 5. Two bugs the adversarial probe caught

- **Missing `z` voted confidently for the wrong answer.** A dead `z` channel makes every z-based
  separation read zero — and "ankles together in z" is precisely the evidence for *squat* over
  *lunge*. Missing data was arguing, not abstaining. Fixed with `Features.zUsable`: z-derived terms
  now withhold themselves and the decision falls back to the z-free signals.
- **Squat held a 0.62 confidence floor throughout a lunge and swallowed its reps.** The two share
  the upright torso, the visible ankles, and — since a lunge also drops the hips and flexes the
  knees — most of the corroboration signal, leaving foot separation only 38% of the weight. But foot
  separation is not weak evidence: a "squat" with one foot 0.75 m in front of the other is not a
  squat. Made categorical, as mutual `feet-split` / `feet-together` vetoes.

### Also worth knowing

- **The required tilt is only ~21°, not steep.** At 6 ft with a wide selfie lens in portrait, a
  1.75 m body spans about 37% of frame height and fits comfortably anywhere between 0° and 40°.
  Foreshortening is real but moderate.
- **Skipping the aspect-ratio correction costs up to 18° of knee-angle error.** MediaPipe normalises
  `x` by image *width* and `y` by image *height*, so on a 720×1280 frame the axes have different
  pixel scales and any angle taken straight from the normalised values is wrong — consistently, and
  therefore invisibly. Everything here works in an isotropic space (`u = x · width/height`, `v = y`)
  where one pixel of movement is the same distance on either axis.
- **A person standing still is labelled `squat`, phase `standing`, depth 0**, not `unknown`.
  Standing *is* the top of a squat, `repCount` stays 0, and committing early means the first rep's
  descent is not missed. Worth knowing when reading a session's label statistics.

---

## Latency

Under async `LIVE_STREAM` a frame processor invocation can never return its own frame's landmarks;
it returns the newest available result, from an earlier frame. So there are two defensible
definitions, and the harness reports both:

- **`STATE_AGE`** (default) — from the capture of the frame the emitted state *describes* to the
  moment classification finished. Includes the result staleness and the worklet→JS hop. This is the
  lag you would actually feel driving an animation.
- **`PIPELINE`** — detector capture-to-result only. Reads lower, and is the flattering choice.

Both are reported as p50/p95/p99, never as an average alone: a good average with occasional spikes
still feels broken, and only the tail shows that. The breakdown line attributes the total across
inference, staleness, hop, classify and decimate, so a shortfall points at its own cause. The
readout flags itself when p95 exceeds the 50 ms target.

**On whether &lt;50 ms is achievable — this has not been measured.** There is no Android SDK, no
Xcode and no device in the environment this was built in, so any number quoted here would be
fabricated. What the code does is make the measurement honest and attributable when you run it. The
things most likely to dominate, in the order worth checking:

1. **MediaPipe inference** with the lite model on the GPU delegate. If this alone exceeds the
   budget, try `npm run model:download full` to confirm lite is actually helping, and drop the
   inference size to 256 or 192 in settings.
2. **Result staleness** — the async gap. If `resultAge` p50 is large, inference is not keeping up
   with the camera and frames are being dropped; the drop rate is reported alongside.
3. **The worklet→JS hop.** If this shows up meaningfully in p95, moving the classifier into the
   worklet is the fix, and the core is already written for it.
4. **Classify time** should be well under a millisecond; the pipeline allocates nothing per frame
   after construction, specifically so it cannot cause a GC pause and a p99 spike.

---

## Tuning

Every threshold is reachable from **`src/core/config.ts`**, which also documents where each number
came from and which ones are most likely to need moving after real footage. Exercise-specific values
live in the exercise's own module (`SQUAT_CONFIG`, `PUSHUP_CONFIG`, `LUNGE_CONFIG`) and are
re-exported there, so no threshold is defined in shared code.

The four most likely to need real-world adjustment, worst first:

1. `LUNGE_CONFIG.deadbandAnkleDz` / `wVoteAnkleDz` — MediaPipe `z` has systematic error no synthetic
   model predicts. If it proves unusable, set `wVoteAnkleDz` to 0; the module keeps working.
2. `SQUAT_CONFIG.depthExcursion` / `LUNGE_CONFIG.depthExcursion` — stable to ±4% across bodies and
   ±1.4% across squat style in simulation, but how deep a given person chooses to squat is a
   different question from either, and only real sessions answer it.
3. `PUSHUP_CONFIG.sagFullAt` / `sagZeroAt` — the synthetic hip-sag model is the least trustworthy
   part of the generator, which is why `rejectSaggedReps` defaults to **off**: rigidity is reported
   every frame so you can validate it before it starts discarding anyone's reps.
4. `DEFAULT_ONE_EURO.beta` — the lag/jitter trade-off cannot be judged without real jitter. Raise it
   if fast reps feel laggy, lower it if a still stance jitters. Turn on "Also draw unsmoothed
   skeleton" to judge it by eye.

---

## What must still be validated on a device

Synthetic data proves the geometry and the logic. It cannot prove the thresholds, because it has no
soft tissue, no clothing, no motion blur, and no MediaPipe failure modes. This is the checklist.

**Assumptions that rest on projection reasoning and need a real camera to confirm:**

- [ ] **Push-up framing.** Are shoulders, elbows and hips genuinely visible throughout, head-on from
      the floor at 6 ft? The design assumes yes and that **feet are not** — which is why the module
      uses no ankle feature and sets `minAnkleVisibility: 0`. Watch the overlay through a set: if
      elbows disappear behind the torso at the bottom, elbow corroboration needs weakening.
- [ ] **Lunge front leg.** The debug line prints all three votes live
      (`votes[knee … shank … dz …]`). Do a set and check they agree with the leg you actually
      stepped forward. If `dz` disagrees with the other two, zero its weight.
- [ ] **MediaPipe `z` quality.** Watch `sepZ` in the lunge debug line. It should read ~0 standing and
      ~0.3 at the bottom of a lunge. If it is noise, everything still works via the z-free path —
      confirm that it does.
- [ ] **Mirror and left/right flags.** Raise one hand; check the highlighted limb.
- [ ] **Frame rotation.** Confirm the skeleton lands on the body, not rotated or squashed.

**Numbers that can only come from a device:**

- [ ] End-to-end latency p50/p95/p99 against the 50 ms target, and which stage dominates.
- [ ] Whether lite is fast enough, or whether `full` is affordable.
- [ ] Whether 256 or 320 px inference is the better trade-off.
- [ ] Sustained frame rate and the native drop rate under real thermals.
- [ ] Real landmark jitter, to tune the One Euro parameters.
- [ ] Detected-vs-actual rep accuracy per exercise, which is what the ground-truth flow exists for.

**Known-unverified mechanics:**

- [ ] The MediaPipe artifact versions (Android and iOS) could not be resolved from this network.
- [ ] The push-up rigidity/"cheat" signal — the least trustworthy part of the synthetic model, hence
      rejection defaults to off.
- [ ] Behaviour with a second person or a pet in frame. `numPoses` is 1, so MediaPipe picks one
      subject; which one it picks under this camera angle is untested.

---

## Repository layout

```
src/core/                pure, platform-free, worklet-safe recognition core
  nativeContract.ts      the native → JS contract; keep in step with both plugins
  geometry.ts            isotropic coordinate transform, angle maths, pose view
  oneEuro.ts             One Euro filter over landmarks
  features.ts            every scalar signal the classifiers read
  calibration.ts         the 2 s standing capture and its validity gates
  depthFsm.ts            the shared reciprocating state machine
  exercise.ts            the exercise-module interface and shared helpers
  exercises/             squat, push-up, lunge, and the registry
  disambiguate.ts        which exercise is active, and the commit/switch/drop rules
  framing.ts             the in-frame test and the guide geometry
  latency.ts             latency definitions and percentiles
  session.ts             session summary, CSV row, human-readable form
  replayFormat.ts        the JSONL replay log
  config.ts              single tuning entry point, with provenance for every number
  pipeline.ts            wires the stages together

src/app/                 the harness app (React Native)
  frame/                 the frame processor and its bridge to the pipeline
  components/            overlay, framing guide, readout, session controls, settings
  screens/               the harness screen
  session/               recorder and dev-only telemetry client
  config/devFlags.ts     __DEV__ gating for the telemetry path

src/dev/                 offline verification, never shipped
  synthBody.ts           3D body + pinhole camera model of the fixed placement
  synthExercises.ts      squat / push-up / lunge / hinge / arm-raise kinematics
  runPipeline.ts         drives the real pipeline over synthetic or recorded frames
  probe*.ts              the measurement probes, including probe:style
  replayCli.ts           offline replay and comparison

android/app/src/main/java/com/moobitrecog/pose/    Kotlin frame-processor plugin
ios/MoobitRecog/Pose/                              Swift frame-processor plugin
tools/dev-server/                                  local-only telemetry sink
__tests__/                                         107 tests
sessions/                                          landed session data (gitignored)
```
