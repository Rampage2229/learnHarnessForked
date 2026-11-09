/**
 * Hermetic data dir for route tests (import-side-effect module): sets
 * LH_DATA_DIR to a fresh mkdtemp BEFORE any config-loading module loads
 * (ES imports hoist, so this file must be the first import). Cleans up on
 * process exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.LH_DATA_DIR) {
	process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hermetic-"));
	process.on("exit", () => {
		try {
			fs.rmSync(process.env.LH_DATA_DIR!, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});
}
