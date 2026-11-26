# Product & Technical Backlog — Xiaomi Smart Band 9 Active Padel Scoreboard (Offline Android Chrome PWA)

**Target:** Xiaomi Smart Band 9 Active (native Workout + Music Control screen) + Android Chrome Offline PWA (`navigator.mediaSession`)  
**Audience:** A mid-junior developer  
**Background:** [Research and learnings](research-and-learnings.md) · [Hardware notes](hardware-notes.md)  
**Archived Vela Toolchain:** Git tag `vela-s0.1-archive`

---

## 1. Product Scope and Delivery Order

On court, the player runs a **native Xiaomi Band 9 Active Workout** (recording real continuous Heart Rate and calories), swipes right to the built-in **Music Controls** screen, and controls an **offline Android Chrome PWA** sitting locked in their court bag—with **zero sideloaded APKs**. The band displays the live score and short revision marker across `title` and `artist`; the phone records every point and personal Unforced Error (`MY UE`) with UTC timestamps for instant post-match review.

### Delivery Order (Field-Test Driven)
1. **`P0` · Preserve Baseline & Offline Shell (`Epic 0`):** Commit the Band 9 Active pivot cleanly (keeping `vela-s0.1-archive`), verify the lean `node:22-alpine` + `esbuild` Docker build from a clean checkout, deploy GitHub Pages HTTPS + Service Worker, and prove cold offline start with sample display strings on the band.
2. **`P0` · Build One Recoverable Match (`Epic 1` + `Epic 2`):** Ship the primary amateur format played (`BO3` + `AD` Advantage default, with `GP` Golden Point also selectable) with frozen rules, watch-selectable first server after the 4-touch warmup rally (`initialServer: null`), UTC event log, independent monotonic `revision`, phone Undo, `Finish Now` / `Resume`, Web-Lock single-writer `localStorage` persistence, and `MediaSession` bridge (`Prev` = `US`, `Next` = `THEM`, single Center = `MY UE`, `#rev` marker, `Re-link Wrist`). Odd-game `SWAP` alerts are omitted by default (amateur matches switch ends only at set breaks).
3. **`P0` · Qualify the Wrist & Run Two Field Tests (`Epic 3`):** Measure exact `title`/`artist` truncation vs scrolling and tap-to-visible-revision delay, then pass a **90-minute court match** (against an independent tally) and a **disruption test** (call, WhatsApp voice note, headset, BLE range, Chrome kill → zero phantom points). If one-tap Center causes any phantom point, `S4.2` (`EDIT #<rev>`) becomes a conditional `P0` prerequisite before re-running `S3.2`.
4. **Post-Qualification (`Epic 4`):** Complete remaining match formats (`AD`, `BO3+STB`, `1SET`, `FREE`), safe 2-step Reset, and (if not already triggered by `S3.2`) optional `EDIT #<rev>` wrist-Undo mode.
5. **Post-Match Value (`Epic 5` `P1` / `P2`):** Match history, built-in UE analytics & `CSV`/`JSON` download (`P1`), and native Workout HR timestamp join gated on a real export (`P2`).

| Tier | Player Outcome | Stories |
| :---: | :--- | :--- |
| **P0 (Core & Qualification)** | Cold offline PWA on GitHub Pages, one recoverable match controlled from the Band 9 Active during a native Workout, verified by a 90-minute match and disruption suite. | `S0.1–S0.2`, `S1.1–S1.4`, `S2.1–S2.3`, `S3.1–S3.2` *(+ conditional `S4.2` if `S3.2` fails one-tap Center)* |
| **P0 (Post-Qualification)** | Remaining padel formats (`AD`, `BO3+STB`, `1SET`, `FREE`) and safe 2-step Reset. | `S4.1` |
| **P1 (History, Optional Wrist Undo & Analytics)** | Optional `EDIT #<rev>` wrist-Undo mode (if not promoted to `P0`), local match history, built-in UE analytics, and `CSV`/`JSON` export. | `S4.2`, `S5.1–S5.2` |
| **P2 (Gated / Parked)** | Native Workout Heart-Rate timestamp join (entry-gated on a real export) and parked ideas in Epic 6. | `S5.3`, `Epic 6` |

---

## 2. Technical Reference

