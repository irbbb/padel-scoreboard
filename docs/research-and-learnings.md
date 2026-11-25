# Research & Spike Learnings: Padel Scoreboard, Vitals & Match Trace for Xiaomi Mi Band 9

## 1. Is It Possible?
**Yes—with one important hardware caveat regarding live vitals.**

- **Scoreboard + Unforced Errors + Match Trace:** **100% possible standalone on the Mi Band 9** using a native **Xiaomi Vela JS QuickApp (`.rpk`)**. No phone is needed on court.
- **Live Vitals (Heart Rate) inside the QuickApp:** **Likely NOT directly accessible via public Vela APIs.** Xiaomi restricts raw PPG / continuous Heart Rate sensors to first-party system apps (`@system.sensor` only exposes accelerometer, compass, and pressure), and the Mi Band 9 **does not allow running a native Workout in the background** while another QuickApp is open.
- **Vitals Workaround (Gated on Real Export):** Enable Mi Band 9's built-in **All-Day 1-Minute Heart Rate Monitoring** in Mi Fitness (which runs passively in the background). Our QuickApp records exact Unix timestamps per event so you can correlate them externally *once we verify a real timestamped HR export from Mi Fitness / Health Connect / Strava actually includes those 1-minute samples*. *(We still check HR API availability in `S0.3`.)*

---

## 2. Options Explored & Trade-Offs

### Platform Options
| Option | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- |
| **A. Native Vela JS QuickApp (`.rpk`)** | Standalone on court, full touch UI, short/long vibration, local storage, built-in `<qrcode>` (`minAPILevel: 2`), `onBackPress()`. | Sideloading required (no global App Store); no public HR API; tight RAM and `192×490` screen. | **Selected** |
| **B. Custom Watchface (`.bin`)** | Easy install. | Cannot run custom logic, counters, or traces. | **Rejected** |
| **C. Companion Phone App + Band Notifications** | Easy mobile stack. | Requires phone on court; clunky tap UX. | **Rejected for MVP** |

### Internal Engine & Undo Options (Spiked & Refined After Review)
| Option | Summary | Verdict |
| :--- | :--- | :--- |
| **Coupled UI + Reverse-Math Undo** | Put scoring rules in `index.ux` and subtract on Undo. | **Rejected** — Hard to test; breaks across set/tie-break/UE boundaries. |
| **30 Full State Snapshots + Separate Event Trace** | Store both 30 full snapshots (~4.9 KB) and a growing event list. | **Superseded** — Redundant storage cost and risk of snapshot/trace bloat. |
| **Pure-JS Event-Log Replay (`events[]` + Frozen Start Rules)** | Store only frozen match config + compact `{ t, code }` event log. Undo pops the last event and replays from start up to measured `MAX_EVENTS`; beyond the cap, continue scoring with one-step Undo and `PARTIAL` export flag. | **Selected** — Clean in-session and post-restart Undo, tiny storage footprint, impossible for score and UE trace to desync, graceful behavior past capacity. |

### Unforced Error (UE) Input UX Options
| Option | How It Works | Verdict |
| :--- | :--- | :--- |
| **2-Tap Separate `+UE` Button** | Tap Opponent `+1`, then tap `+UE`. | **Rejected** — Slow mid-match, easy to forget 2nd tap or desync UE from score. |
| **1-Tap `MY UE` Button (`+1 Them + Log UE`)** | Dedicated pill (`66px` ≈ `5.2 mm` @ 325 ppi) below Opponent zone: 1 tap awards Opponent `+1` AND logs exclusive event `E` at that exact score & timestamp. | **Selected** — Matches padel rules, 1 tap, automatically links every UE to exact pre-event score/server & timestamp. |

### Exporting the Match Trace Off the Band
| Option | How It Works | Pros | Cons | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **1. Built-in `<qrcode>` Component on Band** | Render strict QR-alphanumeric string on the `192×490` OLED (`minAPILevel: 2`); scan with phone camera after match. | **Zero companion app needed**; works on Android & iOS; built into Vela JS. | Xiaomi exposes no EC-level or margin controls; requires conservative caps (`≤ 61` chars V3 / `≤ 90` chars V4) and **zero commas**. | **Selected for MVP** |
| **2. `@system.interconnect` Companion App** | Push JSON over BLE to custom Android/iOS app. | Automatic sync. | Requires building & signing a separate mobile app + Global firmware hurdles. | **Deferred to Post-MVP (P2)** |
| **3. On-Band Summary Screen** | Immediate score, duration, exclusive `A`/`B`/`E` totals, `My UEs / points lost`, UEs per set. | Instant post-match insight with zero extra tools. | Cannot chart or correlate externally alone. | **Selected alongside QR Export** |

---

## 3. Verified Hardware, Manifest & Codec Details

