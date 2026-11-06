/**
 * POST /api/paste-image (paste wave, personal fork): a clipboard
 * screenshot the learner pasted into the composer. The client can't write
 * files; the server can — the image lands on disk so the agent reads it
 * like any other attachment path (the fs tools' home-anchored law).
 *
 * Body: the raw image bytes, content-type image/*. Returns { path } —
 * the ABSOLUTE path, which the composer stages as a chip.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const dynamic = "force-dynamic";

/** 20MB — screenshots are 100KBs; the cap is the runaway guard. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Where pasted screenshots land. Env override (tests, headless setups)
 *  over the Pictures default — always INSIDE the learner's home so the
 *  agent's home-anchored read tools see it. */
export function pasteDir(): string {
	const override = process.env.LH_PASTE_DIR;
	if (override) return path.resolve(override);
	return path.join(os.homedir(), "Pictures", "LearnHarness");
}

export async function POST(req: Request) {
	const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
	if (!contentType.startsWith("image/")) {
		return Response.json({ error: "body must be an image (content-type image/*)" }, { status: 400 });
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength === 0) return Response.json({ error: "empty body" }, { status: 400 });
	if (bytes.byteLength > MAX_BYTES) {
		return Response.json({ error: "image too large (the ceiling is 20MB)" }, { status: 413 });
	}
	const ext = contentType === "image/jpeg" ? ".jpg"
		: contentType === "image/webp" ? ".webp"
		: contentType === "image/gif" ? ".gif"
		: ".png";
	const dir = pasteDir();
	try {
		await fs.mkdir(dir, { recursive: true });
		// Timestamp + a random tail: two pastes in the same second never
		// collide (save_file's overwrite guard would refuse, and the draft
		// would silently lose the image).
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(dir, `pasted-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`);
		await fs.writeFile(file, bytes);
		return Response.json({ path: file });
	} catch (err) {
		return Response.json(
			{ error: `could not save the screenshot: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
}