### Project Structure & Lean Docker Toolchain
- Pure-JS engine lives in `src/core/` (`package.json` with `{"type": "module"}`, relative `.js` ES imports, zero DOM/Browser/Node dependencies), unit-tested via `node --test`.
- Single lean Docker container (`Dockerfile`: pinned `node:22-alpine` Maintenance LTS + `esbuild`, BuildKit npm cache mount, non-root `node` user at `/home/node/app`, zero host installs; treat image size as a measured outcome).
- Static PWA bundle builds to `dist/` and deploys automatically to **GitHub Pages** (`Settings → Pages → Source → GitHub Actions` on `main`, using Node 22, `npm ci`, `npm test`, `npm run build`).
- **GitHub Pages sub-path contract (`/<repo>/`):** Use strictly relative paths (`./sw.js`, `manifest.webmanifest` with `"start_url": "./"`, `"scope": "./"`, relative asset paths). Precache shell, bundle, icons, and full keep-alive audio asset (or generate the 10s WAV in memory as a Blob object URL to avoid HTTP 206 range-request issues). Let any new Service Worker wait until a match finishes before offering an update—never reload mid-match.

### Single-Writer Commit Rule & Wrist Arming Contract
- **One enforceable writer:** Acquire an exclusive, app-scoped **Web Lock** (`navigator.locks.request('padel-scoreboard-writer', { ifAvailable: true }, ...)`) for the active match. Any second Chrome tab or installed PWA that cannot acquire the lock opens **read-only with wrist handlers disarmed**. When the previous owner exits, a new owner must **acquire the lock and reread storage** before accepting input.
- **One command pipeline (phone & wrist):** `validate → derive next state (increment revision) → save one versioned record to localStorage → update phone UI & publish wrist metadata`.
  - A failed storage write leaves the previous score and revision visible and withholds wrist success metadata.
  - A failed wrist publish after a successful save leaves the point committed; **`Re-link Wrist`** republishes the committed score without scoring again or changing `revision`.
- **Independent monotonic `revision`:** Every state-mutating save (point, Undo, opener correction, Finish, Resume) increments `revision` by 1 regardless of rally count; `Re-link Wrist` preserves `revision`.
- **Keep-alive audio & wrist arming:** Preserve the spike's proven 10-second looping 8 kHz PCM WAV (`audio.volume = 0.005`, `>= 5s` Chromium threshold) + `setPositionState`.
  - **Wrist scoring scope:** For **wrist input**, only explicit `navigator.mediaSession` action callbacks (`previoustrack`, `nexttrack`, `pause`, `play`) may submit scoring commands (on-phone buttons in `S2.1` always remain available to the lock-holding writer). Ordinary `<audio>` `play`, `playing`, and `pause` DOM events must **never** award points.
  - **Exact arming lifecycle:** Arm wrist scoring **only** for the lock-holding writer of a live match **after a successful user-initiated `audio.play()` link**. Start **disarmed after reload**, disarm on finish or any observed interruption, and **keep armed through ordinary screen lock**. A rejected `audio.play()` leaves phone scoring available.
  - **Originating-device caveat:** MediaSession provides no originating-device ID, so a Bluetooth headset can deliver the same callbacks as the band.
- **Default wrist mapping (First Court Build — NO double-tap Undo):**
  - `Prev` (`previoustrack`) = `US +1` (`A`)
  - `Next` (`nexttrack`) = `THEM +1` (`B`)
  - Single Center (`pause` or `play`) = atomic `MY UE` (`E`: `+1 Them` + personal UE)
  - **Undo stays on the phone in `P0`.** *(Release rule: wrist UE tracking is mandatory; if `S3.2` disruption testing causes any phantom center point, disable one-tap center by default and complete `S4.2` `EDIT #<rev>` before re-running `S3.2`.)*
- **Exclusive denominators:** `A` = Us won, `B` = Them won (other), `E` = Them won via my UE → `Our = A`, `Their = B + E`, `Total = A + B + E`, `My UEs / points lost = E / (B + E)` (`—` when `B + E === 0`). Attribute each `E` to set and serving team **before** applying the event.

---

## 3. Epics and Acceptance Criteria

### Epic 0 — Preserve Baseline, Lean Toolchain & Offline GitHub Pages Shell (`P0`)

