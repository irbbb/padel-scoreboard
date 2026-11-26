# Padel Scoreboard — Xiaomi Smart Band 9 Active + Offline Android Chrome PWA

Zero-APK Padel Scoreboard, Unforced Error (`MY UE`) tracker, and timestamped match analyzer controlled right from your **Xiaomi Smart Band 9 Active**'s native **Music Controls** (accessible by swiping right during a native Band Workout recording continuous Heart Rate!), powered by an offline Android Chrome PWA using `navigator.mediaSession`.

- **Live Offline PWA:** https://irbbb.github.io/padel-scoreboard/
- **Backlog:** [docs/backlog.md](docs/backlog.md)
- **Research & Learnings:** [docs/research-and-learnings.md](docs/research-and-learnings.md)
- **Hardware Notes:** [docs/hardware-notes.md](docs/hardware-notes.md)
- *(The archived Xiaomi Vela `.rpk` toolchain from `S0.1` is preserved at git tag `vela-s0.1-archive`.)*

---

## App Screens

| Court Setup | Live Scoreboard | Match Result & Set Flow |
| :---: | :---: | :---: |
| <img src="docs/screenshots/setup.png" alt="PadelScore Court Setup screen" width="230"> | <img src="docs/screenshots/live.png" alt="PadelScore Live TV Scoreboard screen" width="230"> | <img src="docs/screenshots/result.png" alt="PadelScore Match Result, UE Precision Ring, and Set Flow screen" width="230"> |
| Advantage / Golden Point, Band `\|\|` mode & thumb-pinned start | Broadcast grid (`S1 · S2 · PTS`), 1-tap pads & live Band footer | Scoreboard, My UE ring card, Set Flow & point-by-point matrix |

| Band 9 Active Visual Guide | Match History |
| :---: | :---: |
| <img src="docs/screenshots/guide.png" alt="PadelScore Visual Band 9 Active Guide sheet" width="230"> | <img src="docs/screenshots/history.png" alt="PadelScore Match History list" width="230"> |
| Pre-court checklist & color-coded `<` `\|\|` `>` Band schematics | Local history ledger with scores, duration & UE summary |

### On Your Wrist — Xiaomi Smart Band 9 Active (Music Controls)

Start a native Band Workout (recording Heart Rate) and swipe right to **Music Controls** — your phone stays locked in your bag:

<table>
  <thead>
    <tr>
      <th width="25%" align="center">1. Pick First Server</th>
      <th width="25%" align="center">2. Score Live Rallies</th>
      <th width="25%" align="center">3. Open Edit (<code>||</code>)</th>
      <th width="25%" align="center">4. Resume Live (<code>||</code>)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="docs/screenshots/band-warmup.svg" alt="Xiaomi Smart Band 9 Active showing WHO SERVES? #1" width="160"></td>
      <td align="center"><img src="docs/screenshots/band-live.svg" alt="Xiaomi Smart Band 9 Active showing *30-15 4-1 #65" width="160"></td>
      <td align="center"><img src="docs/screenshots/band-edit.svg" alt="Xiaomi Smart Band 9 Active showing EDIT #65" width="160"></td>
      <td align="center"><img src="docs/screenshots/band-resume.svg" alt="Xiaomi Smart Band 9 Active showing UE *30-30 #66 resume screen" width="160"></td>
    </tr>
    <tr>
      <td align="center"><code>&lt;</code> US or <code>&gt;</code> THEM (no point scored)</td>
      <td align="center"><code>&lt;</code> US +1 · <code>||</code> Edit · <code>&gt;</code> THEM +1</td>
      <td align="center"><code>&lt;</code> Undo last point · <code>&gt;</code> My UE</td>
      <td align="center">Arrows lock until <code>||</code> is pressed</td>
    </tr>
  </tbody>
</table>

---

## Clean-Clone Quick Start (Lean Docker — Zero Host Installs)

All dev tooling (`node:22-alpine` Maintenance LTS + `esbuild`) runs inside a single lean Docker container.

1. **Run pure-JS unit tests (`node --test`)**:
   ```powershell
   docker compose run --rm --build dev npm test
   ```
2. **Build static PWA output (`dist/`)**:
   ```powershell
   docker compose run --rm dev npm run build
   ```

> **After changing `package-lock.json`:** Re-run with `--build` (`docker compose run --rm --build dev ...`, or `docker compose up --build --force-recreate --renew-anon-volumes dev` if keeping a long-lived container) so the container's anonymous `/home/node/app/node_modules` volume refreshes cleanly.
