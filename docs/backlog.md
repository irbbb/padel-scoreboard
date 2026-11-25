# Product & Technical Backlog — Xiaomi Smart Band 9 Padel Scoreboard

**Target:** Xiaomi Smart Band 9 Global, `192 × 490` capsule display (325 ppi), Xiaomi Vela QuickApp (`.rpk`)  
**Audience:** A mid-junior developer with access to the target band  
**Background:** [Research and learnings](research-and-learnings.md)

---

## 1. Product Scope and Delivery Order

On court, the player records any point in one tap: `US` wins a point for us, `THEM` wins a point for them, and `MY UE` wins a point for them while attributing it to my unforced error. The band works completely standalone with the phone disconnected. After play, the player inspects on-band stats and scans one Summary QR.

| Tier | Player Outcome | Stories |
| :---: | :--- | :--- |
| **P0** | Start, score, correct, leave, resume, finish on match point or at the booking buzzer, and scan a Summary QR on a physical Global Band 9. | `S0.1–S0.3`, `S1.1a–S1.1b`, `S1.2–S1.4`, `S2.0–S2.3`, `S3.1–S3.2`, `S4.1a–S4.1b` |
| **P1** | Add haptics and wake tuning, safe reset, paginated full-trace QR, and a single-file offline analyzer. | `S1.5`, `S3.3`, `S4.2–S4.3`, `S5.1a–S5.1b` |
| **P2** | Consider HR file correlation once a real timestamped export exists. Keep other parked ideas in Epic 6. | `S5.2`, `Epic 6` |

**Delivery Order:** First prove signed install, standalone use, and in-place upgrade on the target Global firmware. Measure storage and one-scan Summary QR on the band. Build the pure-JS score engine and crash-safe persistence, then wire the start screen and scoreboard. Close `P0` with a physical timed finish and a match-point correction. Full-trace pagination, offline analytics, and comfort tuning ship independently in `P1`.

---

## 2. Technical Reference

### Project & Module Contract
- Keep scoring and replay in `src/core/scoreEngine.js` and wire formats in `src/core/traceCodec.js`. Both use relative ES module imports with explicit `.js` extensions and zero Node, DOM, or Vela imports.
- Keep Node built-ins strictly in `tests/` or build scripts, and scope ESM configuration so CommonJS `aiot-toolkit` configuration still works.
- Use `src/app.ux` for lifecycle and single-flight storage integration, `src/manifest.json` for routing and features, and `src/pages/setup`, `src/pages/index`, and `src/pages/summary` for the three band views.

### Build, Manifest & Repo Hygiene
- Configure `"config": { "designWidth": 192 }`, `"minAPILevel": 2` (required for native `<qrcode>`), `router.entry`, and `router.pages`.
- Declare features **without** `@` in `src/manifest.json` (`system.storage`, `system.vibrator`, `system.brightness`) and use `@system.*` only in JS imports. Do not declare unnecessary device-info or health permissions.
- Commit lockfile, toolkit config, and synthetic fixtures. Ignore `/sign/`, `*.pem`, `*.key`, `*.p12`, `*.jks`, `*.keystore`, `*.rpk`, `/dist/`, `/build/`, `node_modules/`, `coverage/`, `.env*`, `captures/`, and `exports/`. Document disposable debug signing for clean clones and back up the stable release key outside Git.

### Six-Zone Layout (`192 × 490`, 325 ppi)
These heights are the initial wrist-test layout. Curved top/bottom caps narrow toward their tips; measure visible and touchable areas separately, especially for `Undo` and `Menu`.

| Top `y` | Height (Physical) | Contents |
| ---: | :---: | :--- |
| `0` | `60px` (~4.7 mm) | Clock, sets won by each team, live `MY UE` count |
| `60` | `140px` (~10.9 mm) | `US` points, games, and team serve dot |
| `200` | `48px` (~3.8 mm) | Mode (`GP` / `AD` / `TB` / `STB`) and `SWAP ENDS` cue |
| `248` | `112px` (~8.8 mm) | `THEM` points, games, and team serve dot |
| `360` | `66px` (~5.2 mm) | One-tap `MY UE` (`+1 Them` + log personal UE) |
| `426` | `64px` (~5.0 mm) | `Undo` and `Menu` inside the measured bottom-cap safe area |

