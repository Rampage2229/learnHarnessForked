/**
 * The dictation STT settings (personal fork): /api/stt/token's bridge
 * branch composes wsUrl from the resolved stt section (engine + language),
 * and the Deepgram branch stays untouched when the bridge is absent.
 * Hermetic: LH_DATA_DIR + LH_AUTH_FILE + LH_STT_BRIDGE_URL are set BEFORE
 * the modules load (the server-keys.test.ts discipline).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-settings-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_STT_BRIDGE_URL = "ws://127.0.0.1:8765/v1/listen";
delete process.env.DEEPGRAM_API_KEY;

const { writeSettings } = await import("../src/store/settings.ts");
const tokenRoute = await import("../app/api/stt/token/route.ts");

const originalFetch = globalThis.fetch;

after(() => {
	globalThis.fetch = originalFetch;
	delete process.env.LH_STT_BRIDGE_URL;
	delete process.env.DEEPGRAM_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("GET /api/stt/token (bridge mode)", () => {
	it("no stt section + no dictation language → plain wsUrl", async () => {
		writeSettings({ version: 1 });
		const body = await (await tokenRoute.GET()).json();
		assert.deepEqual(body, { token: "local", wsUrl: "ws://127.0.0.1:8765/v1/listen" });
	});

	it("provider groq (no dictation language) → ?engine=groq", async () => {
		writeSettings({ version: 1, stt: { provider: "groq" } });
		const body = await (await tokenRoute.GET()).json();
		assert.equal(body.token, "local");
		assert.equal(body.wsUrl, "ws://127.0.0.1:8765/v1/listen?engine=groq");
	});

	it("provider groq + dictation language es → ?engine=groq&language=es", async () => {
		writeSettings({ version: 1, dictation: { language: "es" }, stt: { provider: "groq" } });
		const body = await (await tokenRoute.GET()).json();
		assert.equal(body.wsUrl, "ws://127.0.0.1:8765/v1/listen?engine=groq&language=es");
	});

	it("auto provider + dictation language es → ?language=es (the language preference applies regardless)", async () => {
		writeSettings({ version: 1, dictation: { language: "es" } });
		const body = await (await tokenRoute.GET()).json();
		assert.equal(body.wsUrl, "ws://127.0.0.1:8765/v1/listen?language=es");
	});

	it("locale codes pass through verbatim (the bridge normalizes to the primary subtag)", async () => {
		writeSettings({ version: 1, dictation: { language: "en-US" } });
		const body = await (await tokenRoute.GET()).json();
		assert.equal(body.wsUrl, "ws://127.0.0.1:8765/v1/listen?language=en-US");
	});
});

describe("GET /api/stt/token (Deepgram branch unchanged)", () => {
	it("no bridge + Deepgram key in auth file mints a Deepgram token", async () => {
		delete process.env.LH_STT_BRIDGE_URL;
		fs.writeFileSync(path.join(TMP, "auth.json"), JSON.stringify({ DEEPGRAM_API_KEY: "d".repeat(40) }));
		globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "dg-token" }), { status: 200 })) as typeof fetch;
		const res = await tokenRoute.GET();
		const body = await res.json();
		assert.equal(body.token, "dg-token");
		assert.equal("wsUrl" in body, false, "the Deepgram branch carries no wsUrl");
	});
});