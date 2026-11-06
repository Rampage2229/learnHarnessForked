/**
 * POST /api/paste-image (paste wave, personal fork): the route writes a
 * clipboard screenshot to disk and returns the path the composer stages
 * as a chip. Tests point LH_PASTE_DIR at a tmp dir BEFORE the import —
 * the dir choice reads the env per request, so no import-order dance is
 * needed for the route itself.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-paste-"));
process.env.LH_PASTE_DIR = path.join(TMP, "captures");

const { POST, pasteDir } = await import("../app/api/paste-image/route.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
	delete process.env.LH_PASTE_DIR;
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function request(body: BodyInit, contentType: string): Request {
	return new Request("http://localhost/api/paste-image", { method: "POST", headers: { "content-type": contentType }, body });
}

describe("POST /api/paste-image", () => {
	it("saves a png to the captures dir and returns its absolute path", async () => {
		const res = await POST(request(PNG_BYTES, "image/png"));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { path: string };
		assert.ok(body.path.startsWith(pasteDir()), `${body.path} lives in the captures dir`);
		assert.ok(body.path.endsWith(".png"));
		assert.ok(fs.existsSync(body.path));
		assert.deepEqual(fs.readFileSync(body.path), Buffer.from(PNG_BYTES));
	});

	it("names files collision-proof (two pastes, two files)", async () => {
		const first = ((await POST(request(PNG_BYTES, "image/png"))).json()) as Promise<{ path: string }>;
		const second = ((await POST(request(PNG_BYTES, "image/png"))).json()) as Promise<{ path: string }>;
		const a = (await first).path;
		const b = (await second).path;
		assert.notEqual(a, b);
		assert.ok(fs.existsSync(b));
	});

	it("maps the content type to the extension", async () => {
		const res = await POST(request(new Uint8Array([1, 2, 3]), "image/jpeg"));
		const body = (await res.json()) as { path: string };
		assert.ok(body.path.endsWith(".jpg"));
	});

	it("rejects non-images, empty bodies, oversized bodies", async () => {
		assert.equal((await POST(request(PNG_BYTES, "text/plain"))).status, 400);
		assert.equal((await POST(request(new Uint8Array(0), "image/png"))).status, 400);
		assert.equal((await POST(request(new Uint8Array(21 * 1024 * 1024), "image/png"))).status, 413);
	});
});