### Match Record, Exclusive Counts & Finish Semantics
- Freeze `matchId`, monotonic `revision`, `startTime`, `GP`/`AD` rule, format, deciding-set rule, and opening serving team into each match record.
- Record one `{ t, code }` per accepted point (Unix seconds, injectable clock): `A` = we won, `B` = they won (other), `E` = they won via my UE.
  - `Our points = A` · `Their points = B + E` · `Total points = A + B + E`
  - **`My UEs / points lost`** = `E / (B + E)` (displays `—` when `B + E === 0`).
  - Attribute each `E` to the set and serving team **before** the point is applied.
- **Finish status and trace coverage are independent:** Persist `ACTIVE`, `WON`, or `FINISHED_MANUAL` plus `finishTime`. A manual finish can have a complete trace; `PARTIAL` strictly means point history exceeded `MAX_EVENTS`. Duration is elapsed time from Start to recorded finish (including court breaks). Reopening a manually finished match clears `finishTime`; finishing again records the new time.

### Strict QR Alphanumeric Contract
- Use a versioned payload restricted to the **QR Alphanumeric alphabet** (`0–9`, `A–Z`, space, `$%*+-./:` — **no commas**).
- Start physical tests at **61 chars** for Summary (QR V3 at EC-M, `5 px/module` incl. 4-module quiet zone on `192px`) and **90 chars** per full-trace page (QR V4 at EC-M, `4 px/module`). Because Xiaomi's `<qrcode>` does not expose EC level or margin controls, center a black-on-white square with quiet zone on all four sides and let the physical gate confirm the usable limit.

---

## 3. Epics and Acceptance Criteria

### Epic 0 — Hardware and Toolchain Gate (`P0`)

#### `S0.1` · `P0` · Reproducible Build and Shared Fixture
- [ ] From a clean clone, generate a disposable debug signing key, configure `src/manifest.json` + `src/app.ux` per Section 2, build the minimal app, launch the `192 × 490` emulator, and record preliminary cap measurements in `docs/hardware-notes.md`.
- [ ] Run one small pure-JS fixture through `node --test`, a bundled `.ux` page, and a local HTML file (using the same bundled source, networking disabled), confirming identical results.
- **Verify:** `Node`, `AIoT-IDE Emulator`, and local browser.

#### `S0.2` · `P0` · Install, Disconnect, and In-Place Upgrade
*Depends on `S0.1`.*
- [ ] In `docs/deploy-guide.md`, record exact Band 9 SKU, firmware version, phone OS, successful installer and version (evaluating official Mi Fitness dev deploy alongside AstroBox, Notify, and ADB), signing method, and repeatable steps. Timebox the install spike; if the Global unit cannot launch the signed package, record the failing step and stop band feature work.
- [ ] Repeat the checklist from a clean start: launch on the band, **disconnect the phone**, tap a counter, let the band sleep, and wake it. Install a higher `versionCode` of the same signed app in place and verify the saved test value survives.
- **Verify:** `Physical Global Band 9`. Keep one recorded install and upgrade run.

#### `S0.3` · `P0` · Measure the Limits the MVP Depends On
*Depends on `S0.2`.*
- [ ] Test and record separately: (1) normal sleep/wake, (2) watchface return + relaunch, and (3) process kill/reboot. Confirm whether synchronous `return true` in `onBackPress()` consumes swipe-back. Measure actual curved safe area on the wrist.
- [ ] Measure per-value and total `@system.storage` limits with synthetic records. Estimate `MAX_EVENTS` accounting for two recovery slots, defaults, and post-limit scoring/one-step Undo. Record byte counts (`S1.3` confirms with production format and measures replay on band).
- [ ] Render the longest candidate Summary (`<= 61` alnum chars) in a centered black-on-white `<qrcode>` in the straight screen section. On each of **two named phones**, achieve **≥ 9/10 scans within 2 seconds per attempt**, both indoors and in outdoor court lighting, comparing decoded text directly to the known input. Log firmware, payload, phones, lighting, attempts, and results.
- [ ] If scanning fails, shorten payload or adjust rendering and repeat. A passing one-scan Summary is required for `P0`. (Full-trace scan, haptics, and HR investigation live in their own stories.)
- **Verify:** `Physical Global Band 9` + two phones (using known fixtures so Epic 0 closes before codec/analyzer exist).