### Vela Manifest & Project Contract
- Files: `src/manifest.json` alongside `src/app.ux`.
- Scaling: `"config": { "designWidth": 192 }` (not top-level!).
- Features in `manifest.json` omit `@`: `{"name": "system.storage"}`, `{"name": "system.vibrator"}`, `{"name": "system.brightness"}` (use `@system.*` only in JS imports).
- Native `<qrcode>` requires `"minAPILevel": 2` — must be verified on physical Band 9 firmware.
- Band 9 `@system.vibrator` documents `short` and `long` vibration modes (pair with visual flash to distinguish 4 event types).

### Screen & Layout Geometry (`192×490` Capsule, 325 ppi)
- Curved top (`y: 0–60`) and bottom (`y: 426–490`) caps narrow every row (usable width drops to `106px` at `y = 16px`).
- **Safe 6-Zone Vertical Budget (`490px` total):**
  - `y:   0–60`  (`60px`, ~`4.7 mm`, curved ~`139px` width): Top Cap — Clock + Sets + Live UE counter
  - `y:  60–200` (`140px`, ~`10.9 mm`, full `192px`): **`US`** tap zone (`+1 Us`)
  - `y: 200–248` (`48px`, ~`3.8 mm`, full `192px`): Center Bar — Mode (`GP`/`AD`/`TB`/`STB`) + `SWAP ENDS` cue
  - `y: 248–360` (`112px`, ~`8.8 mm`, full `192px`): **`THEM`** tap zone (`+1 Them` normal)
  - `y: 360–426` (`66px`, ~`5.2 mm`, full `192px`): **`MY UE`** pill (`+1 Them` + log `MY_UE`)
  - `y: 426–490` (`64px`, ~`5.0 mm`, curved ~`143px` width): Bottom Cap — **Undo** (immediate, no scoring debounce) & **Menu**

### Strict QR Alphanumeric Codec & Capacity Reality
- **Official QR Alphanumeric charset:** `0-9`, `A-Z`, space, `$`, `%`, `*`, `+`, `-`, `.`, `/`, `:` — **commas are NOT allowed** (a single comma switches the encoder to Byte mode and halves capacity!).
- **Whole-pixel pitch on `192px` width (including required 4-module white quiet zone on all 4 sides):**
  - **QR V3 (`37` modules total → `5 px/module`):** `77` chars (EC-L) / **`61` chars (EC-M)** ← target for Summary QR.
  - **QR V4 (`41` modules total → `4 px/module`):** `114` chars (EC-L) / **`90` chars (EC-M)** ← target for each Paginated Full-Trace QR frame.
- **Long gap handling:** Quantize elapsed time from `matchStart` in 5-second ticks and encode tick deltas (`0..Z` for `0..175s`) plus a `+` escape for gaps `> 175s` (prevents 3+ minute breaks from overflowing while keeping reconstructed tap time within `±2.5s` under a stable clock).
- **Paginated integrity:** Freeze exported revision and include `matchId`, `rev`, `page/total`, checksum, frozen rules, and `initialServer` so shuffled/missing/mixed-revision scans are cleanly detected.

### Persistence & Sideloading Risks (Hardware Gates in Epic 0)
- `@system.storage` is async callback-based with no guaranteed 5 KB quota or crash-atomicity → measure actual quota on Band 9, enforce a `MAX_EVENTS` cap (with `PARTIAL` export flag if exceeded), and use a **single-flight app-level writer** with dual storage slots and monotonic revision.
- Sideloading paths (official Mi Fitness dev deploy, AstroBox, Notify for Xiaomi, ADB) must be proven on the actual Global Band 9 SKU/firmware/phone OS including **standalone phone-disconnected run** and **in-place `.rpk` upgrade with a saved match**. Never cross-flash Chinese firmware onto a Global band.

---

## 4. Padel Domain Edge Cases Captured
1. **Scoring Modes (v1):** **Golden Point (Punto de Oro)** and **Advantage (`AD`)** (2026 FIP *Star Point* noted as P2 option). Match rules freeze at match start.
2. **Match Formats & Manual Finish:** Best of 3, Best of 3 with 10-point deciding Super Tie-Break (stored distinctly so `11–9` never looks like an 11-game set), Single Set, Free Play, plus **"Finish Now"** for timed court bookings without manufacturing a winner.
3. **Tie-Break (6–6) & Team Server Rotation:** First to 7 (win by 2); if Team A opens the tie-break, serve order by team is `A, B, B, A, A, ...`, and **Team B opens the next set** regardless of who served the last tie-break point. *(v1 tracks serving team only, not individual doubles player rotation.)*
4. **Exclusive Event Denominators:** `A` = Us, `B` = Them normal, `E` = My UE → `Our = A`, `Their = B + E`, `Total = A + B + E`, `My UEs / points lost = E / (B + E)` (`—` if `0` lost). Clutch classification uses the score & server **before** applying the event.
