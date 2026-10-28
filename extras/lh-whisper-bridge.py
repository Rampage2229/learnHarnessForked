#!/usr/bin/env python3
"""
lh-whisper bridge v3 — local dictation for LearnHarness.

Speaks just enough of Deepgram's streaming dialect for the dictation
client: ws://127.0.0.1:PORT/v1/listen + "bearer" subprotocol, linear16
(Int16LE) 16 kHz mono binary frames, Deepgram-shaped Results finals,
CloseStream → flush → close(1000).

v3 robustness (the 502-outage lesson):
  - Failed chunks are RETRIED, never dropped: a flush that errors leaves
    its range uncommitted and the next flush re-covers it.
  - In-call backoff retries for 5xx/429 (0.5/1.5/3/5s).
  - AUTOMATIC FAILOVER: after repeated Logfare failures transcription
    switches to the local faster-whisper model (already installed) until
    Logfare answers again — dictation continues through outages.
  - O(n) audio buffering (bytearray), coalesced incremental flushes —
    long dictations don't degrade.
  - Per-session engine/language via URL params
    (?engine=groq|logfare|local & language=es) — the settings UI drives
    them through /api/stt/token.

Config (env):
  LH_STT_PORT           default 8765
  LH_STT_ENGINE         auto (default) | logfare | local
  LH_STT_FAILOVER       1 (default) — fall back to local during outages
  LH_STT_API_BASE       default https://logfare.ai/v1
  LH_STT_API_MODEL      default whisper-large-v3-turbo
  LH_STT_API_KEY        explicit key; else auth.json lookup below
  LH_STT_AUTH_FILE      default ~/.config/LearnHarness/auth.json
  LH_STT_AUTH_VAR       default TOGETHER_API_KEY (the app's Logfare key row)
  LH_STT_LANGUAGE       unset = auto-detect; pin e.g. "es" or "ca"
  LH_STT_CHUNK_SECONDS  default 3.0 (incremental final cadence)
  LH_STT_RESPONSE_FORMAT default json
  LH_STT_MODEL          local-engine model (default "small")
"""
import asyncio
import io
import json
import os
import re
import sys
import threading
import time
import unicodedata
import wave
from urllib.parse import urlsplit, parse_qs

import numpy as np
import websockets

PORT = int(os.environ.get("LH_STT_PORT", "8765"))
ENGINE = os.environ.get("LH_STT_ENGINE", "auto")
FAILOVER = os.environ.get("LH_STT_FAILOVER", "1") not in ("0", "false", "no")
API_BASE = os.environ.get("LH_STT_API_BASE", "https://logfare.ai/v1").rstrip("/")
API_MODEL = os.environ.get("LH_STT_API_MODEL", "whisper-large-v3-turbo")
API_KEY = os.environ.get("LH_STT_API_KEY")
AUTH_FILE = os.environ.get("LH_STT_AUTH_FILE", os.path.expanduser("~/.config/LearnHarness/auth.json"))
AUTH_VAR = os.environ.get("LH_STT_AUTH_VAR", "TOGETHER_API_KEY")
GROQ_BASE = os.environ.get("LH_STT_GROQ_BASE", "https://api.groq.com/openai/v1").rstrip("/")
GROQ_MODEL = os.environ.get("LH_STT_GROQ_MODEL", "whisper-large-v3-turbo")
GROQ_KEY = os.environ.get("LH_STT_GROQ_KEY")
LANGUAGE = os.environ.get("LH_STT_LANGUAGE") or None
CHUNK_SECONDS = float(os.environ.get("LH_STT_CHUNK_SECONDS", "3.0"))
RESPONSE_FORMAT = os.environ.get("LH_STT_RESPONSE_FORMAT", "json")
LOCAL_MODEL = os.environ.get("LH_STT_MODEL", "small")

