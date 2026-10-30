# How to run LearnLens on a Linux VPS with tmux

Native Node/ONNX speech, no Docker. This is a **prospective runbook**, not a verified VPS deployment: your OS, architecture and RAM have not been supplied. Complete the checks below on your actual host. For a local Windows machine, see [WINDOWS.md](WINDOWS.md).

## 1. Prerequisites

- A non-root account, a trusted LearnLens checkout (examples use `~/LearnLens`), Git and tmux.
- Debian/Ubuntu with glibc and native dependency support for your architecture. Use Node.js **22.x, at least 22.9.0**. The project requires Node >=22.9; 22 is the tested major, not a guarantee for every host.
- Start planning around **2 GB RAM or more** for a small trial. This is an estimate, not a measured minimum or concurrency guarantee. Monitor real memory/CPU usage.
- Writable disk and network access for project-local npm dependencies, the pinned Q8 model (about **92 MB**) and supporting speech assets/cache. The model size is not the total installation size.

No Python, Docker, GPU or system eSpeak installation is required. Run one app instance only: browser sessions live in memory.

## 2. Install project dependencies and configure access

These are instructions to run yourself, not commands already executed for you. Adapt the checkout path; do not run the app as root.

For a first checkout, run `git clone https://github.com/cjrujo/LearnLens.git ~/LearnLens`. If it already exists, keep it and skip cloning.

```sh
cd ~/LearnLens
node --version
npm ci
umask 077
nano .env
chmod 600 .env
```

Use your preferred editor instead of `nano` if needed. The repository-root `.env` is loaded automatically; existing shell environment variables take precedence. Do not `source` it. Keep `.env` out of Git.

Choose **one** access mode before starting:

### Public private-beta access: HTTPS only

In `.env`, keep the app on loopback and replace the example domain with your real domain:

```dotenv
HOST=127.0.0.1
PORT=3210
PUBLIC_ORIGIN=https://real.domain
# Fill this in the editor before starting; never leave it empty for public access.
LEARNLENS_ACCESS_PASSWORD=
LEARNLENS_SPEECH_THREADS=2
```

Generate a unique random password of **at least 16 characters** in a password manager and paste it into `.env` using the editor. Never echo real secrets into shell history, chat or Git. Apply `chmod 600 .env` after saving. This shared-password gate is for a small trusted beta, not a full account system.

Have DNS point your domain at the VPS and arrange an HTTPS reverse proxy. For an already-installed Caddy, the site block is:

```caddyfile
real.domain {
    reverse_proxy 127.0.0.1:3210
}
```

Preserve the original `Host` header; do not rewrite it to `127.0.0.1`. Caddy's normal HTTP upstream proxying preserves it. DNS and inbound **80/443** must work for normal certificate issuance and HTTPS access. Keep SSH access as required, but **do not open port 3210 or any speech port** in the firewall. If adding proxy limits, allow at least 13 MB requests and several minutes for generation. Do not offer the app over public HTTP.

### No domain yet: SSH tunnel for temporary testing

Keep only these local settings in `.env`; leave `PUBLIC_ORIGIN` and `LEARNLENS_ACCESS_PASSWORD` unset, including in the shell environment:

```dotenv
HOST=127.0.0.1
PORT=3210
LEARNLENS_SPEECH_THREADS=2
```

After starting the app, run this on **your own computer**, not inside the VPS session:

```sh
ssh -N -L 127.0.0.1:3210:127.0.0.1:3210 your-user@your-vps
```

Keep the tunnel open and visit `http://127.0.0.1:3210` locally. This HTTP endpoint is local-only; transport to the VPS is encrypted by SSH. Do not replace the bind address with `0.0.0.0` or expose an IP-based public HTTP URL. Switch to HTTPS configuration before inviting remote users.

## 3. Prepare speech and run in tmux

From the checkout:

```sh
npm run setup:speech
tmux new -s learnlens
npm start
```

`setup:speech` separately downloads/prepares, SHA-256-verifies and warms the speech cache, then exits. It is optional: `npm start` also prepares a missing cache on first startup, starts managed native Node/ONNX Kokoro, then launches the web app. First startup needs network access and may take longer. Wait for the app-ready message.

Speech files live in **`.cache/speech/`**. Keep that directory between restarts/updates. The speech worker uses an ephemeral loopback port and a private per-process key; neither belongs in the reverse proxy, firewall rules or learner settings.

