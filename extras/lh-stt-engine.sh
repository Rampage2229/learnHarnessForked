#!/usr/bin/env bash
# lh-stt-engine.sh — switch LearnHarness dictation engine, or compare latency.
#   lh-stt-engine.sh groq | logfare | local   → switch + restart the bridge
#   lh-stt-engine.sh check                    → time one STT request per cloud engine
set -u
UNIT="$HOME/.config/systemd/user/lh-whisper.service"
PYTHON="$HOME/Applications/lh-whisper-venv/bin/python"

set_engine() {
    local eng="$1"
    if grep -q "^Environment=LH_STT_ENGINE=" "$UNIT"; then
        sed -i "s|^Environment=LH_STT_ENGINE=.*|Environment=LH_STT_ENGINE=$eng|" "$UNIT"
    else
        sed -i "/^#Environment=LH_STT_LANGUAGE=/a Environment=LH_STT_ENGINE=$eng" "$UNIT"
    fi
    systemctl --user daemon-reload
    systemctl --user restart lh-whisper.service
    sleep 10
    echo "active: $(journalctl --user -u lh-whisper -n 1 --no-pager | grep -o 'base=[a-z]*')"
}

check() {
    "$PYTHON" - <<'EOF'
import json, time, io, wave, numpy as np, requests
auth = json.load(open("/home/rampj/.config/LearnHarness/auth.json"))
pcm = np.zeros(16000 * 2, dtype=np.int16)  # 2s
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm.tobytes())
WAV = buf.getvalue()
targets = [("groq", "https://api.groq.com/openai/v1", "whisper-large-v3-turbo", auth.get("GROQ_API_KEY")),
           ("logfare", "https://logfare.ai/v1", "whisper-large-v3-turbo", auth.get("TOGETHER_API_KEY"))]
for name, base, model, key in targets:
    if not key:
        print(f"{name:8s} no key — skipped"); continue
    s = requests.Session(); s.headers.update({"Authorization": f"Bearer {key}"})
    times = []
    for i in range(2):
        t = time.monotonic()
        r = s.post(f"{base}/audio/transcriptions", files={"file": ("a.wav", WAV, "audio/wav")},
                   data={"model": model, "response_format": "json", **({"language": "es"} if name == "logfare" else {})},
                   timeout=90)
        times.append(time.monotonic() - t)
    print(f"{name:8s} 2s audio → {[f'{t:.2f}s' for t in times]}  (stop→text ≈ this + ~1s)")
EOF
}

case "${1:-}" in
    groq|logfare|local) set_engine "$1" ;;
    check) check ;;
    *) echo "usage: lh-stt-engine.sh groq|logfare|local|check" ;;
esac