SAMPLE_RATE = 16000
CHUNK_SAMPLES = int(CHUNK_SECONDS * SAMPLE_RATE)
OVERLAP_SAMPLES = 8000  # 0.5s carried across chunk boundaries
# Logfare rejects request bodies over ~200KB with "Failed to decode audio
# file" — that is ~6.25s of 16kHz mono s16le. Cap every POST safely under
# it and split larger uncommitted ranges into sequential sub-chunks.
MAX_POST_SAMPLES = int(6.0 * SAMPLE_RATE)

# Engine state
model = None                  # local faster-whisper model (lazy)
local_loaded = threading.Event()
local_lock = threading.Lock()
logfare_key = None
groq_key = None
base_engine = "local"         # the configured engine (logfare|local)
active_engine = "local"       # what actually runs right now (failover-aware)
in_failover = False           # True while failed over to local (per-session overrides suppressed)
consecutive_failures = 0
cooling_until = 0.0           # unix time — while set, logfare is presumed down

transcribe_lock = asyncio.Lock()


def log(*a):
    print(*a, flush=True)


def resolve_key(which: str) -> str | None:
    if which == "groq":
        if GROQ_KEY:
            return GROQ_KEY
        var = "GROQ_API_KEY"
    else:
        if API_KEY:
            return API_KEY
        var = AUTH_VAR
    try:
        with open(AUTH_FILE) as f:
            return json.load(f).get(var) or None
    except (OSError, ValueError):
        return None


def best_available_engine() -> str:
    """auto: first cloud engine with a resolvable key, else local.
    Groq preferred over Logfare (sub-second STT, free tier)."""
    if resolve_key("groq"):
        return "groq"
    if resolve_key("logfare"):
        return "logfare"
    return "local"


def pcm_to_wav(pcm_bytes: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm_bytes)
    return buf.getvalue()


_http = None


def http_session(key: str):
    """Persistent requests.Session — connection reuse roughly halves the
    per-request latency vs a fresh TCP+TLS handshake per POST."""
    global _http
    import requests
    want = f"Bearer {key}"
    if _http is None or _http.headers.get("Authorization") != want:
        _http = requests.Session()
        _http.headers.update({"Authorization": want})
    return _http


def load_local_model():
    global model
    with local_lock:
        if local_loaded.is_set():
            return
        from faster_whisper import WhisperModel
        log(f"loading local faster-whisper '{LOCAL_MODEL}' (int8, cpu)...")
        model = WhisperModel(LOCAL_MODEL, device="cpu", compute_type="int8")
        local_loaded.set()
        log("local model ready")


# Whisper language names (as verbose_json reports them) → ISO codes for
# the language parameter of subsequent requests.
LANG_NAME_TO_CODE = {
    n: c for c, names in {
        "es": ("spanish", "castilian", "castilian spanish"),
        "en": ("english"),
        "ca": ("catalan", "catalan; valencian", "valencian"),
        "fr": ("french"), "de": ("german"), "it": ("italian"),
        "pt": ("portuguese"), "nl": ("dutch"), "ro": ("romanian"),
        "ru": ("russian"), "pl": ("polish"), "uk": ("ukrainian"),
        "ar": ("arabic"), "zh": ("chinese", "yue chinese"),
        "ja": ("japanese"), "ko": ("korean"), "hi": ("hindi"),
        "pt-br": (), "gl": ("galician"), "eu": ("basque"),
        "oc": ("occitan"), "sv": ("swedish"), "tr": ("turkish"),
        "el": ("greek"), "he": ("hebrew"), "hu": ("hungarian"),
        "cs": ("czech"), "da": ("danish"), "fi": ("finnish"),
        "no": ("norwegian"), "nn": ("nynorsk"),
    }.items() for n in names
}


def _loop_run(text: str) -> int:
    """Longest consecutive run of a repeated 1-3 word n-gram — the
    signature of Whisper's degenerate repetition loops."""
    words = re.sub(r"[^\wÀ-ÿ']+", " ", text.lower()).split()
    best = 0
    for n in (1, 2, 3):
        run = 1
        for i in range(n, len(words)):
            if words[i:i + n] == words[i - n:i]:
                run += 1
                best = max(best, run)
            else:
                run = 1
        best = max(best, 1 if len(words) else 0)
    return best