#### `S0.1` · `P0` · Commit Pivot, Lean Docker Toolchain & Baseline Record
- [x] Preserve prior Vela `.rpk` toolchain at git tag `vela-s0.1-archive` and remove obsolete Vela files (`aiot-toolkit`, `src/manifest.json`, `src/pages/`, signing scripts).
- [ ] Commit the PWA pivot to `main`, verify `docker compose run --rm --build dev sh -c "npm test && npm run build"` passes from a clean checkout of that commit with `0` files in host `node_modules/`, and record the measured Docker image size (`181 MB`) in `docs/hardware-notes.md`.
- [ ] Record exact baseline hardware/software versions in `docs/hardware-notes.md` (commit hash, phone model, Android OS, Chrome version, Mi Fitness version, Band 9 Active firmware).
- **Verify:** Clean-checkout Dockerized `npm test` + `npm run build` + `docker images`.

#### `S0.2` · `P0` · GitHub Pages HTTPS Deploy, Cold Offline Shell & Early Wrist Display Probe
*Depends on `S0.1`.*
- [ ] Add `.github/workflows/deploy-pages.yml` (`Settings → Pages → Source → GitHub Actions`): on push to `main`, use Node 22, run `npm ci`, `npm test`, `npm run build`, upload `dist/`, and deploy to `https://<owner>.github.io/<repo>/`.
- [ ] Ship minimal PWA shell in `dist/`: `manifest.webmanifest` (`start_url: "./"`, `scope: "./"`), `./sw.js` precaching shell/bundle/icons/keep-alive audio (using in-memory Blob WAV or cached full-file Blob object URL to avoid HTTP 206 range issues), and a waiting-worker rule (never force reload during an active match).
- [ ] Include fixed sample display strings (`*30-15 5-4 #42`, `*AD-40 6-5 #99`, `TB 10-10 6-6 #128`, `S:1-0 UE:12 SWAP`) in the probe page so early width observations can be taken on the Band 9 Active before `S3.1`.
- [ ] **Cold offline start gate:** Open `https://<owner>.github.io/<repo>/` online once in Android Chrome → verify SW controls page & precache succeeded → add to Home Screen → close app → disable Wi-Fi and cellular (leave Bluetooth ON) → reopen from Home Screen → start 10s keep-alive loop with a tap → confirm `MediaSession` reaches Band 9 Active offline.
- **Verify:** Live GitHub Pages URL + Android Chrome cold offline test with Band 9 Active.

---

### Epic 1 — Pure-JS Padel Engine, Event Log & Single-Writer Persistence (`P0`)

#### `S1.1` · `P0` · Core Padel Scoring (Primary Format First), Tie-Breaks & Team Service
*Depends on `S0.1`.*
- [ ] Implement `src/core/scoreEngine.js` with frozen match start rules (`scoringMode`, `format`, `decidingSet`, `initialServer`) so changing defaults never alters an active or resumed match.
- [ ] Implement primary format first (`BO3` + `GP`, plus `6–6` 7-point tie-break by 2): `0 → 15 → 30 → 40 → Game`, `6–5` continues, `7–5` wins set, `6–6` enters tie-break (`9–7` wins `7–6`).
- [ ] Track serving **team** (alternates every normal game; tie-break serves `A, B, B, A, A, ...`; tie-break receiver opens next set) and `changeEndsAlert` (odd total games in set, every 6 tie-break points, clears on next point; swap preserves `US`/`THEM`).
- [ ] Support manual `"Finish Now"` (`FINISHED_MANUAL`, preserving partial score & duration with no manufactured winner), distinguishing **Resume match** (restores every rally intact) from **Undo last point** (removes the last rally).
- **Verify:** Table-driven `node --test` fixtures (mirrored opening-server tests + canonical `6–4 | 5–4 | 30–15` manual-finish fixture).

