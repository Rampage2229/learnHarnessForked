# LearnHarness — personal fork

Fork of https://github.com/amosblomqvist/learnharness (AGPL-3.0) with
personal customizations implemented at the **source level** — no binary
patching, everything survives upstream updates via normal git merges.

- **This repo**: https://github.com/Rampage2229/learningHarnessForked (private)
- **Upstream**: https://github.com/amosblomqvist/learnharness
- Branch layout: `personal` (the fork work, default branch) + `main` (clean
  upstream mirror)
- Currently based on upstream **v0.3.9** (merged) + the changes below.

---

## What this fork changes vs upstream

### 1. Custom OpenAI-compatible endpoint — now UPSTREAM-NATIVE (v4.0)

Upstream 4.0 shipped the official custom-endpoint feature (Settings →
Providers → + Add a provider → **Custom endpoint**): one
OpenAI-compatible server with auto-discovery, manual-ID fallback,
per-model budget pins, keyless mode, and vision delivery for all its
models (`docs/custom-providers.md` is upstream's authoritative doc).

This fork's earlier parallel implementation (`custom-providers.json`,
alias replacement, the Custom servers group) was **removed** in favor of
upstream's. The live setup was migrated through the official connect
flow (Logfare base URL + key → discovery). Notes:

- Re-entering the API key once was required after migration (the
  credential lives in auth.json under `CUSTOM_OPENAI_API_KEY`).
- Upstream discovery lists ALL the gateway's models (including non-chat
  ones like audio/embedding models) — pick chat models for the slots.
