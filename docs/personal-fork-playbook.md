# Personal fork — operator's playbook

Practical guide to the features added this week on the `personal` branch. Dry, imperative, no marketing. Every path and command here is verified against the code on this branch; mismatches are listed at the end.

Paths use the **live data dir**. On the desktop install that is `~/.config/LearnHarness/data` (set by `LH_DATA_DIR`); in `npm run dev` it follows `.env.local`, which on this machine points at the same place. Where a feature stores a file, the path is given relative to that data dir.

---

## 1. Handwritten notes → graph

Export the PDF from the e-ink tablet and import it through the per-file import route.

1. On the graph view, open **Extract files…** (the `Waypoints` button, top-right) and choose **Files**. Select the PDF.
2. The route is `POST /api/graph/import` (multipart field `files`; optional `paths` for folder-relative identity). Caps: **25 MiB total** (`MAX_IMPORT_BYTES`), **1,000 pages per PDF** (`MAX_PDF_PAGES`).
3. The PDF is converted to Markdown by pdf.js. Pages with a text layer become Markdown directly. **Image-only pages** (handwriting, scans — no text layer) go through the **vision slot**: each is rendered at 200 DPI and sent to the vision model once for a verbatim Markdown transcription. The transcription prompt requires:
   - verbatim Markdown, reading order preserved;
   - math in LaTeX — inline `$...$`, display `$$...$$`;
   - structure (headings, lists, tables) preserved;
   - illegible spans marked `[illegible]`, no guessing, no commentary.
4. **20-page cap** on vision transcription (`DEFAULT_TRANSCRIPTION_PAGE_CAP`). The first 20 image-only pages are transcribed; the rest are skipped with a notice. Re-import with fewer pages or split the notebook.
5. A vision model must be set: **Settings → Models → Vision**. If none is set, the import refuses with “Handwritten pages need a vision model — set one in Settings → Models.”

**Where the cache lives.** Each transcribed page is cached as JSON under `<data dir>/pdf-transcriptions/`. The file is `<sha256 of the PDF file bytes>-p<page>.json` (`transcriptionCacheKey`). Same file + same page → cache hit, no render, no model call. Re-importing the same notebook is free. The cache read/write never throws; a corrupt or unwritable cache degrades to a fresh transcription.

Source: `app/api/graph/import/route.ts`, `src/server/pdf-transcribe.ts`.

---

## 2. Folder / Obsidian vault import

Import a whole on-disk folder in one action. Desktop only (it uses Electron’s native folder picker).

1. **Extract files… → Import folder…** (the folder entry appears only in the desktop app; browsers keep the `webkitdirectory` Folder choice).
2. Pick a folder. A **dry run** lists the importable files first: “Import N notes (X.XMB)?” with a Folder-capped notice if a cap bit. Confirm to import.
3. The route is `POST /api/graph/import-folder` with `{ path, dryRun }`. Real import runs the same extraction pipeline as the per-file route, 3 files at a time, per-file error isolation.

**Skipped:** `.obsidian`, `.git`, `.trash`, and any dot-prefixed directory; hidden files (`.DS_Store`, `.gitignore`, …); symlinks (never followed); wrong extensions. Accepted extensions: `.md`, `.markdown`, `.txt`, `.pdf` (`IMPORT_EXTENSIONS`).

**Caps:** **200 files** (`MAX_FOLDER_FILES`), **25 MiB total** (`MAX_IMPORT_BYTES`), **depth 8** (`MAX_DEPTH`). Once the file count cap truncates the walk, the rest of the vault is neither collected nor counted.

**Home-anchoring.** The path resolves against `os.homedir()` (`~` and `~/…` expand; relative paths resolve under home). A path that canonicalizes outside the home tree is refused. PDFs are detected by their `%PDF-` magic bytes, not their name; PDFs convert to page-marked Markdown first.

Source: `app/api/graph/import-folder/route.ts`, `lib/notes-import-limits.ts`.