---

### Epic 1 — Pure-JS Rules, Trace, and Codecs (`P0` / `P1`)

#### `S1.1a` · `P0` · Score an Ordinary Game and Set
*Depends on `S0.2`.*
- [ ] Cover standard points (`0 → 15 → 30 → 40 → Game`), `GP` at `40–40`, and `AD` from deuce through advantage back to deuce and on to a win.
- [ ] Cover set progression: `6–4` wins, `6–5` continues, `7–5` ends the set, and `6–6` hands off to tie-break.
- [ ] Freeze a copy of match rules into each new match so changing saved defaults never alters an active or resumed match.
- **Verify:** Table-driven `Node unit tests` (`node --test`).

#### `S1.1b` · `P0` · Apply Match Formats and Manual Early Finish
*Depends on `S1.1a`.*
- [ ] Support `1SET` (ends after 1 set), `BO3` (ends at 2 sets won), `BO3+STB` (`BO3` with deciding `STB10` at 1–1 sets), and `FREE` (continuous normal sets with selected `GP`/`AD` rule until manual finish).
- [ ] Implement the canonical **90-minute manual-finish fixture** shared across engine, UI, and codec: finish at `6–4 | 5–4 | 30–15` (our perspective) with every completed game won to love → `A = 46`, `B + E = 33`; tag 2 losses in set 1 and 1 loss in set 2 as `E` → `B = 30`, `E = 3`, UEs per set = `[2, 1]`, duration = `5,400 s`, status = `FINISHED_MANUAL`, no winner. Also test a tied score and an unfinished tie-break.
- [ ] Test reopening a manual finish (**Resume match** restores every rally intact) separately from undoing a match-winning rally (**Undo last point** removes that winning rally).
- **Verify:** `Node unit tests` with an injected clock.

#### `S1.2` · `P0` · Tie-Breaks, Team Service, and Change of Ends
*Depends on `S1.1a–S1.1b`.*
- [ ] At `6–6`, first to 7 by 2 wins the set `7–6` (test `9–7`). Deciding `STB10`: `10–9` continues, `11–9` ends the match; store and display distinctly as an STB so it never renders as an 11-game set.
- [ ] Alternate serving **team** each ordinary game (v1 tracks serving team only, not individual doubles player order). For either tie-break opener, serve order by team is 1 point then blocks of 2 (`A, B, B, A, A, ...`), and the team that **received** the opening tie-break point serves first in the next set (where applicable).
- [ ] Set `changeEndsAlert` after odd total games in a set and every 6 tie-break points; clear on next point. Changing ends preserves `US`/`THEM` identity.
- **Verify:** Mirrored `Node unit tests` for both opening serving teams (per FIP Rules of Padel).

#### `S1.3` · `P0` · Compact Event Log, Undo, and Capacity Continuation
*Depends on `S1.2` and `S0.3` storage measurement.*
- [ ] One accepted scoring tap appends one `{ t, code }` event. Trace `[E]` produces 1 point lost, 1 personal UE, 1 total point, and `100%` `My UEs / points lost`; Undo restores empty score and `—`.
- [ ] Within `MAX_EVENTS`, Undo pops the last event and replays from match start—restoring points, games, sets, serving team, cue, UE counts, and active status across game, set, TB/STB, and match boundaries, both in-session and after restart. Measure replay latency at `MAX_EVENTS` on the physical band and confirm the next deliberate touch is accepted promptly.
- [ ] At the first event over `MAX_EVENTS`, keep the recorded prefix and persist live score, current serving team, match totals, per-set counts needed for Summary, and **one pre-point state for one-step Undo**. Display `"Trace full · score continues"` and mark subsequent exports `PARTIAL`. Show when earlier Undo is unavailable; a new point re-enables one-step Undo.
- [ ] Test the last event that fits, the first two over the cap, undo/replacement, restart, finish, and export. A partial full-trace export identifies its last recorded point; Summary totals include points played after the cap.
- **Verify:** `Node unit tests` (using a small cap) + measured-limit test on `Physical Global Band 9`.

