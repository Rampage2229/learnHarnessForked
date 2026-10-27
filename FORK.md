# LearnHarness — personal fork

Fork of https://github.com/amosblomqvist/learnharness (AGPL-3.0) with
personal customizations implemented at the **source level** — no binary
patching, everything survives upstream updates via normal git merges.

## What this fork adds

### 1. Custom OpenAI-compatible chat providers (`custom-providers.json`)

Register any OpenAI-compatible gateway as a first-class provider:

- Definitions live in `<data-dir>/custom-providers.json` (see
  `extras/generate-custom-providers.py` — builds the file from a live
  `/v1/models` catalog, with reasoning-effort maps and compat overrides
  learned on real gateways).
- Registered into the pi-ai engine next to the builtins
  (`src/core/custom-providers.ts` → `src/agent/models.ts`); the model
  picker federates them exactly like builtins
  (`src/server/model-catalog.ts`).
- **Alias ids replace colliding builtins**: an existing data dir whose
  settings/chats pin e.g. `together` keeps working against the custom
  endpoint.
- API keys ride the standard env seam (`apiKeyEnvVar` in auth.json or
  the environment).

### 2. Local dictation bridge (Whisper via a local WebSocket service)

`components/dictation.tsx` + `app/api/stt/token/route.ts` gain a bridge
mode: when the server runs with `LH_STT_BRIDGE_URL` set, the dictation
WebSocket points at a local STT service that speaks Deepgram's streaming
dialect (bearer subprotocol, linear16 frames, Results finals,
CloseStream → close 1000). No Deepgram key needed; the stop-time safety
net widens to 20s for the remote final flush.

- The bridge itself: `extras/lh-whisper-bridge.py` — engines: Groq →
  Logfare → local faster-whisper, with automatic failover on
  errors/slowness, repetition-loop repair, per-run language
  auto-detection, ≤6s chunking. See the header of that file for the
  full contract and env vars.
- Systemd unit template: `extras/lh-whisper.service.template`.

### 3. Tooling (`extras/`)

| File | Purpose |
|---|---|
| `lh-whisper-bridge.py` | The dictation bridge (see header for config). |
| `generate-custom-providers.py` | Build `custom-providers.json` from a live model catalog. |
| `lh-stt-engine.sh` | Switch dictation engine / compare cloud latencies. |
| `lh-whisper.service.template` | systemd user unit for the bridge. |

## Running from source (dev)

```bash
npm install
cp .env.local.example .env.local    # points LH_DATA_DIR at your existing
python3 extras/generate-custom-providers.py   # app data dir; edit to taste
systemctl --user restart lh-whisper           # bridge running?
npm run dev                        # http://localhost:3000
```

With `LH_DATA_DIR` aimed at the desktop install's data dir
(`~/.config/LearnHarness/data`), your existing chats, knowledge graph,
settings and keys all carry over. Put your gateway key in that data
dir's `auth.json` (e.g. `LOGFARE_API_KEY`).

## Updating from upstream

```bash
git remote add upstream https://github.com/amosblomqvist/learnharness.git   # already set as "origin"
git fetch origin
git merge origin/main        # or rebase; conflicts concentrate in
                             # components/dictation.tsx and the token route
```

The customization surface is deliberately small (one new core module,
one engine line, two dictation touches, one route) to keep merges cheap.

## Publishing your fork

```bash
git remote rename origin upstream
git remote add origin git@github.com:<you>/learnharness.git
git push -u origin personal        # this branch carries the customizations
```

License: AGPL-3.0, inherited.