#### `S1.2` · `P0` · Compact UTC Event Log, Independent Revisions, Replay Undo & Opener Correction
*Depends on `S1.1`.*
- [ ] Record each accepted rally with monotonic event ID, UTC Unix timestamp (`Date.now()` via injectable clock), and exclusive code (`A` = Us, `B` = Them other, `E` = My UE).
- [ ] Maintain monotonic `revision` independent of rally count: point, Undo, opener correction, Finish, and Resume each increment `revision`; `Re-link Wrist` preserves it.
- [ ] Replay `events` from frozen start rules for full-match Undo across game, set, tie-break, and match boundaries—restoring points, games, sets, serving team, side-change cue, UE denominators, and active status.
- [ ] Support `Correct first serving team` during active play: increments `revision` for the same match, recomputing serve indicator and serve/return attribution while preserving scores, event order, timestamps, and UE totals.
- [ ] Compute exclusive counts (`Us = A`, `Them = B + E`, `Total = A + B + E`) and `My UEs / points lost = E / (B + E)` (`—` when `B + E === 0`). Include a 1-event `[E]` fixture and a `point → Undo → different point → offline reload` fixture verifying distinct revisions, preserved timestamps, and exact replay.
- **Verify:** `node --test`.

#### `S1.3` · `P0` · Two-Line Wrist Display Formatter (`title` + `artist`)
*Depends on `S1.2` (uses provisional width budgets—e.g. `title <= 20 chars`, `artist <= 20 chars`—until `S3.1` tunes them against measured Band 9 Active limits).*
- [ ] Implement pure `formatWristDisplay(state, revision)` returning `{ title, artist }` prioritizing must-fit first-glance fields: live points + current games + serve `*` + `#rev` on `title` (plus `WHO SERVES?` / `US SERVES` / `THEM SERVES` at warmup & love-all); sets + `UE` on `artist` (odd-game `SWAP` omitted by default for amateur play).
- [ ] Ensure repeated scores (e.g. `40-40` Deuce) always differ visibly via `#rev`.
- **Verify:** `node --test` covering `WHO SERVES?`, love-all `US/THEM SERVES`, `40-40`, `AD-40`, `TB 10-10`, 3-digit `UE`, and `FINISHED_MANUAL`.

#### `S1.4` · `P0` · Web-Lock Single Writer, Commit Pipeline & Corrupt-Storage Recovery
*Depends on `S1.2`.*
- [ ] Enforce one writer via an exclusive, app-scoped Web Lock (`navigator.locks.request('padel-scoreboard-writer', { ifAvailable: true }, ...)`). Any second tab or installed PWA opens **read-only with wrist handlers disarmed**; after the owner exits, the new owner must acquire the lock and reread storage before accepting input.
- [ ] Route all phone and wrist mutations through one pipeline: `validate → derive next state → save one versioned record → update phone UI & publish wrist metadata`.
- [ ] On storage write failure (e.g. quota error), keep previous score & revision visible, show an explicit error, and withhold wrist success metadata. If wrist publish fails after a successful save, keep the point committed so `Re-link Wrist` republishes without scoring again.
- [ ] On corrupt saved JSON, **do not silently overwrite**—present a visible recovery screen (view/copy raw payload + explicit "Clear & Start Fresh" confirmation).
- [ ] Maintain a separate bounded diagnostic log key in `localStorage` (raw wrist action, callback timestamp, audio state, committed revision) so disruption evidence survives Chrome termination.
- **Verify:** `node --test` (quota error, corrupt JSON recovery, reload replay) + **real Android Chrome simultaneous tab + installed PWA lock test**.

---

### Epic 2 — MediaSession Bridge & Mobile Live Scoreboard (`P0`)

#### `S2.1` · `P0` · Match Setup, On-Phone Live Scoreboard & Match Over
*Depends on `S1.1–S1.4`, `S0.2`.*
- [ ] New Match setup screen: displays primary format (`BO3`, `GP`), asks **"Who serves first?"** (`US` / `THEM`), saves defaults, and freezes rules into the new match on `Start`.
- [ ] Live phone scoreboard (always usable for lock-holding writer, clearly labeled read-only if another tab holds the lock): large `US`, `THEM`, `MY UE`, and `Undo` buttons, live score/serve/UE/`SWAP`/`#rev`, `Menu → Correct first serving team`, and `Menu → Finish Now` (with confirmation).
- [ ] Match Over screen displays set lines, partial game score (if manual finish), finish reason, duration, exclusive `Us` / `Them (other)` / `My UE` counts, and `My UEs / points lost` (`—` if 0). Offers **`Undo last point`** (on won match), **`Resume match`** (on manual finish), and **`New Match`**.
- **Verify:** Offline Android Chrome browser test (full match + reload recovery).

