/** Nextcloud sync control (personal fork): GET status (never the password),
 *  PUT save config, POST run a sync now. */
import { readSyncConfig, runSync, writeSyncConfig } from "@/src/server";

export const dynamic = "force-dynamic";

function status() {
	const cfg = readSyncConfig();
	return {
		enabled: cfg.enabled,
		serverUrl: cfg.serverUrl,
		username: cfg.username,
		hasPassword: cfg.password !== "",
		autoSyncMinutes: cfg.autoSyncMinutes,
		lastSyncAt: cfg.lastSyncAt ?? null,
		lastSyncError: cfg.lastSyncError ?? null,
	};
}

export async function GET() {
	return Response.json(status());
}

export async function PUT(req: Request) {
	const cfg = readSyncConfig();
	const body = (await req.json().catch(() => null)) as Partial<{
		enabled?: unknown;
		serverUrl?: unknown;
		username?: unknown;
		password?: unknown;
		autoSyncMinutes?: unknown;
	}> | null;
	if (!body) return Response.json({ error: "body must be JSON" }, { status: 400 });

	const next = { ...cfg };
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
		next.enabled = body.enabled;
	}
	if (body.serverUrl !== undefined) {
		if (typeof body.serverUrl !== "string" || !/^https?:\/\//.test(body.serverUrl)) {
			return Response.json({ error: "serverUrl must be an http(s) URL" }, { status: 400 });
		}
		next.serverUrl = body.serverUrl.trim().replace(/\/+$/, "");
	}
	if (body.username !== undefined) {
		if (typeof body.username !== "string") return Response.json({ error: "username must be a string" }, { status: 400 });
		next.username = body.username.trim();
	}
	if (body.password !== undefined) {
		if (typeof body.password !== "string") return Response.json({ error: "password must be a string" }, { status: 400 });
		next.password = body.password; // "" clears
	}
	if (body.autoSyncMinutes !== undefined) {
		if (typeof body.autoSyncMinutes !== "number" || !Number.isInteger(body.autoSyncMinutes) || body.autoSyncMinutes < 0) {
			return Response.json({ error: "autoSyncMinutes must be a non-negative integer" }, { status: 400 });
		}
		next.autoSyncMinutes = body.autoSyncMinutes;
	}
	writeSyncConfig(next);
	return Response.json(status());
}

export async function POST() {
	const report = await runSync();
	return Response.json({ ...status(), report }, { status: report.ok ? 200 : 502 });
}