---

## 3. Inbox auto-import

The vault watcher: a watched folder is scanned, and new or changed files are imported through the same extraction pipeline as the folder import. There is **no in-app UI and no automatic trigger** — it is a manual API call. Point it at the folder Nextcloud syncs onto disk.

The route is `POST /api/graph/inbox` with `{ dir, dryRun }`. `GET /api/graph/inbox` returns `{ tracked, lastScanAt }`.

**Dry run first.** List what would be imported without reading contents or making model calls:

```sh
curl -s localhost:3000/api/graph/inbox \
  -H 'content-type: application/json' \
  -d '{"dir":"~/Nextcloud/Notes","dryRun":true}' | jq
```

Returns `{ files: [{ path, size, kind }], tracked }` — the new-or-changed files (folder-relative POSIX paths) plus the count of currently-tracked files.

**Run the import** (omit `dryRun`) after Nextcloud has synced the files to disk:

```sh
curl -s localhost:3000/api/graph/inbox \
  -H 'content-type: application/json' \
  -d '{"dir":"~/Nextcloud/Notes"}' | jq
```

Returns `{ results: [{ filePath, ok, outcome, stats?, error?, notice? }], tracked }`. Per-file error isolation (one bad file never aborts the batch), 3-wide concurrency, PDFs converted first — all mirrored from the folder-import route. Successfully imported files are committed to the watch state so the next scan skips them; **failed files stay “new” and are retried next scan**. Files deleted from the inbox are untracked.

**Watch state.** Lives at `<data dir>/graph/vault-watch-state.json` — a JSON object keyed by absolute path → `{ mtimeMs, size, importedAt }`. A file is **new** (absent from state) or **changed** (mtimeMs or size differ). State I/O is atomic and never throws; a corrupt state reads as “nothing tracked yet” and the next scan re-imports.

**Scope notes.** The inbox walk is shallower than the folder import: **max depth 3** (`MAX_WATCH_DEPTH`). The same skip rules apply (`.obsidian`/`.git`/`.trash`, dot-prefixed dirs, hidden files, symlinks, wrong extensions). The folder must be inside the home tree (`~/Nextcloud/Notes` qualifies; create it and let Nextcloud populate it). Nothing calls this route automatically — run it when you want the import; “run on sync” means you run it after Nextcloud has synced.

Source: `app/api/graph/inbox/route.ts`, `src/server/vault-watch.ts`.

---

## 4. Today / retention loop

The **Today** card sits on the graph view (the `RetentionCard`, centered above the canvas). It shows the due count, a struggling count when any node is struggling, and a **Start review** button.

- **Due.** A graph node is due for review under SM-2-lite (`src/core/reviews.ts`):
  - last graded **wrong / don’t know** → due immediately;
  - last graded **correct** → due past its interval on the ladder `[1, 3, 7, 14, 30]` days by correct-streak;
  - last graded **seen** (ungraded — teaching checks record “seen”) → **decays into due after the base interval, 1 day**, so taught material re-surfaces on its own;
  - never reviewed → neutral, never due.
  Only nodes still present in the graph count (a review state for a deleted node is not selectable).
- **Struggling.** Two or more wrong/don’t-know reviews on a node (`STRUGGLING_MIN_WRONG = 2`), worst first, capped at 5.
- **Daily review target.** The headline caps the due count and the minutes estimate at this number so a 256-node backlog stays a livable day. Set it at **Settings → Agent → Daily review target** (`agent.dailyReviewTarget`). Default **20**, allowed **5–100**; empty = the 20 default, a commit clamps into range. The full due set is still lifted for the preset — only the *headline* is capped.
- **Start review.** The button preselects every due node and opens the practice picker. Label: `Start review · <capped count> (~<capped minutes> min)` when a target is set, else `Start review (~<minutes> min)`. Hidden when nothing is due.