- Upstream does not carry per-model thinking-level maps (its reasoning
  declaration offers pi's default ladder); backends clamp server-side.

### 2. Local dictation bridge — Whisper, no Deepgram account

When the server runs with `LH_STT_BRIDGE_URL` set, dictation flows
through a local WebSocket service that speaks Deepgram's streaming
dialect (bearer subprotocol, linear16 frames, Results finals,
CloseStream → close 1000). The packaged shell sets that URL by default
(override or delete the env var to fall back to native Deepgram).

The bridge (`extras/lh-whisper-bridge.py`) is a full STT manager:
- **Engines**: Groq → Logfare → NVIDIA NIM → local faster-whisper, with
  automatic failover on errors *and* slowness (>8s strikes), and automatic
  recovery probes back to the cloud. NVIDIA NIM (`whisper-large-v3` via
  `https://integrate.api.nvidia.com/v1`, `NVIDIA_API_KEY` from the Keys
  page) is the third cloud engine; per-session `?engine=nvidia` is
  accepted and "NVIDIA NIM" appears in the dictation settings dropdown.
- **Repetition-loop repair**: degenerate transcripts ("de la base" ×60)
  are detected and re-decoded at higher temperature.
- **Per-run language auto-detection** (held ~6s for a reliable sample,
  then locked for the run) or a pinned code; nova-3 locale codes
  (`en-US`) normalize to primary subtags (`en`).
- ≤6s sequential POSTs under gateway body caps, O(n) buffering for
  arbitrarily long runs, 20s stop-safety in the client.
- The packaged app wires it by default; `extras/lh-whisper.service.template`
  runs it as a systemd user service.

### 3. Dictation settings UI + unified language

Settings → Providers → **Dictation** group:
- **Dictation provider**: Auto / Groq / Logfare / Local (bridge mode
  only — selects the bridge's engine).
- **Language**: upstream 0.3.9's dictation-language picker
  (`components/dictation-language.tsx`, Nova-3 language list incl.
  Catalan) — this fork unified it: the one preference drives **both**
  Deepgram and the bridge (the bridge receives it per-session via
  `/api/stt/token`; locale codes normalize; unset = per-run
  auto-detect — the factory default never pins English).

### 4. User memory — standing context injected into every teaching agent

Settings → **Memory**: plain-text entries ("my mandarin audio lives in
~/docs/mandarin") that the prober, teacher, and practice agents receive
as a prompt segment on every turn.

- `<data-dir>/memory.json` (`src/store/memory.ts` — atomic writes,
  never throws on read, 200-entry cap with oldest-eviction, 2000-char
  gate) rendered by `src/server/memory.ts` (newest-first, ~4000-char
  cap with a truncation note) and threaded into the agents via
  `AgentBuildOptions.memoryBlock` — `src/agent` never imports the
  store.
- **Agents can write memories too**: the `save_memory` tool (teacher +
  prober) stores durable learner facts mid-conversation ("file
  locations, preferences, goals — never lesson content"), confirming
  aloud after saving.

### 5. Topics — cross-chat knowledge organization

Named groups of SESSIONS over the one global knowledge graph: one chat
about grammar, another about speaking, both under a "Chinese" topic.

- **Node membership is derived, never tagged**: a node belongs to a
  topic when any provenance chatId is a session in that topic
  (`src/core/topics.ts`). Cross-chat node *identity* was already
  upstream's auditor behavior — topics add the organization layer.
- Graph view: a **Topics control** (create/rename/delete, per-cluster
  assignment), a topic **filter** over the canvas, and a topic **badge**
  under cluster labels (canvas text only — no physics changes).
- New sessions can be **born into a topic** (draft-composer picker →
  POST /api/chats `topicId`): the record carries the stamp, the sidebar
  row shows a badge, and the injected graph context **prefers the
  topic's propositions** (topic-first under the same 64-pick cap).
- **Auto-assignment** (Settings → Agent → New-session topics):
  - *Auto-assign* (default): a cheap-tier one-shot classifier reads the
    opening prompt against the existing topics (member chats + sample
    propositions) and assigns, creates a new topic, or leaves it
    unassigned — fully failure-isolated (any error → unassigned).
  - *Ask in chat*: the teacher gets `list_topics` / `assign_topic` /
    `create_topic` and asks the learner before acting.
- Not in v1: nested topics, manual node tagging, agent-written topic
  suggestions.

### 6. Assistant sessions + keyless web search (assistant wave)

A third session kind beside Teaching and Practice: **Assistant** — the
topic-anchored free-form chat.

- **Entry points**: the sidebar's third create door, or the
  "chat about this topic" icon on any topic row in the graph view's
  Topics panel (the draft opens pre-assigned to that topic).
- **The agent**: no probe/plan/quiz machinery — a plain chatbox that
  answers directly, runs tasks, and teaches opportunistically (brief
  corrections and connections in the flow, never a lesson). Doctrine
  lives in `src/agent/prompts/assistant/`; the curated shared fragments
  (voice, accuracy, mental-model, formatting) compose for it like for
  practice.
- **Topic context**: `session_summaries` reads each member session's
  COMPACTION SUMMARY (the distillation the session's own model already
  wrote) — the assistant knows what was covered without reading full
  transcripts. The gated map readers (`list_sessions`,
  `list_propositions`, `topic_overview`) ride the same settings gate as
  the teacher's.
- **`save_file`** (new tool, teacher + assistant): the harness's first
  write into the learner's disk — study artifacts (guides, summaries,
  notes) written ONCE, complete, home-anchored, parents auto-created;
  an existing file is never silently overwritten (`overwrite: true` is
  the explicit claim).
- **`read_session`** (v2): the deep read behind the summaries — one
  member session's actual transcript by id, serialized in the
  compaction summarizer's `[LEARNER]/[TUTOR]` format, sliced
  (offset/limit) and byte-capped like the fs tools.
- **`shell`** (shell wave): real bash on the learner's machine, for the
  assistant AND the teacher — LaTeX→PDF compiles, converters, scripts.
  Process-group kill on timeout (default 90s, max 300s) and on turn
  abort; 50KB output cap; non-interactive contract. Doctrine in the
  assistant's fragments: prefer the dedicated tools when they cover it,
  say one line before heavy system changes.
- The **sidebar's sessions list filters by topic** (a select under the
  kind filter, persisted, rendered only when topics exist) — the same
  scoping the graph view's filter has over the canvas.
- Assistant sessions never extract to the graph and carry their own
  compaction wording path; kind rides sync like `practice` does.

**Keyless web search**: DuckDuckGo joins Tavily/Brave as a search
engine — and it needs NO API key, so search (and the research tool)
works out of the box. Auto-resolution prefers a keyed engine (Tavily →
Brave) and falls back to DuckDuckGo; pinning is unchanged (Settings →
Agent → Search engine). The html-endpoint scrape is tolerant and fails
honestly when the markup moves.

### 10. Nextcloud sync (two-way, ledger-aware)

Settings → **Sync**: two-way sync of your durable data to a Nextcloud
WebDAV folder (`remote.php/dav/files/<user>/LearnHarness`) with an **app
password** (2FA-safe).

- **Synced**: chats, the knowledge graph (nodes/chains/coverage/sessions/
  sources/positions/render-settings/format), reviews, memory, topics, and
  settings (with the `customProvider` block stripped).
- **Never synced**: API keys (auth.json), credentials, the sync config +
  password, jobs, and migrated backups — excluded by construction, not by
  the user.
- **Merge law** (option B): whole-file JSON is last-writer-wins by mtime
  with the loser preserved as a `.conflict-<ts>` sibling; append-only
  JSONL ledgers union-merge (dedupe by line) so offline appends on either
  device are never lost. Deletions propagate unless the other side edited
  meanwhile (an edit wins over a delete).
- **Safety**: local writes are atomic (tmp+rename); one sync runs at a
  time; a sync racing a turn can never tear a file (worst case is a
  last-writer-wins flip the next sync reconciles). Auto-sync on boot +
  a configurable interval (Manual / 15 min / hourly); "Sync now" always
  available.
- Config/state live in `data/sync.json` + `data/sync-state.json` (mode
  0600), never returned to the client (the password is write-only).

### 10. Performance

- **Chat switching**: per-file (mtime,size) record cache in the chat
  store; the per-message sha256 coverage fold and the session-cost fold
  cached; the mount-time duplicate full-record fetch eliminated; message
  wrappers render with `content-visibility: auto` (offscreen paint skip).
- **App startup**: `preloadEntriesOnStart: false` (the standalone server
  no longer evaluates all ~41 route module graphs while booting), a
  microsecond `/api/health` liveness endpoint replaces the full-home-SSR
  health poll, and the subscription-SDK import boots concurrently with
  the server instead of serializing ahead of it.
- Measured on the live data dir (7 chats / 2.5MB): chat open
  6.7ms → **0.06ms** cached (plus the eliminated duplicate fetch/parse),
  sidebar 13.3 → 0.5ms, startup spawn→server-up ~2.7s → **0.33s**.

### 10. Packaging — fork-safe Linux builds

- `npm run dist:linux` builds `LearnHarness-<version>-x86_64.AppImage`.
- The upstream **update feed is removed** (`publish: null` +
  after-pack strips `app-update.yml`): a fork build can never
  self-update into an upstream release and lose the customizations.
  Updates come from rebuilding the fork.
- The packaged shell defaults the dictation bridge URL (see §2).

### 10. Tooling (`extras/`)

| File | Purpose |
|---|---|
| `lh-whisper-bridge.py` | The dictation bridge (header documents engines, contract, env vars). |
| `generate-custom-providers.py` | Build `custom-providers.json` from a live model catalog. |
| `lh-stt-engine.sh` | Switch dictation engine / compare cloud latencies. |
| `lh-whisper.service.template` | systemd user unit for the bridge. |

---

## Running from source (dev)

```bash
npm install
cp .env.local.example .env.local   # already configured on this machine
systemctl --user restart lh-whisper
npm run dev                        # http://localhost:3000
```

`.env.local` points `LH_DATA_DIR` + `LH_AUTH_FILE` at the desktop
install's data dir (`~/.config/LearnHarness/data`) — chats, knowledge
graph, settings and keys carry over. `.env.local` is gitignored; the
example file documents the keys.

## Local install convention (the owner's machine)

The AppImage lands at a STABLE path — `~/Applications/LearnHarness.AppImage` — never a versioned copy: appimagelauncherd used to register every versioned copy as its own launcher entry, and the desktop bar filled with "LearnHarness (0.4.x)" duplicates. The daemon is disabled (`enable_daemon = false` in `~/.config/appimagelauncher.cfg`), one hand-written `learnharness.desktop` points at the stable path, and electron-updater replaces the file in place on update — the name survives. Old versioned copies: deleted, the GitHub release is the archive.

## Release process (speed-wave lessons)

- **Upload order matters**: the `.yml` update feeds must land LAST, after
  the artifacts they checksum. A 0.5.2 upload glitch left GitHub's
  `latest-linux.yml` disagreeing with the AppImage, and the updater
  burned a full 180MB download per launch, failed the checksum, and
  repeated — the user-visible "a minute to start". After uploading,
  VERIFY: fetch the remote yml back and hash the remote AppImage against
  it.
- electron-builder's `publish` config ALSO uploads the build artifacts
  during `dist:linux`/`dist:win` (releaseType "release") — don't double
  the uploads blindly; check what the release already carries.
- **Route preloading**: `preloadEntriesOnStart: true` (fork ruling) —
  the standalone server evaluates every route's module graph during the
  health-poll window, so no first navigation pays a lazy module load
  per launch (upstream's lazy default measured 1.1–1.8s on home, the
  chats list, and big chat pages, EVERY boot).

## Building the AppImage

```bash
npm run dist:linux                 # → dist/LearnHarness-<version>-x86_64.AppImage
```

## Updating from upstream

```bash
git fetch upstream                 # upstream = amosblomqvist/learnharness
git merge upstream/main            # or rebase
```

Conflicts concentrate in `components/dictation.tsx`,
`components/settings/keys-section.tsx`, `src/server/settings-body.ts` and
its test (the fork's dictation/settings surface). The customization
surface is deliberately small — one new core module + one server module +
the dictation touches + the settings seams — to keep merges cheap.

## Remotes

```
origin    → https://github.com/Rampage2229/learningHarnessForked (this repo)
upstream  → https://github.com/amosblomqvist/learnharness
```

`personal` is the default branch (the fork work); `main` mirrors
upstream. Private repo — AGPL-3.0 obligations only apply if the AppImage
is distributed (then make the repo public).

## Licensing

- **AGPL-3.0-only**, inherited from upstream (`LICENSE` — the full GNU
  AGPL v3 text). All fork additions are original work under the same
  license; the AGPL's copyleft applies to the whole derivative.
- **No user data is committed**: `.gitignore` excludes the data dir,
  `auth.json`, `.env*` (only the placeholder `.env.local.example`
  ships), and credential files. Verified before going public.
- **The AppImage** bundles upstream's already-licensed dependencies
  (Electron MIT, Next.js MIT, pi-ai MIT, etc.) — the same set upstream's
  own release carries; their notices ship inside the package as upstream
  did. Rebuilding and publishing the AppImage does not add obligations
  beyond the AGPL source requirement (satisfied by this public repo).
- **The dictation bridge's Python dependencies** (`faster-whisper` MIT,
  `websockets` BSD-3-Clause) are installed separately into a venv at
  runtime (`extras/lh-whisper.service.template`), never bundled into the
  repo or the AppImage.

## Upstream divergence map (merge triage)

| Area | Fork touches | Upstream risk |
|---|---|---|
| `src/core/custom-providers.ts`, `src/server/custom-providers.ts`, `app/api/custom-providers/*` | fork-only files | none |
| `src/agent/models.ts` (piModels registration) | one block | low |
| `src/server/model-catalog.ts` (catalogProviders concat) | small | low |
| `components/dictation.tsx` (bridgeWsUrl + safety) | two spots | medium (upstream iterates dictation) |
| `app/api/stt/token/route.ts` (bridge branch) | one block | low |
| `components/settings/keys-section.tsx` (Custom servers + stt rows) | additive | medium |
| `src/core/settings.ts` / `settings-body.ts` / `settings-resolution.ts` (`stt` section, `topicAssignment`, fossil-skip loop) | additive | medium |
| `app/api/chats/route.ts` (topicId + classifier) | one block | low |
| `scripts/after-pack.cjs`, `electron-builder.yml` (publish: null), `electron/main.cjs` (bridge default + boot reorder) | small | low |
| `scripts/verify-release.ts`, `tests/desktop-platform.test.ts` (fork packaging pins) | small | low |
| `tests/custom-providers/topics/memory-tool/stt-settings/*.test` | fork-only | none |

License: AGPL-3.0, inherited from upstream.