def _is_degenerate(text: str) -> bool:
    run = _loop_run(text)
    return run >= 6 or (run >= 4 and len(text.split()) <= run + 6)


def openai_transcribe(base: str, key: str, model: str, pcm_bytes: bytes,
                      language: str | None = None,
                      response_format: str | None = None,
                      temperature: float | None = None) -> tuple[str, str | None]:
    """WAV bytes → (transcript, detected-language-code | None) via an
    OpenAI-compatible /audio/transcriptions endpoint (Logfare and Groq).
    Raises on failure after backoff."""
    fmt = response_format or RESPONSE_FORMAT
    files = {"file": ("audio.wav", pcm_bytes, "audio/wav")}
    data = {"model": model, "response_format": fmt}
    if language:
        data["language"] = language
    if temperature is not None:
        data["temperature"] = temperature
    last_err = None
    for attempt, delay in enumerate((0, 0.5, 1.5, 3.0, 5.0), start=1):
        if delay:
            time.sleep(delay)
        try:
            r = http_session(key).post(
                f"{base}/audio/transcriptions",
                files=files,
                data=data,
                timeout=60,
            )
            if r.status_code == 200:
                j = r.json()
                detected = None
                res = j.get("result")
                if isinstance(res, dict):  # logfare shape
                    text = (res.get("text") or "").strip()
                    detected = ((res.get("transcription_info") or {}).get("language")) or None
                else:                       # OpenAI shape
                    text = (j.get("text") or "").strip()
                    detected = j.get("language") or None
                if detected:
                    detected = LANG_NAME_TO_CODE.get(str(detected).lower().strip(), detected)
                return text, detected
            last_err = f"HTTP {r.status_code}: {r.text[:120]}"
            if r.status_code < 500 and r.status_code != 429:
                break  # client error — retrying won't help
        except Exception as e:
            last_err = str(e)[:200]
    raise RuntimeError(f"STT failed after {attempt} attempts: {last_err}")


