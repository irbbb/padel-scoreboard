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