The minutes estimate is `max(5, dueCount)` — one minute per due node, never below the 5-minute floor.

Source: `src/core/today.ts`, `src/core/reviews.ts`, `components/use-retention.tsx`, `components/minimal-home.tsx` (`TodayBand`), `components/graph-view.tsx`.

---

## 5. Goals

Set one goal — the aim the teaching agents serve.

- **Where.** The goal line rides the Today card: a quiet **Set a goal** pill when none is active, or **Working toward: \<title>** (with an optional detail line) when one is set. Click the line to open the small inline editor (title required, detail optional), then **Save**. **Mark done** and **Clear** act on the active goal.
- The backend keeps at most one active goal; creating a new one silently archives the previous (`POST /api/goals` with `{ title, detail? }`; `PUT /api/goals/<id>` to edit; `DELETE /api/goals/<id>` to clear). The record lives at `<data dir>/goals.json`.
- **Every agent composes it into the system prompt.** The active goal is read fresh off disk each turn and appended to the system prompt of the **prober, teacher, practice, and assistant** agents, in order: base doctrine → flow rhythm → **goal** → memory → topic line. No active goal → the prompt is byte-identical to the pre-goal composition. The block names the goal and tells the agent every plan and step serves reaching it.

Source: `src/server/goal-block.ts`, `src/agent/teacher-agent.ts` (`baseAgentOptions`), `app/api/goals/route.ts`, `components/minimal-home.tsx` (`GoalBand`).

> Note: see **Discrepancies** — the goal editor is currently unreachable from the graph view (the owner’s default home).

---

## 6. Teaching rhythm

**Settings → Agent → Teaching rhythm** (`agent.flowMode`). A two-way segmented control:

- **Guided** (default, `guided`) — one step per turn, checked every step.
- **Flow** (`flow`) — runs of 3–6 connected steps per turn, one check covering the run at the end.

Pick **Guided** when you want each step confirmed before the next is built on it (the default repair-before-building discipline). Pick **Flow** when the steps are tightly connected and you want the run to flow without a check between each step; the single check still gates the whole run. Absent record key reads as Guided.

Source: `components/settings/agent-section.tsx`, `src/core/settings.ts`, `src/core/settings-resolution.ts`.

---

## 7. Math input

Type math fast on a keyboard, without dictation, inside the **Thinking while reading** field (the reading-thinking textarea, mounted while a teach-phase check waits behind its reveal).

- **`$...$` shorthand.** Wrap math in `$...$` (inline) or `$$...$$` (display). Only text **inside** a math span is rewritten; prose keeps its slashes, asterisks, and parentheses. An escaped `\$` never opens a span; an unclosed `$` never swallows the rest of the text. The expansion is shown in a **live preview** strip rendered through KaTeX.
- **The `∑ ½` palette.** The small `∑ ½` button opens a row of labeled snippets; clicking one inserts the LaTeX at the caret (and lands the caret inside the first `{}`). Examples: Fraction → `\frac{}{}`, Square root → `\sqrt{}`, Sum → `\sum_{}^{}`, Integral → `\int_{}^{} \, d`, Limit → `\lim_{ \to }`, 2×2 matrix → `\begin{pmatrix} a & b \\ c & d \end{pmatrix}`.
- **What expands to what** (shorthand typed inside a `$...$` span → LaTeX the preview renders):

  | Type | Expands to |
  | --- | --- |
  | `alpha` … `omega` (and capitals `Gamma` … `Omega`) | `\alpha` … `\omega` (`\Gamma` … `\Omega`); word-boundary matched |
  | `RR` / `NN` / `ZZ` / `QQ` / `CC` | `\mathbb{R}` / `\mathbb{N}` / `\mathbb{Z}` / `\mathbb{Q}` / `\mathbb{C}` |
  | `oo` | `\infty` |
  | `...` | `\dots` |
  | `<=>` / `=>` / `->` | `\Leftrightarrow` / `\Rightarrow` / `\to` |
  | `!=` / `<=` / `>=` / `+-` | `\neq` / `\leq` / `\geq` / `\pm` |
  | `sqrt(...)` | `\sqrt{...}` (closes the brace at the matching `)`) |
  | `int_` / `sum_` / `prod_` / `lim_` | `\int_` / `\sum_` / `\prod_` / `\lim_` |
  | `*` | `\cdot` |
  | `deg` | `^\circ` |

  Expansion is idempotent — already-expanded text passes through unchanged. Already-LaTeX input (`\alpha`, `\frac{}{}`) is left alone.

