# Research & Spike Learnings — Padel Scoreboard for Xiaomi Smart Band 9 Active

## 1. Hardware Discovery (`S0.2` Go/No-Go Gate Result)
During `S0.2` physical testing, the target band was identified as the **Xiaomi Smart Band 9 Active** (`172 × 320` TFT LCD, closed lightweight proprietary RTOS)—not the standard Xiaomi Smart Band 9 (`192 × 490` AMOLED, Xiaomi Vela OS).

- **Native `.rpk` QuickApps:** **Not supported** on Xiaomi Smart Band 9 Active (no Vela QuickApp runtime; confirmed by both Notify for Xiaomi `"update failed this band model may not support this feature yet"` and BandBurg device identification).
- **Vela `.rpk` gate verdict:** **No-Go** for Band 9 Active. The early hardware gate worked as intended and prevented weeks of wasted Vela UI work.

---

## 2. Pivot Architecture — Proven Live on Hardware!

### Options Explored for Band 9 Active (Zero Sideloaded APKs)
| Option | How It Works | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **A. Android Chrome Offline PWA (`navigator.mediaSession`) + Band Music Controls** | Phone in court bag runs an offline PWA playing a 10s ultra-quiet looping WAV; Band 9 Active's native **Music Control** screen displays live score (`title` + `artist`) and sends `Prev` / `Play-Pause` / `Next` taps back to JS. | **Zero APKs**, zero Play Store installs, works **with phone screen locked**, works **during a native Band 9 Active Workout** (real continuous Heart Rate!), full match trace stored directly on phone (no QR export needed!), ultra-lean Docker dev container. | Needs phone within Bluetooth range (~10–15 m, e.g., court bag on bench); 3 wrist buttons (`Prev`, `Play/Pause`, `Next`) mean Undo uses a button combo/gesture or phone screen; must guard against Android battery killer on 90-min sessions. | **Selected** |
| **B. Native Android Companion App (APK)** | Custom Kotlin MediaSession app. | Full Android background foreground-service control. | Requires building & sideloading an APK (rejected by user policy) + Android SDK/Gradle bloat. | **Rejected** |
| **C. Phone-Only PWA (No Wrist Control)** | Score only on phone screen on bench. | Simple. | Must walk to phone after points. | **Subsumed by Option A** (Option A also has a full phone touchscreen UI!) |

---

## 3. Empirical Learnings from Live Hardware Spike (Band 9 Active + Android Chrome)

### Verified Live Behaviors
1. **Chromium `>= 5s` Audio Threshold (Caught in Spike!):** Chrome on Android **suppresses** the Android MediaSession notification for `<audio>` clips shorter than 5 seconds (`2s` WAV failed; **`10s` WAV** with real PCM sine amplitude at `audio.volume = 0.005` + `setPositionState` immediately registered the MediaSession and mirrored onto the Band 9 Active!).
2. **Android Companion Prerequisite:** Only **one** companion app (**Mi Fitness**) should hold Bluetooth to the band, with **Android Notification Access** enabled for Mi Fitness and Chrome notifications enabled.
3. **Phone Locked Operation:** Verified **working** — `Prev`, `Next`, and repeated `Play/Pause` all fired reliably and pushed updated metadata to the wrist while the Android phone remained locked.
4. **Mid-Workout Operation (Major Upgrade Over Vela!):** Verified **working** — starting a native Band 9 Active Workout (continuous Heart Rate + calories) and swiping right to **Music Controls** allows scoring and logging `MY UE` while natively recording real workout vitals!
5. **Two-Line Wrist Display:** Verified **both `title` and `artist`** lines display on the Band 9 Active Music Control screen, with acceptable wrist-update latency.

### Open Ergonomic Details to Measure in Epic 0
1. **Exact Character Width:** Measure how many characters fit on Band 9 Active's `title` and `artist` lines before horizontal scrolling or truncation so our live score format stays readable at a 1-second glance.
2. **90-Minute Lock-Screen Survival:** Test whether Chrome's MediaSession + 10s looping audio survives a 30–90 minute locked session on the user's Android phone without Doze/battery optimization killing it (document "Unrestricted" battery setting for Chrome if needed).
3. **3-Button Wrist Mapping & Undo Ergonomics:** With 3 reliable wrist buttons (`Prev`, `Next`, `Play/Pause`), validate the cleanest mistake-proof mapping for `US +1`, `THEM +1`, `MY UE`, and `Undo` (e.g., double-tap `Play/Pause` vs explicit `Prev+Next` or Undo-via-double-tap-Play/Pause).
4. **Offline PWA Delivery:** Serve over HTTPS (e.g., GitHub Pages or local HTTPS/localhost) with a Service Worker + Web App Manifest so Chrome **"Add to Home Screen"** runs 100% offline on court with zero mobile data required.