#### `S2.2` · `P0` · MediaSession Wrist Bridge & `Re-link Wrist` Recovery
*Depends on `S2.1`, `S1.3`, `S1.4`.*
- [ ] Wire the spike's proven 10-second looping WAV (`volume = 0.005`) + `navigator.mediaSession` (`previoustrack` = `US`, `nexttrack` = `THEM`, `pause`/`play` = `MY UE`).
- [ ] Enforce exact wrist arming: arm **only** for the lock-holding writer of a live match after a successful user-initiated `audio.play()` link; start disarmed after reload; disarm on finish or observed interruption; remain armed through ordinary screen lock; rejected `audio.play()` leaves phone scoring available.
- [ ] Assert ordinary `<audio>` `play`, `playing`, and `pause` DOM events **never** award points.
- [ ] Publish `title` and `artist` together as one `MediaMetadata` snapshot per committed revision (only after `S1.4` save succeeds), keeping `playbackState` consistent with actual playback.
- [ ] Provide a prominent **`Re-link Wrist`** button calling `audio.play()` directly from the phone tap, handling rejection cleanly, restoring action handlers, and republishing the last committed score (preserving `revision`, with zero automatic retry loops competing with active calls).
- **Verify:** Physical Android phone + Band 9 Active (unlocked, locked, and after audio interruption).

#### `S2.3` · `P0` · Cold Offline End-to-End Match Check
*Depends on `S0.2`, `S2.2`.*
- [ ] Deploy `S2.2` to GitHub Pages, open online once to precache, close app, disable Wi-Fi and cellular (leave Bluetooth ON), reopen from Home Screen, start match + wrist link with a tap, score `US`, `THEM`, and `MY UE` from the wrist, undo on phone, reload page, and confirm exact `matchId`, `revision`, and ordered `A`/`B`/`E` history survive offline.
- **Verify:** Physical Android phone (airplane mode + Bluetooth ON) + Band 9 Active.

---

### Epic 3 — Wrist Qualification & Real Court Field Tests (`P0` Gate)

#### `S3.1` · `P0` · Qualify the Wrist Display & Input Behavior
*Depends on `S2.3`.*
- [ ] Agree upfront on qualification thresholds before testing: **must-fit first-glance fields** (live points + current games + serve `*` + `#rev` on `title`, plus `WHO SERVES?` / `US SERVES` / `THEM SERVES` at warmup & love-all; sets + `UE` on `artist`, with odd-game `SWAP` omitted by default) and **acceptable tap-to-visible-revision delay** (target: `<= 2.5s` median, `<= 5.0s` worst).
- [ ] Test real formatted scores (`WHO SERVES?`, `US SERVES`, `30-15`, `AD-40`, `TB 10-10`, `#42`, `UE:100`) on the physical Band 9 Active; record **first-glance truncation** and **scrolling** separately for `title` and `artist` in `docs/hardware-notes.md` and tune `S1.3` if needed.
- [ ] Verify Band 9 Active repeated center taps (`pause` vs `play`), rapid updates, and leaving/reopening Music during a native Workout.
- [ ] Measure tap-to-visible-revision delay with a **second observer or phone video** (page logs alone cannot measure wrist render time) and log results in `docs/hardware-notes.md`.
- **Verify:** Physical Band 9 Active + diagnostic log + observer/video measurement.

#### `S3.2` · `P0` · Two Field Tests: 90-Minute Court Match & Disruption Suite
*Depends on `S3.1`.*
- [ ] **Field Test 1 (90-Minute Match):** Play a real 90-minute match with phone locked, unplugged, in its usual court bag, native Band 9 Active Workout active, and an **independent point tally** (paper/partner). Start with normal Android battery settings; change only one setting at a time if Doze interrupts playback, documenting the minimum required phone & Mi Fitness settings in `docs/setup-guide.md`.
- [ ] **Field Test 2 (Disruption Suite):** Run five explicit disruptions: (1) incoming phone call, (2) WhatsApp voice note, (3) Bluetooth earbud connect & mid-rally removal, (4) far-court BLE disconnect/reconnect, and (5) killing Chrome mid-match + offline reopen + `Re-link Wrist`.
  - **Protocol per disruption:** Record starting `revision` → trigger interruption **without touching the band** → verify **zero new events** → recover (`Re-link Wrist` if needed) → make **one deliberate wrist tap** → verify **exactly one matching event**!
  - **Chrome kill verification:** Reopen offline and compare `matchId`, `revision`, ordered `A`/`B`/`E` history, serving team, and status (not just final score!), using observer log + `S1.4` persistent diagnostic log.