- Detach without stopping: **Ctrl+B**, release, then **D**.
- Reconnect: `tmux attach -t learnlens`.
- Gracefully stop both managed processes: attach, then **Ctrl+C**; wait for shutdown before starting again.

Tmux survives an SSH disconnect, **not a reboot or process crash**. It is not a service manager and does not automatically restart a failed app. Restarting clears browser-session providers, API keys and settings; users must configure them again.

## 4. Verify before sharing

These are acceptance checks, not claimed test results.

1. Check `/health` **through the configured public hostname**:

   ```sh
   curl --fail --show-error https://real.domain/health
   ```

   Expect HTTP 200 with `{"ok":true}`. With a tunnel/local configuration, open `http://127.0.0.1:3210/health` instead. In hosted mode, a direct loopback request has the wrong Host and can return 403; do not weaken host checks. Health confirms HTTP availability, not speech/model readiness.
2. Open the same origin in a browser. For HTTPS beta mode, verify the password gate, then sign in. In **AI providers**, confirm the speech role is **built-in Kokoro**, voice **`af_heart`**, with no speech URL or speech API key needed. New native-start sessions should select it automatically.
3. Run its **speech capability test** and explicitly consent to the short synthetic sample. Check the result; this is local server synthesis, not a cloud speech call. A successful sample is not proof of pronunciation or language quality.
4. Only with your own provider and permission for any charges, configure a **cloud primary** model, save roles, and generate a small non-sensitive English lesson with audio enabled. Primary generation needs network access; built-in speech remains local. Check the preview, listen to the audio, and check any warnings. No provider purchase or paid test is required just to start the app; **Try a local example** checks the UI without a model call but does not validate generation or speech.
5. Download the HTML, disconnect the viewing computer from the network, and open the file in a browser. Verify text, images, answer reveals and successfully embedded audio/playback speeds. Generating new lessons/audio, follow-up AI calls and transcription are not offline features.

## Controls, troubleshooting and updates

Set optional controls in `.env`, then restart:

| Setting / command | Effect |
| --- | --- |
| `LEARNLENS_SPEECH_OFFLINE=1` | Require an existing valid cache; fail clearly if absent. Prepare it online first. This does not make npm installation or cloud generation offline. |
| `LEARNLENS_SPEECH_MODE=disabled` | Explicitly opt out of the managed speech engine. |
| `LEARNLENS_SPEECH_THREADS=2` | Default CPU thread count; tune only after measuring on your host. |
| `npm run start:lite` | Development-only Node app without starting the native engine. |
| `KOKORO_BASE_URL` | Advanced operator override for an external engine, not normal setup. Leave unset for managed speech; never expose a worker publicly. |

- Cache/download/checksum failure: check connectivity, free disk and checkout/cache ownership, then retry `npm run setup:speech`. Do not bypass hash verification. With offline mode set, missing assets cannot be downloaded.
- Native loading failure: verify Node version, glibc and architecture compatibility. This guide does not claim every VPS architecture was tested.
- Out-of-memory or slow speech: reduce workload, inspect resource use and reassess RAM/thread count. Do not start extra app instances to work around it.
- HTTPS/403 trouble: check DNS, TLS, `PUBLIC_ORIGIN`, preserved Host and stale shell overrides. Keep loopback binding and authentication intact.

**Stop the old process first** with Ctrl+C in tmux. Then, in that same checkout/session, update only if each preceding command succeeds:

```sh
git pull --ff-only && npm ci && npm run setup:speech && npm start
```

Do not reset local changes if the fast-forward fails. Keep `.env` and `.cache/speech/`; review changes before retrying. Re-run the verification checklist after updates. Do not launch a second tmux/app instance while the old one still runs.

## Privacy and language limits

Native Kokoro is **CPU, English-only**, using `af_heart`. For unsupported languages, disable audio or explicitly choose a compatible online speech provider; there is **no automatic paid fallback**. A speech failure should leave the text lesson available with a warning.

Built-in synthesis runs on the VPS, not in the browser. Cloud-primary text/images go to your selected provider; optional cloud speech/transcription send their respective scripts/recordings there. Provider retention policies apply. Keys and session settings are held in server memory, so trust the host; they are not embedded in exported HTML. Exports can still contain private source material and audio. Use non-sensitive test inputs, share downloads carefully, and review AI teaching content. Speech/transcription is not a validated pronunciation assessment.
