# Hardware & Emulator Notes — Xiaomi Smart Band 9

> **Scope:** Records empirical observations from the `192 × 490` Band 9 emulator (`S0.1`, labeled as **emulator observations**) and later physical Global Mi Band 9 hardware probes (`S0.2`–`S0.3`).

---

## 1. `S0.1` — Three-Runtime Shared Fixture Verification *(Status: Open — awaiting Browser + Simulator runs)*

**Independent Expected Result:** `30-15` (from `formatPoints(2, 1)` via `src/core/sharedFixture.js`)

| Runtime | How Verified | Observed Value | Status |
| :--- | :--- | :---: | :---: |
| **Node (`node --test`)** | `docker compose run --rm dev npm test` | `30-15` (Node `v22.23.5` Maintenance LTS in Docker) | `[x]` |
| **Offline Browser (`file://`)** | Move `dist-web/fixture.html` alone into a folder with a space in its name, open via `file://`, DevTools **Offline** + **Disable cache**, reload, assert `0` HTTP(S) requests | *(open in browser to record)* | `[ ]` |
| **Vela Band 9 Simulator (`.rpk`)** | Install Docker-built, signature-verified `dist/com.padel.scoreboard.debug.0.1.0.rpk` via **Install Rpk** (no IDE rebuild) and launch | *(run in AIoT-IDE simulator to record)* | `[ ]` |

### Build Artifact Provenance (Specific Local Build)
*(Note: The RPK SHA-256 below belongs strictly to this specific build and disposable debug key—generating a new debug key changes the signed bytes, and `apk add openssl` resolves against Alpine's repository.)*
- **RPK File:** `dist/com.padel.scoreboard.debug.0.1.0.rpk` (`9,451` bytes)
- **RPK SHA-256 (this build):** `0892baea3f8938aa8878dd2a4b1229a81270a8fe0ce5ce4b2484b3759a01c61b`
- **Verified Signer Cert SHA-256:** `AA:64:48:8E:60:C5:D2:C6:40:11:56:13:D7:51:57:28:62:17:11:4E:4F:F4:90:67:39:40:A4:AE:1E:4B:3A:9B`
- **Simulator Profile / Image:** *(fill AIoT-IDE version & Band 9 simulator image/profile)*
- **Native-Resolution Screenshot (`192 × 490`):** *(save under `captures/s0.1-emulator.png` — gitignored — or record path)*

---

## 2. `S0.1` — Preliminary Cap Measurements (**Emulator Observations Only**)

> **Important:** Inspect the native-resolution simulator capture carefully. If the simulator displays an **unmasked rectangle** (corners not masked into a pill/capsule), mark cap clipping as **unmeasured (unmasked rectangle)** and capture true curved clipping on the physical Band 9 in `S0.3`.

- **Simulator Masks Capsule Corners?** `[ ] Yes` / `[ ] No (unmasked rectangle — cap clipping unmeasured)`
- **`designWidth: 192` Scales 1:1 Across Full Width?** `[ ] Yes` / `[ ] No (notes: ...)`

| Marker Row (`y`) | Line Color | Leftmost Visible Pixel (`x`) | Rightmost Visible Pixel (`x`) | Visible Width (`px`) | Notes |
| :---: | :---: | :---: | :---: | :---: | :--- |
| `0` | Red | *(fill)* | *(fill)* | *(fill)* | Top edge |
| `30` | Green | *(fill)* | *(fill)* | *(fill)* | Upper cap |
| `60` | Green | *(fill)* | *(fill)* | *(fill)* | Planned `US` top boundary |
| `426` | Green | *(fill)* | *(fill)* | *(fill)* | Planned Bottom Cap top boundary |
| `460` | Green | *(fill)* | *(fill)* | *(fill)* | Lower cap |
| `489` | Red | *(fill)* | *(fill)* | *(fill)* | Bottom edge (0-indexed) |

---

## 3. Physical Band 9 Measurements (`S0.2` / `S0.3` — Populated Later)
*(Reserved for physical SKU, firmware, storage quota / `MAX_EVENTS`, wake/sleep lifecycle, `onBackPress()`, and 2-phone QR scan records.)*
