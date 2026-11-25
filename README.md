# Padel Scoreboard — Xiaomi Smart Band 9 (Vela QuickApp)

Standalone Padel Scoreboard, Unforced Error (`MY UE`) tracker, and offline QR match trace for the **Xiaomi Smart Band 9 Global** (`192 × 490` capsule OLED).

- **Backlog:** [docs/backlog.md](docs/backlog.md)
- **Research & Learnings:** [docs/research-and-learnings.md](docs/research-and-learnings.md)
- **Hardware & Emulator Notes:** [docs/hardware-notes.md](docs/hardware-notes.md)

---

## Clean-Clone Quick Start (Dockerized — Zero Host Installs)

All CLI tools (`aiot-toolkit@2.0.5`, `esbuild`, `openssl`, Node 22 Maintenance LTS) run inside a single lean `node:22-alpine` container. Nothing needs to be installed on your host machine except Docker.

1. **Generate a disposable debug signing key** *(creates `sign/debug/{private,certificate}.pem`, ignored by Git)*:
   ```powershell
   docker compose run --rm --build dev npm run sign:debug
   ```
   *(Re-running validates and reuses a matching, unexpired pair; pass `-- --force` to atomically rotate. Never commit signing keys—back up any future release key outside Git.)*

2. **Build the signed Band 9 `.rpk` and offline HTML fixture**:
   ```powershell
   docker compose run --rm dev npm run build
   ```
   Outputs (gitignored):
   - `dist/com.padel.scoreboard.debug.0.1.0.rpk` (cryptographically verified against `sign/debug/certificate.pem`—checking RSA-SHA256 signature, chunked SHA-256 digest, and signer certificate SHA-256 fingerprint)
   - `dist-web/fixture.html` (standalone offline HTML using the exact same `src/core/` source)

3. **Run unit and signing/RPK verification tests (`node --test`)**:
   ```powershell
   docker compose run --rm dev npm test
   ```

> **After changing `package-lock.json`:** Run `docker compose run --rm --build dev ...` (or `docker compose up --build --force-recreate --renew-anon-volumes dev` if keeping a long-lived container) so the container's anonymous `/home/node/app/node_modules` volume picks up updated packages.

---

## Manual Verification Steps (Keep `S0.1` Open Until Both Pass)

1. **Offline Browser Check:** Copy `dist-web/fixture.html` **alone** into a folder with a space in its name (e.g., `C:\Temp\fixture test\fixture.html`), open it via `file://`, enable DevTools **Offline** + **Disable cache**, reload, and verify `#fixture-out` reads `30-15` with `0` HTTP(S) requests.
2. **Band 9 Simulator Check (Desktop AIoT-IDE):** Start the `192 × 490` Band 9 capsule simulator in **AIoT-IDE**, choose **Install Rpk**, select Docker's verified `dist/com.padel.scoreboard.debug.0.1.0.rpk` (no IDE rebuild), launch it, and record the displayed value + cap marker measurements in [docs/hardware-notes.md](docs/hardware-notes.md).