The stored thinking text keeps the shorthand; the preview is the expanded view. Source: `src/core/math-shorthand.ts`, `components/math-composer.tsx`, `components/reading-thinking.tsx`.

> Note: see **Discrepancies** — the palette/shorthand is wired into the reading-thinking field only, not the answer’s “Your thinking” field or the chat composer.

---

## 8. Dictation

Local dictation through a Whisper bridge instead of Deepgram. The bridge (`extras/lh-whisper-bridge.py`) is a full STT manager with automatic failover.

- **Engines.** Groq → Logfare → NVIDIA NIM → local faster-whisper, in that auto-order. `Auto` (the bridge’s delegate) picks the first cloud engine with a resolvable key, else local. Failover is automatic on errors *and* slowness, with recovery probes back to the cloud.
- **Logfare is configured as a custom provider.** Logfare is connected through **Settings → Providers → + Add a provider → Custom endpoint**, so its key lives in `auth.json` under **`CUSTOM_OPENAI_API_KEY`** (the custom-endpoint key), not a Logfare-specific row. The bridge resolves the key the same way: it reads `CUSTOM_OPENAI_API_KEY` (falling back to the legacy `TOGETHER_API_KEY`) and the custom-provider binding’s base URL from `auth.json`. NVIDIA NIM keys on `NVIDIA_API_KEY`; Groq on `GROQ_API_KEY`; local needs no key.
- **The bridge service.** Runs as a systemd user unit:
  ```sh
  systemctl --user status lh-whisper
  systemctl --user restart lh-whisper
  ```
  The unit template is `extras/lh-whisper.service.template` (the deployed copy lives at `~/.config/systemd/user/lh-whisper.service`; `ExecStart` points at the venv Python and the bridge script). The packaged app sets `LH_STT_BRIDGE_URL=ws://127.0.0.1:8765/v1/listen` by default (`electron/main.cjs`); `.env.local` sets the same for `npm run dev`. Delete the env var to fall back to native Deepgram.
- **“Multilingual” means auto-detect.** The dictation language picker (Settings → Providers → **Dictation** → **Language**) includes **Multilingual** (code `multi`). The token route omits the `language` param for `multi`, so the bridge **auto-detects per run**: it holds the first ~6 s of audio for a reliable sample, detects the language, then locks it for the rest of that run. Pin a concrete code (e.g. `en`, `es`, `ca`) to skip detection. Nova-3 locale codes (`en-US`) normalize to primary subtags (`en`).
- **Pick an engine.** **Settings → Providers → Dictation → Dictation provider** (the row appears only when the bridge is configured). Options: Auto / Groq / Logfare / NVIDIA NIM / Local. The row fetches `/api/stt/status` and appends “(no key)” to any engine without a credential, and shows a reason line under the select. A pinned-but-unkeyed engine silently falls back to the bridge default at request time. The choice persists via `PUT /api/settings/stt` with `{ provider }`.

Source: `extras/lh-whisper-bridge.py`, `extras/lh-whisper.service.template`, `app/api/stt/token/route.ts`, `app/api/stt/status/route.ts`, `components/settings/dictation-stt.tsx`, `components/dictation-language.tsx`, `src/core/dictation.ts`.

---

## 9. Local install discipline