#### `S1.4` · `P0` · One-Scan Summary Codec
*Depends on `S1.3` and `S0.3` scan measurement.*
- [ ] Define a versioned strict QR-alphanumeric encoder, reference decoder, and hand-checked example strings round-tripping start time, duration, rules, finish status, score (including live game/TB/STB), exclusive `A`/`B`/`E` totals, per-set `E` counts, and trace coverage. Derive a winner only for `WON` matches.
- [ ] Test: standard match, `6–4 | 5–4 | 30–15` manual mid-game finish, unfinished STB, 3-set match with 3-digit counts, and a `PARTIAL` match at capacity. Verify charset, max length, and one-scan budget.
- [ ] For long `FREE` sessions whose set lines exceed one QR budget, fall back to a clearly marked **compact Summary** (aggregate sets, current/last set & live points, duration, finish status, `A`/`B`/`E` totals, trace coverage), identifying omitted set detail in both views. Document representable numeric ranges and test the longest compact fixture.
- **Verify:** `Node unit tests` + `S0.1` cross-env fixture (including at least one hand-verified payload independent of the encoder).

#### `S1.5` · `P1` · Paginated Full-Trace Codec
*Depends on `S1.3–S1.4`.*
- [ ] Freeze the exported revision. Every page uses strict QR alphanumeric characters (`<= 90` chars incl. headers) carrying version, `matchId`, revision, `page/total`, and integrity checksum. Reassembled payload includes frozen rules, opening team, start/finish metadata, trace coverage, and recorded events.
- [ ] Quantize event times relative to match start in 5-second ticks and difference consecutive ticks (`0..Z` for `0..175s`). Specify rounding, `+` escape for gaps `> 175s`, and a deterministic backwards-clock policy (flagging affected time windows). Under a stable clock, reconstructed tap times stay within `±2.5s`.
- [ ] Test: zero/half ticks, `175s` and `180s` gaps, long sleep, clock jump, undo/replacement, shuffled pages, identical duplicates, missing/conflicting pages, mixed matches, mixed revisions, and checksum failures.
- **Verify:** `Node unit tests` + cross-env fixture (supplying known page fixtures to `S4.2` and `S5.1a`).

---

### Epic 2 — Match Start and On-Wrist Play (`P0`)

#### `S2.0` · `P0` · Set Rules and Confirm Opening Serving Team
*Depends on `S1.1b`, `S0.3`, and `S3.1`.*
- [ ] Prefill `GP`/`AD` and format defaults (first run: `GP`, `BO3`). At each new match, ask **"Who serves first?"** (`US` / `THEM`), display the selection beside `Start`, and restore a resumed match's saved choice.
- [ ] Start each match with its own frozen config. Provide **`Menu → Correct first serving team`** during active play, showing the current opener; saving commits a new revision for the same match and recomputes the serve dot and serve/return attribution while preserving scores, event order, timestamps, UE totals, and scoring rules.
- [ ] Test opener correction after a completed game containing an `E`, during a tie-break, after restart, on export, and in summary-only post-cap mode.
- **Verify:** `Node replay fixtures`, `AIoT-IDE Emulator`, and `Physical Global Band 9`.

#### `S2.1` · `P0` · Six-Zone Scoreboard Layout
*Depends on `S0.3` and `S1.3`.*
- [ ] Implement the 6-zone layout in Section 2 with clear visual hierarchy for Points, Games, and Sets for both teams on a `#000000` background, giving `MY UE` a distinct amber/orange accent.
- [ ] Verify worst-case strings on wrist outdoors: `AD`, `11–9`, `SWAP ENDS`, and `UE 100`. Check clipping, outdoor readability, and reachability of **both** bottom-cap controls (`Undo` and `Menu`); tune padding/hit areas against wrist measurements.
- **Verify:** `AIoT-IDE Emulator` + outdoors on `Physical Global Band 9`.

#### `S2.2` · `P0` · Score and Immediately Correct a Point
*Depends on `S2.1` and `S3.1`.*
- [ ] Keep scoring locked until stored state hydrates. Each tap gesture logs at most one event. Apply a `350 ms` duplicate-tap guard on the same scoring control; a wake-only touch or swipe across a scoring zone records zero points.
- [ ] **`THEM → Undo → MY UE`** must succeed even inside the `350 ms` window: Undo clears the previous scoring debounce, giving the replacement its accepted tap time so their score increases by 1, UE count increases by 1, and trace gains exactly one `E`.
- [ ] Test adjacent `THEM`/`MY UE` taps, zone boundaries, immediate correction across a game boundary, and match-point correction (tap `THEM` on match point → `Undo last point` from Match Over → tap `MY UE` → finishes again with identical final score and +1 personal UE).
- **Verify:** Deterministic input tests + `Physical Global Band 9` on wrist.