def local_transcribe(pcm: np.ndarray, language: str | None = None) -> tuple[str, str | None]:
    audio = pcm.astype("float32") / 32768.0
    segments, info = model.transcribe(
        audio,
        language=language,
        vad_filter=True,
        condition_on_previous_text=False,
        # temperature LIST = faster-whisper's native loop fallback: on a
        # degenerate (repeating / low-confidence) segment it re-decodes at
        # the next temperature. A scalar 0.0 would disable this.
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        beam_size=1,
        without_timestamps=True,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return text, (info.language if language is None else None)


def do_transcribe(pcm_bytes: bytes, pcm_view: np.ndarray,
                  language: str | None = None,
                  detect: bool = False,
                  engine: str | None = None) -> tuple[str, str | None]:
    """Dispatch on the per-session engine (URL param) else the active
    engine; while failed over, local always wins. A cloud call counts as
    BAD if it errors OR takes >8s (queue episodes are as harmful as
    outages): 2 consecutive bad calls fail over to local until recovery.
    Returns (transcript, detected-language-code | None); the detected
    code is only meaningful when `detect` is set (no language passed)."""
    global active_engine, consecutive_failures, cooling_until, logfare_key, groq_key
    use = "local" if in_failover else (engine or active_engine)
    if use == "local":
        load_local_model()
        return local_transcribe(pcm_view, language)
    if use == "groq":
        groq_key = groq_key or resolve_key("groq")
        base, key, model_id, label = GROQ_BASE, groq_key, GROQ_MODEL, "groq"
    else:
        logfare_key = logfare_key or resolve_key("logfare")
        base, key, model_id, label = API_BASE, logfare_key, API_MODEL, "logfare"
    if not key:
        raise RuntimeError(f"{label}: no API key")
    t0 = time.monotonic()
    try:
        out, detected = openai_transcribe(base, key, model_id, pcm_bytes,
                                          language=language,
                                          response_format="verbose_json" if detect else None)
    except Exception as e:
        consecutive_failures += 1
        log(f"  {label} failure #{consecutive_failures}: {e}")
        if FAILOVER and consecutive_failures >= 2:
            _failover(label)
        raise
    # Repetition-loop repair: whisper sometimes degenerates into a phrase
    # repeated dozens of times (formula-heavy speech is the worst case).
    # Detect and re-decode that chunk at a higher temperature, which breaks
    # the loop; keep whichever attempt is less degenerate.
    if out and _is_degenerate(out):
        log(f"  {label} repetition loop detected (run={_loop_run(out)}) — re-decoding at temperature 0.7")
        try:
            out2, detected2 = openai_transcribe(base, key, model_id, pcm_bytes,
                                                language=language,
                                                response_format="verbose_json" if detect else None,
                                                temperature=0.7)
            if _loop_run(out2) < _loop_run(out) or (not _is_degenerate(out2) and out2):
                out, detected = (out2, detected2 if detected2 else detected)
                log(f"  {label} retry accepted: {out!r}")
        except Exception as e:
            log(f"  {label} loop-retry failed (keeping original): {e}")
    dur = time.monotonic() - t0
    if dur > 8.0:
        consecutive_failures += 1
        log(f"  {label} slow ({dur:.1f}s) — strike {consecutive_failures}")
        if FAILOVER and consecutive_failures >= 2:
            _failover(label)
            # raise so the caller keeps the range uncommitted — the
            # local engine re-transcribes it on the next flush
            raise RuntimeError(f"{label} slow ({dur:.1f}s) — failed over to local")
    else:
        consecutive_failures = 0
    return out, detected


def _failover(reason: str) -> None:
    global active_engine, cooling_until, in_failover
    active_engine = "local"
    in_failover = True
    cooling_until = time.time() + 60
    log(f"  >>> failing over to LOCAL whisper ({reason}) until the cloud recovers")
    load_local_model()


def trim_bounds(pcm: np.ndarray, threshold: int = 200):
    """Bounds (a,b) of non-silent content (|amp| > threshold ≈ -43dBFS),
    with a 0.1s lead / 0.2s tail guard. Whisper hallucinates on
    silence-padded fragments (e.g. 'anual' off a 1s tail)."""
    loud = np.flatnonzero(np.abs(pcm.astype(np.int32)) > threshold)
    if loud.size == 0:
        return None
    a = max(0, int(loud[0]) - 1600)
    b = min(pcm.size, int(loud[-1]) + 3200)
    return a, b


def results_msg(text: str, engine: str | None = None) -> str:
    """Deepgram-shaped Results message (only fields the client reads).
    `engine` is the session's requested engine when set (metadata honesty
    under per-session overrides)."""
    used = engine or active_engine
    return json.dumps({
        "type": "Results",
        "is_final": bool(text),
        "speech_final": bool(text),
        "channel": {"alternatives": [{"transcript": text, "confidence": 1.0}]},
        "metadata": {"engine": f"lh-{used}"},
    })


def warmup():
    try:
        do_transcribe(pcm_to_wav(b"\x00\x00" * (SAMPLE_RATE // 2)),
                      np.zeros(SAMPLE_RATE // 2, dtype=np.int16),
                      language=None, detect=False)
        log("engine warm-up done")
    except Exception as e:
        log(f"engine warm-up failed (continuing): {e}")


class DictationSession:
    """O(n) audio accumulation: bytearray append, zero-copy views on read."""

    def __init__(self, language: str | None):
        self.raw = bytearray()
        self.committed = 0         # samples whose POST completed with text sent
        self.stopping = False      # CloseStream seen — suppress incremental sends
        self.flushing = False      # coalesce: one incremental POST at a time
        # Language: the env pin if set, else None until the run's first
        # chunk detects it (auto-detect mode). While undetected, the first
        # flush waits for more audio — detection needs a decent sample.
        self.language = language
        self.awaiting_detection = language is None

    def feed(self, buf: bytes):
        self.raw += buf            # amortized O(1) append

    def pending(self) -> int:
        return len(self.raw) // 2 - self.committed

    def slice_bytes(self, start_sample: int, end_sample: int | None = None) -> bytes:
        end = (end_sample if end_sample is not None else len(self.raw) // 2) * 2
        return bytes(self.raw[start_sample * 2:end])

    def slice_np(self, start_sample: int, end_sample: int | None = None) -> np.ndarray:
        end = (end_sample if end_sample is not None else len(self.raw) // 2) * 2
        return np.frombuffer(self.raw[start_sample * 2:end], dtype=np.int16)


def _fold(w: str) -> str:
    """Lowercase + accent-strip (español == espanol), keeping full words."""
    return "".join(c for c in unicodedata.normalize("NFD", w.lower())
                   if not unicodedata.combining(c))


def norm_words(s: str):
    return [_fold(w) for w in re.sub(r"[^\wÀ-ÿ']+", " ", s).split()]


async def run_session(ws, engine: str | None = None, language: str | None = None) -> None:
    session = DictationSession(language)
    peer = ws.remote_address
    log(f"dictation start {peer} (engine={engine or active_engine}, language={language or 'auto'})")
    last_text = [""]

    def dedupe(prev: str, new: str, window: int = 4) -> str:
        """Drop the new chunk's leading words that repeat the previous tail
        (the 0.5s overlap gets re-transcribed on both sides)."""
        if not prev or not new:
            return new
        p, n = norm_words(prev), norm_words(new)
        k = 0
        for cand in range(min(window, len(n), len(p)), 0, -1):
            if p[-cand:] == n[:cand]:
                k = cand
                break
        if k:
            lead = re.compile(r"^\s*\S+\s*")
            for _ in range(k):
                new = lead.sub("", new, count=1)
        return new

    def take(start_sample: int, end_sample: int):
        """Slice [start,end) silence-trimmed → (bytes, np, seconds)."""
        sl = session.slice_np(start_sample, end_sample)
        bounds = trim_bounds(sl)
        if bounds is None or bounds[1] - bounds[0] < SAMPLE_RATE // 10:
            return b"", np.zeros(0, dtype=np.int16), 0.0
        a, b = bounds
        return (session.slice_bytes(start_sample + a, start_sample + b),
                sl[a:b], (b - a) / SAMPLE_RATE)

    async def flush_incremental():
        """Transcribe everything uncommitted in ≤6s POSTs (sequential);
        on FAILURE the range stays uncommitted so the next flush retries
        it (no data loss)."""
        if session.flushing:
            return  # an in-flight POST covers the newer range when it lands
        session.flushing = True
        try:
            while True:
                async with transcribe_lock:
                    if session.stopping:
                        return
                    # Auto-detect mode: the FIRST flush waits for ~6s of
                    # audio (detection needs a decent sample), then locks
                    # the run to the detected language.
                    threshold = MAX_POST_SAMPLES if session.awaiting_detection else CHUNK_SAMPLES
                    pending = len(session.raw) // 2 - session.committed
                    if pending < threshold:
                        return
                    detect = session.awaiting_detection
                    start = max(0, session.committed - (0 if detect else OVERLAP_SAMPLES if session.committed else 0))
                    span = min(MAX_POST_SAMPLES, len(session.raw) // 2 - start)
                    end = start + span
                    chunk_bytes, chunk, dur = take(start, end)
                    t_post = time.monotonic()
                    if dur == 0.0:
                        text, detected = "", None  # all silence — nothing to transcribe
                    else:
                        try:
                            text, detected = await asyncio.to_thread(
                                do_transcribe, chunk_bytes, chunk, session.language, detect, engine)
                        except Exception as e:
                            log(f"  [{peer[1]}] flush {span / SAMPLE_RATE:.1f}s failed ({time.monotonic() - t_post:.1f}s): {e}")
                            break  # committed unchanged — retried by the next flush
                    if session.stopping:
                        return
                    if detect:
                        session.awaiting_detection = False
                        if detected:
                            session.language = detected
                            log(f"  [{peer[1]}] language detected: {detected} — locked for this run")
                        else:
                            log(f"  [{peer[1]}] no language reported — staying per-chunk auto")
                    text = dedupe(last_text[0], text) if text else text
                    last_text[0] = (last_text[0] + " " + text).strip() if text else last_text[0]
                    session.committed = end
                    log(f"  [{peer[1]}] chunk {span / SAMPLE_RATE:.1f}s ({time.monotonic() - t_post:.1f}s) → {text!r}")
                    if text:
                        await ws.send(results_msg(text, engine))
                if pending - span < CHUNK_SAMPLES:
                    return  # little enough backlog — wait for more audio
        finally:
            session.flushing = False

    async def flush_final():
        """CloseStream path: sequential ≤6s POSTs covering everything
        uncommitted, with a retry budget (~14s) inside the client's 20s
        safety net. On exhaustion, close gracefully (the tail is lost)."""
        deadline = time.monotonic() + 14.0
        emitted_any = False
        while True:
            end = len(session.raw) // 2
            pending = end - session.committed
            if pending < SAMPLE_RATE // 10:
                if not emitted_any:
                    await ws.send(results_msg("", engine))
                return
            start = max(0, session.committed - (OVERLAP_SAMPLES if session.committed else 0))
            # The final flush reaches BACK into already-emitted audio for
            # context (up to 6s total): whisper hallucinates on short tail
            # fragments ('anual' off 0.8s); with sentence context it decodes
            # the real words, and the wide-window dedupe strips the repeat.
            start = max(0, min(start, end - MAX_POST_SAMPLES))
            span = end - start
            chunk_bytes, chunk, dur = take(start, end)
            if dur == 0.0:
                # all silence — nothing to transcribe, just consume it
                session.committed = end
                continue
            attempt, delay = 0, 0.0
            while True:
                try:
                    text, detected = await asyncio.to_thread(
                        do_transcribe, chunk_bytes, chunk, session.language,
                        session.awaiting_detection, engine)
                    if session.awaiting_detection and detected:
                        session.language = detected
                        session.awaiting_detection = False
                        log(f"  [{peer[1]}] language detected: {detected} — locked (final flush)")
                    break
                except Exception as e:
                    attempt += 1
                    if time.monotonic() + delay > deadline:
                        log(f"  [{peer[1]}] FINAL flush failed after {attempt} attempts: {e}")
                        return  # give up gracefully; client's net closes the run
                    log(f"  [{peer[1]}] final retry in {delay:.1f}s ({e})")
                    await asyncio.sleep(delay)
                    delay = min(3.0, (delay or 0.5) * 2)
            text = dedupe(last_text[0], text, window=30) if text else text
            last_text[0] = (last_text[0] + " " + text).strip() if text else last_text[0]
            session.committed = end
            log(f"  [{peer[1]}] FINAL {span / SAMPLE_RATE:.1f}s → {text!r}")
            if text:
                emitted_any = True
                await ws.send(results_msg(text, engine))

    try:
        async for message in ws:
            if isinstance(message, bytes):
                session.feed(message)
                if session.pending() >= CHUNK_SAMPLES:
                    await flush_incremental()
            else:
                try:
                    msg = json.loads(message)
                except ValueError:
                    continue
                if msg.get("type") == "CloseStream":
                    session.stopping = True
                    await flush_final()
                    await ws.close(code=1000)
                    break
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log(f"dictation end {peer}")


async def handler(ws) -> None:
    # Subprotocol must be selected or browsers abort the handshake; the
    # client offers ["bearer", token] and expects "bearer" back.
    if ws.subprotocol not in ("bearer", None):
        await ws.close(code=1002, reason="unsupported subprotocol")
        return
    # Per-session URL params (personal fork): engine=groq|logfare|local
    # overrides the global engine for this run; language=es pins the
    # language (absent/""/"auto" = auto-detect). The audio contract
    # (linear16/16k/mono) stays fixed by the app's capture worklet.
    query = parse_qs(urlsplit(ws.request.path).query)
    engine = None
    raw_engine = (query.get("engine") or [None])[0]
    if raw_engine in ("groq", "logfare", "local"):
        engine = raw_engine
    language = None
    raw_language = (query.get("language") or [None])[0]
    if raw_language not in (None, "", "auto"):
        # nova-3 locale codes ("en-US") → whisper's primary subtag ("en")
        language = raw_language.split("-")[0].lower() or None
    await run_session(ws, engine=engine, language=language)


async def main() -> None:
    global base_engine, active_engine, logfare_key, groq_key
    logfare_key = resolve_key("logfare")
    groq_key = resolve_key("groq")
    if ENGINE == "auto":
        base_engine = best_available_engine()
    elif ENGINE in ("groq", "logfare"):
        base_engine = ENGINE
        if not resolve_key(ENGINE):
            log(f"LH_STT_ENGINE={ENGINE} but no key found — will fall back")
    else:
        base_engine = "local"
    active_engine = base_engine
    if base_engine == "local" and ENGINE != "local":
        log("no cloud STT key found — running the local engine")

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, warmup)

    async def recovery_loop():
        """While failed-over to local, probe the base engine with a tiny
        real STT request; on success switch back for full quality."""
        global active_engine, consecutive_failures, cooling_until, in_failover
        while True:
            await asyncio.sleep(20)
            if base_engine == "local":
                # Local-base bridge: nothing to recover, but a latched
                # in_failover must not permanently suppress per-session
                # cloud overrides (settings UI picks engine=...).
                if in_failover:
                    in_failover = False
                    active_engine = "local"
                    consecutive_failures = 0
                continue
            if active_engine == base_engine or not resolve_key(base_engine):
                continue
            if time.time() < cooling_until:
                continue
            try:
                if base_engine == "groq":
                    await asyncio.to_thread(openai_transcribe, GROQ_BASE, groq_key, GROQ_MODEL,
                                            pcm_to_wav(b"\x00\x00" * (SAMPLE_RATE // 2)))
                else:
                    await asyncio.to_thread(openai_transcribe, API_BASE, logfare_key, API_MODEL,
                                            pcm_to_wav(b"\x00\x00" * (SAMPLE_RATE // 2)))
                active_engine = base_engine
                consecutive_failures = 0
                in_failover = False
                log(f"  <<< {base_engine} recovered — switching back from local")
            except Exception:
                cooling_until = time.time() + 30

    async def keepalive_loop():
        """Keep one pooled TCP+TLS connection to the base engine hot so
        POSTs skip the handshake (idle servers close ~60s)."""
        while True:
            await asyncio.sleep(25)
            if base_engine == "local":
                continue
            key = groq_key if base_engine == "groq" else logfare_key
            if not key:
                continue
            base = GROQ_BASE if base_engine == "groq" else API_BASE
            try:
                await asyncio.to_thread(lambda: http_session(key).get(f"{base}/models", timeout=10))
            except Exception:
                pass

    loop.create_task(recovery_loop())
    loop.create_task(keepalive_loop())
    async with websockets.serve(
        handler,
        "127.0.0.1",
        PORT,
        subprotocols=["bearer", "token"],
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ):
        log(f"lh-whisper bridge listening on ws://127.0.0.1:{PORT}/v1/listen "
            f"(base={base_engine}, failover={'on' if FAILOVER else 'off'}, language={LANGUAGE or 'auto'})")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