---

## 4. Padel Domain & Core Engine Learnings (Unchanged & Reusable!)
- **Pure-JS Core (`src/core/`):** Decoupled ES modules with zero browser/DOM imports (`node --test`), keeping scoring rules, tie-breaks, team server rotation, side-change cues, exclusive `A`/`B`/`E` denominators (`My UEs / points lost = E / (B + E)`), manual `"Finish Now"` (`FINISHED_MANUAL`), and event-log replay Undo 100% testable on PC.
- **No QR Code Needed:** Because the match lives directly in the phone's `localStorage`, post-match analysis, multi-match history, and 1-tap `match.csv` / `match.json` download happen right inside the same PWA!

---

## 5. `S1.1–S1.3` Core Engine & Wrist Formatter Spike Learnings
- **Single Source of Truth (`events[]` + Pure Replay):** Storing an immutable match record `{ schemaVersion, matchId, revision, config, startTimeMs, finishTimeMs, status, nextEventId, events }` and deriving all live score, tie-break state, server, `changeEndsAlert`, exclusive `A`/`B`/`E` counts, per-set UEs, and serve/return UE attribution via pure `deriveMatchState(record)` guarantees zero score/trace drift and effortless full-match Undo + `Correct first serving team`.
- **Independent Monotonic `revision`:** Every state-mutating command (`addPoint`, `undoLastPoint`, `correctInitialServer`, `finishManual`, `resumeMatch`) increments `revision` by 1; no-op calls (e.g., Undo on 0 events, setting same opener) return the same record without bumping `revision`.
- **Compact 2-Line Wrist Strings:** Using `*` directly beside the serving team's points (`*30-15`, `AD-40*`) and `#rev` keeps worst-case active strings within **14–15 characters** per line (e.g., `*10-10 TB #128` / `S1-1 UE:100 SWP`), leaving comfortable headroom under the provisional 20-char budget.
- **Test Fixture Subtlety Caught:** Simulating a `6–4` set requires interleaving games (`4-4`, then `6-4`) rather than 6 straight games (which ends Set 1 at `6–0` and spills the remaining 4 games into Set 2!).

---

## 6. `S1.4` Web Lock, Commit Pipeline & Diagnostic Log Spike Learnings
- **Web Lock Lifetime & Async Release:** `navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, cb)` holds the lock only while the Promise returned by `cb` remains pending. `releaseWriter()` must be `async` and await the outer `locks.request(...)` Promise so the lock is actually released before a successor tries to acquire it.
- **Secure Context Requirement:** `navigator.locks` exists only in Secure Contexts (`https://` GitHub Pages, `http://localhost`). Injecting `{ storage, locks }` into pure `src/core/matchStore.js` keeps `src/core/` 100% browser-free for `node --test` and allows explicit `LOCK_UNAVAILABLE` read-only fallback if ever opened on plain LAN HTTP.
- **Save-Before-Publish Separation:** Separating `storage.setItem` errors (`stage: 'save'`, rolls back / keeps prior state, withholds wrist publish) from `publishWrist` errors (`stage: 'publish'`, keeps committed state so `Re-link Wrist` republishes without re-scoring or bumping `revision`) guarantees zero phantom or lost points.
- **Separate Bounded Diagnostic Key:** Storing disruption diagnostics in its own bounded key (`padelScore.diag.v1`, FIFO cap e.g. 200 entries) ensures diagnostic write failures never block a match save, and evidence survives Chrome termination.

---