#### `S2.3` · `P0` · Serve, Swap, and Action Acknowledgement Cues
*Depends on `S2.2` and `S1.2`.*
- [ ] Display the team serve dot, `GP`/`AD`/`TB`/`STB` mode, `SWAP ENDS` cue, and live `MY UE` count.
- [ ] Briefly flash a distinct visual acknowledgement for `US`, `THEM`, `MY UE`, or `Undo`; confirm a rejected duplicate tap produces no acknowledgement.
- **Verify:** `AIoT-IDE Emulator` + `Physical Global Band 9` across a game and tie-break.

---

### Epic 3 — Resilience and Comfort (`P0` / `P1`)

#### `S3.1` · `P0` · Single-Flight Save, Crash Recovery, and Resume
*Depends on `S0.3` and `S1.3`. Implement in two increments:*
- [ ] **Writer & Recovery:** Single app-level writer in `src/app.ux` with at most one `@system.storage` write in flight, coalescing pending updates to the latest revision. Alternate two slots with validity checks and monotonic revision ordering that survives `New Match`. Load the newest valid committed revision on restart; visibly indicate pending/failed saves and retry with latest state when storage succeeds.
- [ ] **On-Band Integration:** Lock taps during hydration and route restored `ACTIVE` or finished matches to the matching view. Test rapid `A → E → Undo`, failed write, termination before commit, corrupt newest slot, and `New Match` while an older write is in flight. (An uncommitted tap may be lost on sudden power loss; every confirmed committed save must survive.)
- **Verify:** `Node unit tests` with deterministic controllable async storage mock + `Physical Global Band 9`.

#### `S3.2` · `P0` · Protect Against Accidental Exit
*Depends on `S0.3`, `S2.2`, and `S3.1`.*
- [ ] During active play, synchronously consume the first supported swipe-back in `onBackPress()` and show confirmation. Confirmed exit waits for the current revision to commit; on failure, keep the scoreboard open and offer retry.
- [ ] Verify swipe-back, screen-off, watchface return, and process kill separately (relying on `S3.1` for OS interruptions).
- **Verify:** `Physical Global Band 9`.

#### `S3.3` · `P1` · Haptics and Screen Wake Tuning
*Depends on `S0.3` and `S2.3`.*
- [ ] Verify `short`/`long` `@system.vibrator` modes on target firmware: pair `short` with normal points/`Undo` and `long` with `MY UE` or game/set win (one cue per action, alongside the visual flash).
- [ ] If the QuickApp resumes cleanly after sleep (`S0.3`), default to normal screen sleep. If needed, provide a visible-only `Keep Awake` Menu toggle using `brightness.setKeepScreenOn`, always releasing it in `onHide` and `onDestroy`. Record battery start/end % over a 30–60 minute session in `docs/hardware-notes.md`.
- **Verify:** `Physical Global Band 9`.

---

### Epic 4 — Finish, Export, and Reset (`P0` / `P1`)

#### `S4.1a` · `P0` · Finish, Inspect Stats, and Recover a Mistake
*Depends on `S1.1b`, `S2.0`, `S2.2`, and `S3.1`.*
- [ ] Auto-open Match Over on a match-winning rally. At any live score, `Menu → Finish Now` opens confirmation (`Cancel` returns to the exact rally; `Confirm` saves `FINISHED_MANUAL` and opens Match Over).
- [ ] Display set lines, any live points or TB/STB, finish reason, duration, and UEs per set within recorded detail. Label exclusive counts `Us`, `Them (other)`, and `My UE`, plus `My UEs / points lost` (`—` if 0 lost). Clearly indicate `PARTIAL` coverage or compact Free Play summary when applicable.
- [ ] After a win, **`Undo last point`** reopens play and removes the winning rally. After a manual finish, **`Resume match`** reopens play with **every rally intact** (regular Undo can then remove a rally if desired). **`New Match`** launches `S2.0` and safely supersedes the finished match.
- **Verify:** Canonical `6–4 | 5–4 | 30–15` manual-finish fixture + match-point `B → Undo → E` correction + band relaunch after both finish paths.

