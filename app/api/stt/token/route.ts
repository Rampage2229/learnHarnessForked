/**
 * POST-less BYOK mint: the renderer never holds the real Deepgram key.
 *
 * The key lives server-side only (auth.json → process.env in the desktop
 * app; .env.local in dev — same seam as OPENROUTER_API_KEY). A dictation
 * run starts here: mint a short-lived access token (TTL 300s — a run can
 * outlast the 30s default), the renderer opens its WebSocket to Deepgram
 * with it, and audio flows renderer → Deepgram directly, never through
 * this server. The token is only checked at the WebSocket handshake, so
 * long dictation sessions survive the TTL fine (Deepgram docs).
 *
 * NOTE: the key needs ≥ Member permission in the Deepgram console to call
 * /auth/grant (their docs, token-based auth FAQ) — plain read/transcribe
 * keys return FORBIDDEN here.
 */
import { effectiveSettings, keyValue, settingsStore } from "@/src/server";

export const dynamic = "force-dynamic";

/** Personal fork: local STT bridge mode. When LH_STT_BRIDGE_URL is set,
 *  the response points the renderer's WebSocket at the bridge (which
 *  speaks enough of Deepgram's streaming dialect: bearer subprotocol,
 *  linear16 frames, Results finals, CloseStream → close 1000) instead of
 *  minting a Deepgram token. No DEEPGRAM_API_KEY needed in this mode.
 *  The token is opaque to the client either way. */
export async function GET() {
	const bridge = process.env.LH_STT_BRIDGE_URL;
	if (bridge) {
		const stt = effectiveSettings().stt;
		// Language comes from the upstream dictation preference — read the
		// RAW record: effectiveSettings resolves the factory default ("en"),
		// and an untouched preference must mean bridge-side auto-detect,
		// never an English pin. Nova-3 locale codes ("en-US") are
		// normalised to the primary subtag by the bridge.
		const raw = settingsStore.readSettings();
		const preferred = raw?.dictation?.language;
		const q: string[] = [];
		if (stt.provider !== "auto") q.push(`engine=${stt.provider}`);
		if (preferred) q.push(`language=${encodeURIComponent(preferred)}`);
		return Response.json({ token: "local", wsUrl: bridge + (q.length ? `?${q.join("&")}` : "") });
	}
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		return Response.json(
			{ message: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token" }, { status: 502 });
		}
		return Response.json({ token: data.access_token });
	} catch {
		return Response.json({ message: "Deepgram unreachable" }, { status: 502 });
	}
}