- [ ] **Pass / Fallback Rule:** Pass when the 90-minute independent tally matches point-for-point, tap-to-wrist delay meets `S3.1` threshold, and interruptions create **zero phantom points** (any unsolicited `Prev`, `Next`, or Center event fails qualification). If one-tap Center causes a phantom point, **disable one-tap Center by default, promote `S4.2` (`EDIT #<rev>`) to `P0`, and re-run `S3.2`**.
- **Verify:** Recorded field-test log in `docs/hardware-notes.md`.

---

### Epic 4 — Post-Qualification Formats, Safe Reset & Conditional Wrist-Undo Mode

#### `S4.1` · `P0` (Post-Qualification) · Complete Match Formats & Safe Two-Step Reset
*Depends on `S3.2`.*
- [ ] Add remaining rules/formats to engine & setup screen: **Advantage (`AD`)**, **`BO3+STB`** (`10-9` continues, `11-9` ends match, stored/displayed distinctly as `STB`), **`1SET`**, and **`FREE`** (continuous sets until manual finish).
- [ ] Add `Menu → Reset Match` with explicit 2-step confirmation (`Cancel` / `Confirm Reset`) so an active match cannot be wiped accidentally.
- **Verify:** `node --test` + Android Chrome PWA.

#### `S4.2` · `P1` *(Promoted to `P0` Prerequisite If `S3.2` Rejects One-Tap Center)* · Explicit `EDIT #<rev>` Wrist-Undo Mode
*Depends on `S2.2` (independent of `S3.2` so it can unblock `S3.2` if needed).*
- [ ] From live score, Center (`play`/`pause`) opens **`EDIT #42`** / **`<UNDO   UE>`** without changing any score (repeated center taps leave it open).
- [ ] `Prev` undoes revision `#42`; `Next` logs one `MY UE` (`E`) against `#42`—accepted **once** only against revision 42, ignoring repeated arrows until Center returns to live scoring.
- [ ] Any phone edit, interruption, or stale revision invalidates the prompt and consumes any late arrow confirmation without scoring; `Cancel` stays available on the phone.
- **Verify:** `node --test` state machine + physical Band 9 Active wrist test.

---

### Epic 5 — Match History, Built-In UE Analytics & Native Workout HR Join (`P1` / `P2`)

#### `S5.1` · `P1` · Local Match History List
*Depends on `S4.1`.*
- [ ] Persist completed and manually finished matches in a versioned local history list on the phone (`localStorage`), allowing the player to browse past matches, inspect summaries, and delete entries.
- **Verify:** `node --test` + Android Chrome offline reload test.

#### `S5.2` · `P1` · Built-In UE Analytics & One-Tap `CSV`/`JSON` Export
*Depends on `S5.1`.*
- [ ] Compute and display directly inside the PWA (zero QR scanning!):
  - Exclusive `A`/`B`/`E` totals and `My UEs / points lost` (`—` if 0).
  - **Pre-point Clutch UEs** (`40-40` GP, break point, set point, tie-break — classified from score & server **before** applying each event; overlapping labels allowed while counting each event once in totals).
  - **Our Team Serving vs Returning** UE split and **ordinary service hold rate** (`completed ordinary service games won / completed ordinary service games served`, `—` at zero opportunities; exclude incomplete games and tie-breaks).
  - **UE Clusters** (`>= 2` `E` events within `3` consecutive points, merging overlapping windows) and **observed UE rate by 15-minute elapsed window** showing `E / (B + E)`, points lost, and total points `n`.
- [ ] One-tap download of decoded match data as `match.csv` and `match.json`.
- **Verify:** Expected-results `node --test` table (1-event `[E]`, deciding point, incomplete game, empty window) + Android Chrome download test.