#### `S4.1b` · `P0` · Scan the Summary QR and Close the MVP
*Depends on `S4.1a` and `S1.4`.*
- [ ] Open Summary QR from either finish path and from a restored finished match. Render centered black-on-white `<qrcode>` in the straight screen section; scanned text must match on-band stats and fixture (including partial game score, finish reason, duration, and `E` counts).
- [ ] **End-to-End Physical MVP Release Run (phone disconnected during play):** Pick opening server → score `A`/`B`/`E` → sleep/leave → resume → undo → finish a timed match mid-game → reconnect/scan with phone. Repeat the match-point `THEM → Undo → MY UE` correction case. Run the `S0.3` 2-phone indoor/outdoor scan protocol on the **longest production Summary**.
- **Verify:** `Physical Global Band 9` + two phones. Archive fixture, expected output, scanned text, and hardware info.

#### `S4.2` · `P1` · Paginated Full-Trace QR on the Wrist
*Depends on `S1.5` and `S4.1b`.*
- [ ] Freeze one revision when opening Full-Trace QR. Render `Page 1 / N`, `Prev`, and `Next`, marking truncated prefixes `PARTIAL` with coverage info. Run the `S0.3` scan protocol on the longest production trace page and record the usable limit.
- [ ] Scan all pages of a 100+ point fixture off the band, reassemble via `S1.5` reference decoder, verify exact match, and record page count + elapsed scan time to evaluate courtside practicality.
- **Verify:** `Physical Global Band 9` + phone (final `P1` integration pastes these captured pages into `S5.1a`).

#### `S4.3` · `P1` · Safe Two-Step Reset
*Depends on `S2.0` and `S3.1`.*
- [ ] Place `Reset Match` inside `Menu` (separated from `Undo`). `Cancel` keeps the live match; `Confirm` discards it and opens `S2.0`. Test with an earlier save still in flight and relaunch to prove the old match stays discarded.
- **Verify:** `AIoT-IDE Emulator` + `Physical Global Band 9`.

---

### Epic 5 — Offline Analysis (`P1` / `P2`)

#### `S5.1a` · `P1` · Decode Scanned Text Offline and Export
*Depends on `S1.4` and `S1.5` (develop in parallel with `S4.2` using fixtures).*
- [ ] Ship one self-contained local HTML file with shared engine/codec bundled inside, opening from disk with network disabled.
- [ ] Summary paste displays all encoded fields and coverage. Full-trace paste validates `matchId`, revision, page completeness, and checksum; accepts shuffled pages and identical duplicates; clearly identifies missing/conflicting pages or mixed revisions while preserving pasted text for correction.
- [ ] Download decoded data as `match.csv` or `match.json` with explicit coverage metadata.
- **Verify:** `Node unit tests` + offline browser (then repeat with real captured scans from `S4.2`).

#### `S5.1b` · `P1` · Explain Recorded Unforced Errors
*Depends on `S5.1a` and `S1.2`.*
- [ ] Replay a hand-scored fixture and classify each `E` from the **pre-point** score and serving team: `40–40` GP, break point, set point, and tie-break (allow overlapping labels while counting each event once in totals).
- [ ] Show UEs while our team served vs received. Define **service hold rate** as `completed ordinary service games won / completed ordinary service games served` (`—` at zero opportunities; exclude incomplete games and tie-breaks from denominator).
- [ ] Define a **UE cluster** as `>= 2` `E` events within `3` consecutive points (merging overlapping windows). For each 15-minute elapsed window, show observed `E / (B + E)`, points lost, and total points `n` (strictly observational wording).
- [ ] Compute point-level metrics strictly over the recorded prefix, display coverage, and flag time windows affected by clock discontinuities. Summary-only input shows aggregate stats only.
- **Verify:** Expected-results table covering 1-event `[E]`, deciding point, incomplete game, empty time window, and truncated trace (`Node` + offline browser).