The AppImage must stay at one stable path, or appimagelauncher registers every versioned copy as its own launcher entry and the desktop bar fills with “LearnHarness (0.4.x)” duplicates.

1. **The wrapper.** `~/.local/bin/learnharness` exports `APPIMAGELAUNCHER_DISABLE=1` (the binfmt interceptor itself honors it and execs the AppImage directly) and execs `~/Applications/LearnHarness.AppImage --no-sandbox`. The rofi entry points at this wrapper, never at an AppImage.
2. **Never click “Integrate and run”.** A downloaded AppImage offered in the browser, if clicked, triggers appimagelauncher’s binfmt interceptor, which **renames** the file to `LearnHarness_<md5>.AppImage` and registers a per-version desktop entry. When a new release lands: quit the app, copy the new file over `~/Applications/LearnHarness.AppImage`, and launch from rofi (or let the in-app updater replace the stable file in place).
3. **Stable AppImage path.** `~/Applications/LearnHarness.AppImage` — never a versioned copy. The desktop entry (`~/.local/share/applications/learnharness.desktop`) points at the wrapper; electron-updater replaces the file in place on update, so the name survives.
4. **appimagelauncherd disabled.** `enable_daemon = false` in `~/.config/appimagelauncher.cfg`; binfmt registration stays system-level but is bypassed for every launch that matters.

Verify on this machine:

```sh
cat ~/.local/bin/learnharness          # the wrapper (APPIMAGELAUNCHER_DISABLE=1 → exec the stable AppImage)
ls -l ~/Applications/LearnHarness.AppImage   # the one stable path
cat ~/.local/share/applications/learnharness.desktop   # Exec= points at the wrapper
grep enable_daemon ~/.config/appimagelauncher.cfg     # false
```

Source: `FORK.md` (the “Local install convention — ROUND 2” section); the wrapper, desktop entry, and `.cfg` are machine files, not in the repo.

---

## Discrepancies vs. the code

Behaviors the task brief describes that do not match what the code actually does. These are bugs for you to fix — the guide above documents what the code does, not what the brief assumed.

1. **The goal editor is unreachable from the graph view (the owner’s default home).** `components/graph-view.tsx` renders `GoalBand` with `editing={false}` hardcoded and all write callbacks as no-ops; `onEditStart` does `router.push("/?goal=1")`. **No code reads the `goal` query param** — neither `app/page.tsx`, `components/home.tsx`, nor `components/minimal-home.tsx` consumes it. The navigation just reloads `/` (graph rendering is ON by default → `GraphView` again), and the editor never opens. The inline goal editor works only when graph rendering is OFF (the `MinimalHome` path). Effect: with the default settings, “Set a goal” / “Working toward: …” on the graph view is a dead click; you cannot set or edit a goal from the graph view.

2. **The math palette/shorthand is wired into one thinking field, not “thinking fields.”** `MathComposer` is mounted only in `components/reading-thinking.tsx` (“Thinking while reading”). The answer’s “Your thinking” field (`components/question-dock.tsx`) and the chat composer (`components/composer.tsx`) do **not** have the palette or the live preview. If the intent was “all thinking fields,” the answer thinking field and the composer are missing it.

3. **Inbox auto-import has no UI and no automatic “run on sync.”** `POST /api/graph/inbox` is API-only — no component references it, and nothing triggers it on a Nextcloud sync completing. The guide documents it as a manual call after sync; if an automatic “on sync → import” was intended, the wiring is absent. (This matches the task’s API framing, so it may be by design — flagging only so it is not assumed to be automatic.)

4. **The dictation engine picker only renders when the bridge is configured.** `SttProviderRows` is gated on `stt?.bridge` (i.e. `LH_STT_BRIDGE_URL` is set). Without the bridge (native Deepgram mode), there is no “Dictation provider” row at all — the language picker remains, but engine selection is bridge-only. Not a bug, but worth stating plainly: the engine menu is absent in pure-Deepgram setups.
