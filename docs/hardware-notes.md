# Hardware Notes — Xiaomi Smart Band 9 Active

## 1. Historical Gate Record — Vela `S0.2` (No-Go)
- **Archived Commit / Tag:** `9af85c0` (`vela-s0.1-archive`)
- **Observed Device:** `Xiaomi Band 9 Active 9A8F` (`172 × 320` TFT LCD, closed lightweight proprietary RTOS)
- **Result:** **No-Go for Vela `.rpk`**. Global Mi Fitness does not expose Debug mode; Notify for Xiaomi returned `"update failed this band model may not support this feature yet"`; BandBurg confirmed the device is Band 9 Active (which has no Vela QuickApp runtime).
- **Decision:** Pivoted to **Android Chrome Offline PWA (`navigator.mediaSession`) + Band 9 Active Music Controls**.

---

## 2. Live Spike Observations — Band 9 Active + Android Chrome `MediaSession`
- **Audio Keep-Alive Requirement:** `2s` WAV was ignored by Chrome Android (`< 5s` Chromium threshold). **`10s` looping WAV** (8 kHz PCM sine wave played at `audio.volume = 0.005` + `setPositionState`) reliably created the Android MediaSession notification and synced to the Band 9 Active.
- **Companion Setup:** Official **Mi Fitness** app only (Notify uninstalled to avoid BLE conflict) with Android **Notification Access** enabled for Mi Fitness and notifications enabled for Chrome.
- **Verified Short Spike Behaviors (~20s lock window):**
  - `[x]` Unlocked wrist taps (`Prev`, `Next`, `Play/Pause`) update phone & band metadata.
  - `[x]` Locked phone screen (~20s): `Prev`, `Next`, and repeated `Play/Pause` continue firing and updating wrist display.
  - `[x]` Mid-Workout: Native Band 9 Active Workout (continuous HR) + swipe right to Music Controls works simultaneously.
  - `[x]` Display lines: **Both `title` and `artist`** render on the Band 9 Active Music Control screen.
  - `[x]` Latency: Acceptable in short desk test (formal observer/video measurement pending in `S3.1`).

---

## 3. Baseline Environment & Pending Qualification Measurements (`S0.1` / `S3.1` / `S3.2`)
- **Measured Docker Image Size (`padel-scoreboard-dev`):** `181 MB` (`node:22-alpine` Maintenance LTS + `esbuild@0.28.2`, `2` npm packages, `0` files in host `node_modules/`)
- **Tested Build / Commit:** *(fill commit hash when running `S0.2` / `S3.1` / `S3.2`)*
- **Phone Model & Android OS:** *(fill)*
- **Chrome Version:** *(fill)*
- **Mi Fitness Version:** *(fill)*
- **Band 9 Active Firmware Version:** *(fill)*
- **Visible Character Width (`S0.2` / `S3.1`):**
  - `title`: first-glance truncation = *(fill)* chars · scrolling limit = *(fill)* chars
  - `artist`: first-glance truncation = *(fill)* chars · scrolling limit = *(fill)* chars
- **Tap-to-Visible-Revision Delay (`S3.1`, observer/video):** median = *(fill)* s · worst = *(fill)* s
- **90-Minute Court Match & 5-Disruption Protocol (`S3.2`):**
  - 90-minute match (locked, unplugged, court bag, Workout active, independent tally): *(pending)*
  - Disruption suite (call, WhatsApp voice note, earbud connect/remove, far-court BLE, Chrome kill): *(pending)*
  - Minimum required Android Chrome / Mi Fitness battery settings: *(pending)*
