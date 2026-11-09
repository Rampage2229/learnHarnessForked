/**
 * The dictation STT engine-key status (personal fork): /api/stt/status
 * reports which engines actually have credentials so the UI can stop
 * lying about a selected-but-unkeyed engine. Hermetic: LH_DATA_DIR +
 * LH_AUTH_FILE are set to a fresh mkdtemp BEFORE the route (and its
 * transitive src/server import) loads — the route import runs the keys
 * boot fill-gap, so the auth file must exist first.
 *
 * This setup configures Logfare as a CUSTOM PROVIDER, so its key is
 * CUSTOM_OPENAI_API_KEY (the auth.json binding key
 * __learnharness_custom_provider_binding is the custom-endpoint auth seam,
 * not an engine key). Seeding auth.json with ONLY CUSTOM_OPENAI_API_KEY
 * therefore keys Logfare (and the custom endpoint) while Groq and NVIDIA
 * stay unkeyed; Local needs no key. With the selected engine set to an
 * UNKEYED one (groq), the reason names it and explains the bridge
 * fallback.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── Hermetic data dir + auth file: set BEFORE any src/server import. ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-status-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
// A clean env snapshot: no stray engine keys leak in as REAL env (which
// would win over the file and skew keyed results). Delete before import
// so the keys boot fill-gap treats the file as the sole source.
for (const name of ["GROQ_API_KEY", "NVIDIA_API_KEY", "TOGETHER_API_KEY", "CUSTOM_OPENAI_API_KEY", "DEEPGRAM_API_KEY"]) {
	delete process.env[name];
}
// Seed auth.json with ONLY the custom-provider key (Logfare, this setup).
fs.writeFileSync(process.env.LH_AUTH_FILE, JSON.stringify({ CUSTOM_OPENAI_API_KEY: "sk-custom-fixture" }), { mode: 0o600 });

const { writeSettings } = await import("../src/store/settings.ts");
const statusRoute = await import("../app/api/stt/status/route.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("GET /api/stt/status (engine-key honesty)", () => {
	before(() => {
		// Selected engine is an UNKEYED one (groq) so the reason names it.
		writeSettings({ version: 1, stt: { provider: "groq" } });
	});

	it("reports the bridge flag from LH_STT_BRIDGE_URL", async () => {
		const body = await (await statusRoute.GET()).json();
		assert.equal(body.bridge, false);
	});

	it("reports the selected provider from effectiveSettings", async () => {
		const body = await (await statusRoute.GET()).json();
		assert.equal(body.selected, "groq");
	});

	it("logfare is keyed via CUSTOM_OPENAI_API_KEY (custom-provider setup)", async () => {
		const body = await (await statusRoute.GET()).json();
		const logfare = body.engines.find((e: { id: string }) => e.id === "logfare");
		assert.ok(logfare, "logfare engine present");
		assert.equal(logfare.keyed, true);
	});

	it("groq is unkeyed (no GROQ_API_KEY in the seeded auth.json)", async () => {
		const body = await (await statusRoute.GET()).json();
		const groq = body.engines.find((e: { id: string }) => e.id === "groq");
		assert.ok(groq, "groq engine present");
		assert.equal(groq.keyed, false);
	});

	it("nvidia is unkeyed (no NVIDIA_API_KEY in the seeded auth.json)", async () => {
		const body = await (await statusRoute.GET()).json();
		const nvidia = body.engines.find((e: { id: string }) => e.id === "nvidia");
		assert.ok(nvidia, "nvidia engine present");
		assert.equal(nvidia.keyed, false);
	});

	it("local is always keyed (the bridge's bundled engine needs no key)", async () => {
		const body = await (await statusRoute.GET()).json();
		const local = body.engines.find((e: { id: string }) => e.id === "local");
		assert.ok(local, "local engine present");
		assert.equal(local.keyed, true);
	});

	it("the reason names the selected unkeyed engine and explains the fallback", async () => {
		const body = await (await statusRoute.GET()).json();
		assert.equal(
			body.reason,
			"Groq is selected but has no key — dictation will fall back to the bridge default",
		);
	});

	it("the engines array carries the four concrete engine ids and labels", async () => {
		const body = await (await statusRoute.GET()).json();
		assert.deepEqual(
			body.engines.map((e: { id: string; label: string }) => ({ id: e.id, label: e.label })),
			[
				{ id: "groq", label: "Groq" },
				{ id: "logfare", label: "Logfare" },
				{ id: "nvidia", label: "NVIDIA NIM" },
				{ id: "local", label: "Local" },
			],
		);
	});
});

describe("GET /api/stt/status (selected engine IS keyed → ok reason)", () => {
	before(() => {
		// Logfare is keyed via the seeded CUSTOM_OPENAI_API_KEY.
		writeSettings({ version: 1, stt: { provider: "logfare" } });
	});

	it("the reason is a short ok line (no fallback warning)", async () => {
		const body = await (await statusRoute.GET()).json();
		assert.equal(body.reason, "No STT bridge configured");
		assert.equal(body.selected, "logfare");
	});
});

describe("GET /api/stt/status (auto/local never produce a fallback warning)", () => {
	it("auto delegates to the bridge — ok reason, not a per-engine warning", async () => {
		writeSettings({ version: 1, stt: { provider: "auto" } });
		const body = await (await statusRoute.GET()).json();
		assert.equal(body.selected, "auto");
		assert.equal(body.reason, "No STT bridge configured");
	});

	it("local always runs — ok reason, not a fallback warning", async () => {
		writeSettings({ version: 1, stt: { provider: "local" } });
		const body = await (await statusRoute.GET()).json();
		assert.equal(body.selected, "local");
		assert.equal(body.reason, "No STT bridge configured");
	});
});