#### `S5.3` · `P2` · Native Band 9 Active Workout Heart-Rate Timestamp Join
*Entry Gate: One real timestamped Workout HR export from Mi Fitness / Health Connect / Strava with verified units, timezone offset, sampling cadence/gaps, and confirmed overlap with a recorded test match.*
- [ ] Join UTC match point/UE timestamps to the nearest workout HR sample within a documented tolerance, marking gaps as `missing` (no silent interpolation).
- [ ] Display observed Avg/Max HR and HR on `MY UE` vs non-UE points (with sample counts), and export merged CSV.
- **Verify:** `node --test` with sanitized fixture derived from the real workout export.

---

### Epic 6 — Parked (`P2`)
Soft audio confirmation beeps, 2026 FIP **Star Point**, individual doubles server order, post-match context tags (court side, effort `1–5`), Partner UE / Winner / Net-vs-Glass buttons, cloud backup/sync, and native Vela/WearOS/Garmin ports.

---

## 4. Definition of Done

| Applies To | Evidence Required |
| :--- | :--- |
| **Every story** | Each acceptance case has an expected result, declared verification method, and recorded pass. Tag hardware observations with tested commit/build, phone model, Android/Chrome/Mi Fitness versions, and Band 9 Active firmware. |
| **Pure-JS core (`src/core/`)** | `node --test` passes deterministically via Docker; zero DOM/Browser/Node imports; relative `.js` ES imports only. |
| **PWA, persistence & recovery** | `npm run build` succeeds cleanly in lean Docker; `S1.4`/`S2.2` verify Web Lock mutual exclusion in real Chrome, save-before-publish, injected quota error + corrupt-JSON recovery before overwrite, zero phantom points from `<audio>` DOM events, and **mid-match SW upgrade recovery** (deploy build B during active match on A → close all clients so B activates → cold-start offline → recover saved match cleanly under B). |
| **`P0` court release** | Cold offline GitHub Pages start passes (`S2.3`), wrist width & video/observer latency meet `S3.1` thresholds, and both the 90-minute match tally and 5-disruption suite pass with zero phantom points and intact history (`S3.2`). |

---

## 5. Risk Register

| Risk & Exposure | Trigger / Evidence | Owner Action |
| :--- | :--- | :--- |
| **Call, voice note, or headset causes phantom point** · *High / High* | Any disruption in `S3.2` adds an event without an intentional wrist tap. | Block `<audio>` DOM events; if one-tap Center misfires, disable one-tap Center by default, promote `S4.2` (`EDIT #<rev>`) to `P0`, and re-run `S3.2`. |
| **Android Doze / battery killer freezes locked tab** · *Med / High* | Locked 90-minute match (`S3.2`) stops receiving wrist taps or drops MediaSession. | Start on default settings, then change one setting at a time (Chrome battery, Mi Fitness background permissions) and document minimum settings in `docs/setup-guide.md`. |
| **Audio focus stolen silently** · *Med / Med* | Band stops reflecting score after call/notification. | Player uses phone UI + manual `Re-link Wrist` (`S2.2`); never auto-retry against active calls. |
| **Two-tab / PWA overwrite** · *Med / High* | Open Chrome tab and Home-Screen PWA clobber saved match. | Enforce `S1.4` exclusive Web Lock (second client opens read-only with wrist disarmed) and verify in real Chrome. |
| **Quota error or corrupt storage loses match** · *Low / High* | Write throws or stored JSON fails parse. | Keep previous state visible on quota failure; show raw backup + explicit reset prompt on corrupt JSON before overwriting (`S1.4`). |
| **SW upgrade activates between closes mid-match** · *Med / High* | Build B deploys while match on Build A is active and user closes/reopens offline. | Waiting SW never reloads mid-match; verify closing all clients + offline cold-start under Build B recovers saved match cleanly (DoD). |
| **Wrist text truncates critical info** · *Med / Med* | `AD`, `10-10`, `#42`, or `SWAP` cut off on first glance (`S3.1`). | Shorten labels in `S1.3` from measured `S0.2`/`S3.1` widths and re-verify. |
| **Workout HR cannot be exported with timestamps** · *Med / Med* | No real Band 9 Active workout export overlaps a test match. | Keep `S5.3` parked until entry fixture exists. |