## 7. `S2.1–S2.2` Mobile UI & `MediaSession` Wrist Bridge Spike Learnings
- **In-Memory 10-Second PCM WAV Blob (`160,044` bytes):** Generating a 10-second 8 kHz 16-bit mono PCM sine wave (`amplitude = 120`, played at `audio.volume = 0.005`) in pure JS takes ~10 ms, produces a valid RIFF/WAVE payload with non-zero PCM samples (avoiding Chrome's `< 5s` MediaSession suppression), and avoids HTTP 206 byte-range issues completely when running offline.
- **Separate Command Arming From Final Metadata Publish:** When a live match transitions to `WON` or `FINISHED_MANUAL`, clearing `navigator.mediaSession` action handlers synchronously in `onStateChange` immediately disarms wrist scoring, while allowing the queued `publishWrist` job to publish one final `WIN`/`LOSS`/`END` `MediaMetadata` snapshot and then pause the keep-alive audio.
- **Unlinked Phone Scoring Must Stay Error-Free:** When the wrist bridge is `DISARMED` or `INTERRUPTED` (e.g., after a page reload or phone call), `publishWrist` skips `MediaMetadata` updates instead of throwing—so on-phone scoring never flashes false publish errors, while real `MediaMetadata` failures when `ARMED` still surface `lastPublishError`.
- **Guarding Against Audio Focus Loss & Phantom Points:** Ordinary `<audio>` DOM events (`play`, `playing`, `pause`, `ended`, `error`) only sync `playbackState` and detect unexpected interruptions (`status = 'INTERRUPTED'`)—they never score or auto-arm. Inside `MediaSession` callbacks, checking `status === 'ARMED' && !audio.paused && !audio.ended` provides an extra defense if Android pauses audio during a call or notification before delivering a stale callback. Screen lock (`visibilitychange` → `hidden`) intentionally leaves the bridge armed.
- **Preserving User-Gesture Activation on `Start Match`:** Because `matchStore.startNewMatch()` writes to `localStorage` synchronously before returning its Promise, tapping `Start Match` can commit revision 1 and invoke `audio.play()` synchronously inside the same click handler—linking the wrist in one tap while still falling back cleanly to phone-only scoring if `audio.play()` rejects.

---

## 8. Real-Court Amateur Padel Feedback Learnings
- **Advantage (`AD`) Is Primary:** Amateur matches play standard Deuce (`40-40`) ↔ Advantage (`AD-40` / `40-AD`) until a team wins a point while holding `AD`. Keeping both `AD` (default) and `GP` (Golden Point) selectable on Setup and frozen into `record.config.scoringMode` preserves backwards compatibility while matching real court play.
- **Watch-Selectable First Server (`initialServer: null` before first point):** Players decide who serves first with a 4-touch warmup rally on court *after* putting the phone in the bag. Allowing `config.initialServer = null` strictly while `events.length === 0` lets the watch display `WHO SERVES? #1` / `< US   THEM >`, where `Prev` (`US`) or `Next` (`THEM`) sets the opener (incrementing `revision` to `#2` without adding a point) and Center (`E`) is safely ignored until the opener is chosen.
- **Low-Noise Side-Change Display:** Amateur matches switch ends only at set breaks and do not need odd-game `SWAP`/`SWP` alerts cluttering the phone screen or Band 9 Active's tight `artist` line (`showSwap: false` default frees characters for `S1-1 UE:12`).

---

## 9. `S5.1–S5.2` Match History, UE Analytics & Export Spike Learnings
- **Simulation-Based Pre-Point Clutch Classification:** Running the pure `reducePoint()` on hypothetical `'A'` and `'B'` outcomes against pre-point `state` classifies `breakPoint` (returner wins ordinary game) and `setPoint` (either team finishes a set) identically across `AD`, `GP`, and `6–6` tie-breaks with zero duplicated rule logic. Overlapping labels are tracked per label while `clutchUeTotal` counts each unique clutch `E` event once.
- **Exact UE Cluster Equivalence (Verified Across All 1,024 10-Point Patterns):** Merging overlapping 3-consecutive-point windows containing `>= 2` `E` events (trimmed to `[firstE .. lastE]`) is mathematically identical to grouping consecutive `E` indices where `idx[k] - idx[k-1] <= 2` and keeping groups of size `>= 2`.
- **Ordinary Service Hold Rate Isolation:** Checking `!preState.inTieBreak` plus `(postState.games sum changed || postState.setHistory.length increased)` cleanly counts only completed ordinary service games served by US, automatically excluding incomplete games and tie-breaks.
- **Bounded 15-Minute Elapsed Windows & History Isolation:** Clamping negative clock skew to `0`, emitting contiguous buckets `0 .. maxBucket` (with a sanity cap against huge outlier timestamps) preserves empty intermediate windows (`—`), while storing archived finished matches under a separate key (`padelScore.history.v1`, upserted by `matchId`, removed if reopened via Undo/Resume) guarantees history quota errors never block active match scoring.

---

## 10. `S4.2` Explicit `EDIT #<rev>` Wrist-Undo Mode Spike Learnings
- **3-State Machine (`LIVE` → `PROMPT` → `AWAITING_LIVE` → `LIVE`):** Unifying post-confirmation (`UNDO` / `UE`) and stale/phone-edit/Cancel invalidation (`INVALIDATED`) into one `AWAITING_LIVE` gate state keeps the state machine tiny, guarantees repeated or late `Prev`/`Next` arrows are consumed without scoring until `Center` on the band returns to live scoring (phone `Cancel` dismisses the prompt into `AWAITING_LIVE(INVALIDATED)` while keeping phone controls live), and avoids silent one-shot tap swallowing minutes later.
- **Synchronous Commit Ownership Tracking:** Because `matchStore.commit()` invokes `onStateChange` synchronously before returning, tagging wrist-initiated `EDIT` commits (`pendingWristEditCommit`) distinguishes our own `UNDO`/`UE` transition (`AWAITING_LIVE` with `UNDO`/`UE` confirmation) from an external phone edit (`AWAITING_LIVE` with `INVALIDATED`) and ensures a failed storage write never transitions to a false `UNDO`/`UE` confirmation.
- **Revision-Pinned Wrist Overlay:** Binding `EDIT` display overlays strictly to `editState.matchId === record.matchId && editState.baseRevision === record.revision` keeps `EDIT #42` / `<UNDO   UE>` ephemeral (zero `localStorage` writes or revision bumps on prompt open/close) while ensuring queued stale publishes never show mismatched overlays.

---

## 11. Phone UI & UX Redesign Spike Learnings (Floodlit Indoor Padel + Band 9 Active)
- **Physical Testing Validated the Wrist Workflow:** Live testing on Android Chrome + Xiaomi Smart Band 9 Active confirmed that `EDIT #rev` (`Center → < UNDO / UE > → Center`) works cleanly on court and is preferred as the default `wristCenterMode` (with `1-Tap MY UE` still selectable).
- **Rejecting the Generic Dark-Card Shell:** The v0 phone UI suffered from four concrete UX flaws: (1) developer jargon exposed in player chrome (`WRITER · LIVE`, `FINISHED_MANUAL`, `(A)/(B)/(E)`), (2) stacked banners pushing live score buttons below the fold on mobile viewports, (3) zero visual onboarding showing how `<`, `||`, `>` on Band 9 Active actually map to each game state, and (4) identical 2×2 stat cards + plain tables on Match Over that hide *when* UE clusters happened.
- **Subject-Derived Design System (Indoor/Evening Floodlit Court):** Grounding the entire interface in deep floodlit WPT court blue (`#081B38` / `#0D2C5C`), crisp white painted court lines, floodlit-vs-shadowed half-court serve lighting, optic-yellow ball highlights (`#E2FF3D`) for active/serve/primary CTA, and coral-red (`#FF5C4D`) strictly for personal Unforced Errors (`MY UE`) and errors gives every color an unambiguous physical meaning instead of decorative SaaS polish.
- **Self-Teaching Band Hardware Mirror & Rally Tape:** Rendering a compact 1:1 Band 9 Active capsule with live `<`, `||`, `>` button labels that update dynamically across Setup, Warmup, Live, `EDIT #rev`, and `AWAITING_LIVE` makes the entire 3-button wrist workflow understandable in 3 seconds without reading a manual. On Match Over and History Detail, a pure inline SVG **Match Rally Tape** plots every rally across the net line with coral `MY UE` spikes, cluster brackets, and set dividers — zero charting libraries, 100% offline.
- **UI State Preservation Invariants:** Keep `[data-duration-text]` updated in place without rebuilding DOM controls on the 1-second timer, keep pure `src/core/` untouched except making `EDIT_MODE` the default in `normalizeWristCenterMode`/`DEFAULT_MATCH_SETTINGS`, and keep a pure testable view-helper module for Band button legends and Rally Tape SVG geometry so UI logic stays covered by `node --test`.
- **Visual Clarity & Service Worker Discovery:** Inspecting the live PWA revealed two critical UX blockers: (1) existing open tabs keep the old waiting Service Worker active indefinitely with no user-facing update prompt, hiding newly deployed UIs; and (2) boxing every panel, keycap, button, and stat with `1.5px` borders creates ~25 competing outlines and pushes `Start Match` below the fold on `360 × 740`. Stripping outer card wrappers, replacing boxed forms with hairline-divided court-surface controls, and adding a safe user-triggered `SKIP_WAITING` update strip (never mid-rally) fixes both.
- **Multi-Window Service Worker Rollout Note:** Inside a waiting Service Worker, `clients.matchAll({ type: 'window', includeUncontrolled: true })` (filtered to `self.registration.scope`) is required to detect open v1 tabs controlled by the prior worker. Tabs already running `3451937` or earlier have no in-app update button, so the first upgrade past `3451937` requires finishing any match, closing all PadelScore tabs/windows once, and reopening; all subsequent releases use the one-tap multi-window-safe update prompt.

---

## 12. TV Scoreboard Overhaul, M3/HIG Color System & Set Flow Spike Learnings
- **One Question Per Screen & Broadcast TV Scoreboard Grid:** Players look at the phone before the match (*"Am I ready?"*), between games (*"What's the score and who serves?"*), and after the match (*"How did I play?"*). Replacing split half-court tiles with a standard broadcast grid (`Team | S1 | S2 | PTS`, one row per team, serve dot `●` on the serving row, subtle serving-row tint, vertical divider before `48px` `PTS`) reads sets, games, points, and server in one glance and fixes Ended Early displays on Result without 3-line prose.
- **Anti-AI-Slop Rules & Authoritative Dark Color System (Google M3 HCT + Apple HIG + Radix OKLCH):**
  - Eliminated decorative `4px` colored left borders, neon translucent ghost buttons, pure-white `#FFFFFF` halation, and colliding semantic meanings (`MY UE` and `Danger` previously shared the same fill; `US` and `THEM` used two nearly identical blues).
  - Adopted M3 tonal dark surfaces with cool-slate neutral chroma (`Tone 4` `#0C0E12` recessed wells → `Tone 6` `#111318` canvas → `Tone 12` `#191C22` cards → `Tone 17` `#23272F` utility keys, `8%` hairlines, `#F2F4F7` primary ink, `#9AA3B2` secondary ink).
  - Matched OKLCH perceptual lightness across teams (`US` Emerald-Teal `#1A4A3E`/`#4CC39A` and `THEM` Cobalt Slate-Blue `#1E3E66`/`#6BA4E8`, both `L ≈ 0.36` pads / `L ≈ 0.73` data) so the bright `#F2F4F7` score numerals stay the 1st read.
  - Strictly one color per meaning: **Optic Volt `#D9EA4E`** (`#111318` ink, `14.1:1`) exclusively for the serve dot, primary CTA, and Band Edit/Resume action cues (never for Break markers); **M3 Crimson `#A9362C` / Red 80 `#F28B82`** (`#FDF7F6` ink, `6.09:1`) exclusively for personal `MY UE`; **Outlined Coral `#F28B82`** (transparent fill) exclusively for destructive actions (`Finish Match Early`, `Delete`); neutral chalk `#EAECEF` for active segmented switches and neutral high-contrast ink for Break markers.
- **Mobile Ergonomics (Material 3 `48dp`, Fitts's Law, Gestalt Proximity, Concentric Radii):**
  - Sized Live scoring pads generously (`96px` `US +1` / `THEM +1`, `64px` `MY UE`) and added a `16px` Gestalt separation gap above visually quieter `48px` `Undo` / `Menu` utilities to prevent sweaty-thumb mis-taps.
  - Enforced `48dp` minimum hit areas everywhere (turning tiny inline links into `48px` tappable rows, `56px` M3 topbar with `48×48px` icon buttons, `54–56px` primary CTAs, `48px` CSV/JSON export buttons) and strict concentric nested radii (`Outer − Padding`, e.g., `12px` tray − `4px` padding = `8px` inner pill).
- **Result Analytics — Cohesive UE Ring Card + Set Flow Ladder + Broadcast Point Matrix:**
  - Replaced the rejected barcode Rally Tape and Momentum Wave with two clean modules inside the same matte card grid: (1) a **My Unforced Errors Telemetry Card** combining a `68px` SVG precision ring gauge, ratio (`16 of 48 points lost`), deterministic 1-line takeaway, proportional bar, and 3-column tabular readout; and (2) a **Set Flow Ladder** (Wimbledon/Google Sports 2-row cumulative game matrix) with **numeric UE counts** (scaling cleanly to infinite UEs in marathon deuce games instead of dot overflow), **sticky left team column + horizontal scroll** for `>8` game sets (including `7–5` and 13-game `7–6` Tie-Break sets with `TB`), and a **Sticky Dual-Row Broadcast Point Matrix** (`15`, `30`, `40`, `AD`, `G` + `UE` marker row) for any tapped game.
- **Visually Guiding Band Help:** Added a 3-icon directional pre-court strip (`1. Start → 2. Music → 3. Lock`), recessed OLED Band 9 Active schematics with color-coded `<` / `||` / `>` circular physical buttons (matching phone colors and showing dashed `Locked` arrows on Step 4), and collapsible troubleshooting, while strictly keeping the server-picker step conditional on `showWarmupStep` so fixed-server matches never instruct a player to tap `>` as a no-point picker.










