import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import type { AntigravityStatus } from "../../core/contracts/antigravity.ts";
import { getAntigravityBinary } from "./binary.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";

export type ReadAntigravityVersion = (binary: string) => Promise<string>;

export const readAntigravityVersion: ReadAntigravityVersion = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["--version"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function inspectAntigravityInstallation(
	findBinary: () => string | null = getAntigravityBinary,
	readVersion: ReadAntigravityVersion = readAntigravityVersion,
): Promise<AntigravityStatus> {
	const modelIds = ANTIGRAVITY_MODELS.map((m) => m.id);
	const binary = findBinary();
	if (!binary) {
		return { state: "not-found", version: null, path: null, models: modelIds };
	}
	try {
		const output = await readVersion(binary);
		const match = /^v?(\d+\.\d+\.\d+)/.exec(output.trim());
		const version = match ? match[1] : output.trim().slice(0, 32);
		return { state: "available", version, path: binary, models: modelIds };
	} catch {
		return { state: "available", version: "unknown", path: binary, models: modelIds };
	}
}
