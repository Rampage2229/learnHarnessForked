#!/usr/bin/env python3
"""
Generate <data-dir>/custom-providers.json for the personal LearnHarness
fork: a custom OpenAI-compatible chat provider built from a live
/v1/models catalog (verified against Logfare).

The fork's source reads this file at startup
(src/core/custom-providers.ts) — no binary patching, restart to apply.

Usage:
  python3 generate-custom-providers.py [--data-dir DIR] [--base-url URL]

Defaults: --data-dir ~/.config/LearnHarness/data, --base-url https://logfare.ai/v1
"""
import argparse
import json
import urllib.request
from pathlib import Path

APP_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
DEFAULT_CTX = 128_000
DEFAULT_MAX_TOKENS = 65_536
# Logfare rejects request bodies over ~200KB with "Failed to decode audio
# file" — ~6.25s of 16kHz mono s16le. Keep chat bodies well under it too.
PROVIDER_ID = "logfare"
PROVIDER_NAME = "Logfare"
API_KEY_ENV_VAR = "LOGFARE_API_KEY"
ALIASES = ["together"]  # replace the builtin slot so old settings/chats keep working


def thinking_map(info: dict) -> dict | None:
    """Logfare's supported_efforts → pi's thinking-level map. A level
    mapped to null is hidden from the picker; the mapped string is what
    gets sent as reasoning_effort."""
    efforts = info.get("supported_efforts") or []
    if not efforts:
        return None  # no effort controls → treat as non-reasoning
    m = {}
    for level in APP_LEVELS:
        if level == "off":
            m["off"] = "none" if "none" in efforts else None
        else:
            m[level] = level if level in efforts else None
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="~/.config/LearnHarness/data")
    ap.add_argument("--base-url", default="https://logfare.ai/v1")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    req = urllib.request.Request(f"{base}/models", headers={"User-Agent": "learnharness-fork"})
    data = json.loads(urllib.request.urlopen(req, timeout=30).read())
    models = [m for m in data["data"] if "chat/completions" in (m.get("endpoints") or [])]

    entries = []
    for m in sorted(models, key=lambda x: x["id"]):
        cap = m.get("chat_capabilities") or {}
        arch = m.get("architecture") or {}
        rinfo = cap.get("reasoning")
        tmap = thinking_map(rinfo) if isinstance(rinfo, dict) else None
        inputs = ["text"] + (["image"] if "image" in (arch.get("input_modalities") or []) else [])
        entry = {
            "id": m["id"],
            "name": m.get("display_name") or m["id"],
            "reasoning": bool(tmap),
            "input": inputs,
            "contextWindow": m.get("context_length") or DEFAULT_CTX,
            "maxTokens": DEFAULT_MAX_TOKENS,
        }
        if tmap:
            entry["thinkingLevelMap"] = tmap
        entries.append(entry)

    out = {
        "providers": [{
            "id": PROVIDER_ID,
            "name": PROVIDER_NAME,
            "baseUrl": base,
            "apiKeyEnvVar": API_KEY_ENV_VAR,
            "aliases": ALIASES,
            "models": entries,
        }]
    }
    target = Path(args.data_dir).expanduser() / "custom-providers.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=1))
    reasoning_count = sum(1 for e in entries if e["reasoning"])
    print(f"wrote {target}")
    print(f"{len(entries)} chat models ({reasoning_count} reasoning-capable) for provider '{PROVIDER_ID}'")
    print(f"next: put your key in the data dir's auth.json as {API_KEY_ENV_VAR}, then restart LearnHarness")


if __name__ == "__main__":
    main()