#### `S5.2` · `P2` · Heart-Rate Timestamp Join
*Entry Gate: One real timestamped HR export from a named source with verified units, timezone offset, sampling interval/gaps, and overlap with a test match.*
- [ ] Join match points/UEs to the nearest HR sample within a documented tolerance window, marking gaps as `missing` (no silent interpolation).
- [ ] Display observed match Avg/Max HR and HR on `MY UE` vs non-UE points (with sample counts), and export merged CSV.
- **Verify:** `Node unit tests` with a sanitized fixture derived from the real export.

---

### Epic 6 — Parked (`P2`)
2026 FIP **Star Point**, individual doubles server order, live on-band HR *(only revisited if `S0.3` uncovers a usable API)*, post-match context tags (side of court, effort `1–5`), Partner UE / Winner / Net-vs-Glass buttons, on-band match history, companion phone app (`@system.interconnect`), and other band/watch screen sizes remain parked in `P2`.

---

## 4. Definition of Done

| Applies To | Evidence Required |
| :--- | :--- |
| **Every story** | Each acceptance example has an expected result, declared verification method, and recorded pass. Tag hardware records with SKU, firmware, and build. |
| **Shared JS** | `node --test` passes with deterministic fixtures; `src/core/` uses relative `.js` ES imports with zero Node/DOM/Vela dependencies. Re-run the cross-environment fixture whenever shared code or bundling changes. |
| **Band UI / hardware** | Signed `.rpk` builds cleanly; emulator checks pass for affected views; physical checks pass for behaviors named in the story with recorded inputs, results, and limits. |
| **Persistence & wake** | `S3.1`/`S3.2` verify commit, failure, and recovery; `S3.3` verifies `keepScreenOn` release on `onHide`/`onDestroy`. Re-run whenever persistence or wake code changes. |
| **`P0` release** | Pass `S4.1b` end to end with both finish paths and the `S0.3` scan threshold on the longest production Summary. Reopen a manual finish with its last rally intact, and attach a decoded scan agreeing with the expected score. |

---

## 5. Risk Register

The implementing developer records measurements; the backlog owner decides device or scope changes. Re-run hardware checks after firmware or renderer updates.

| Risk & Exposure | Trigger / Evidence | Owner Action |
| :--- | :--- | :--- |
| **Global firmware blocks install/upgrade** · *Med / Crit* | Signed minimal `.rpk` fails clean `S0.2` run or in-place upgrade loses saved test value. | Developer logs SKU, firmware, signer, and failing step. Owner decides whether to change target before band feature work. |
| **Summary fails to scan outdoors** · *Med / High* | Any named phone/lighting case misses `S0.3` 9/10 threshold or decodes altered text. | Developer adjusts size, quiet zone, or payload and retests; `P0` stays open until all pass. Trace-page scan runs in `P1`. |
| **Stale or corrupt write wins** · *Med / High* | Crash, mid-write reset, or corrupt newest slot recovers wrong committed revision. | Developer reproduces callback order in `S3.1`, fixes writer/recovery, and repeats on band. |
| **Stored match exceeds quota** · *Med / High* | Two slots + worst-case record breach measured quota or post-cap Undo fails. | Developer reserves headroom, lowers `MAX_EVENTS`, and retests scoring, resume, one-step Undo, and `PARTIAL` export. |
| **Mis-taps or unreachable cap controls** · *High / Med* | Wrist run drops `THEM → Undo → MY UE`, scores a swipe, or misses bottom-cap `Undo`. | Developer adjusts hit areas/debounce in `S2.1–S2.2` and repeats on wrist. |
| **Wrong serving team biases stats** · *Med / Med* | Correcting opener alters a score or leaves serve dot/splits stale. | Developer replays mirrored `S1.2`/`S2.0` fixture and verifies corrected revision after restart. |
| **Long breaks or clock jumps distort time** · *High / Med* | `> 175 s` gap overflows, clock moves backwards, or stable-clock tolerance fails. | Developer tests `+` escapes, preserves event order, and flags affected windows in `S1.5`/`S5.1b`. |
| **Full-trace multi-QR is impractical** · *Med / Med* | Player abandons 100+ point scan or loses track of pages. | Developer records page count, retries, and total scan time; owner decides whether to shorten export or improve navigation. |
| **HR not available in a real export** · *Med / Med* | No timestamped HR export overlaps a test match. | Leave `S5.2` parked until the entry fixture exists. |
