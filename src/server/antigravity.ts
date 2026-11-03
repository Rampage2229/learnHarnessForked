import { inspectAntigravityInstallation } from "../agent/antigravity/installation.ts";
import { initAuthEnv } from "./keys.ts";
import { antigravityEnabled } from "./antigravity-config.ts";

export async function antigravityInstallationStatus() {
	initAuthEnv();
	return inspectAntigravityInstallation();
}

export async function antigravityInstallationResponse(
	request: Request,
	inspect = antigravityInstallationStatus,
	enabled = antigravityEnabled,
): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405, headers });
	}
	if (!enabled()) {
		return Response.json({ error: "Google Antigravity is disabled." }, { status: 403, headers });
	}
	return Response.json(await inspect(), { headers });
}
