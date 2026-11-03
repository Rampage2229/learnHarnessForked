"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AntigravityStatus, UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function antigravityStatusLabel(status: AntigravityStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found (agy CLI)";
		case "available": return `Version ${status.version ?? "unknown"} · available (${status.path ?? "agy"})`;
		default: return "Status could not be checked";
	}
}

export function AntigravityInstallationStatus() {
	const [enabled, setEnabled] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);

	const read = useCallback(async () => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = await response.json() as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				setEnabled(body.settings?.antigravity?.enabled !== false);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Antigravity settings.");
		}
	}, []);

	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);

	useSettingsSaved((section) => { if (section === "antigravity") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/antigravity", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (!controller.signal.aborted) {
				setEnabled(body.settings.antigravity?.enabled !== false);
				notifySettingsSaved("antigravity");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Antigravity settings.");
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/antigravity", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as AntigravityStatus;
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);

	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return (
		<div className="space-y-2" data-testid="antigravity-installation">
			<div className="flex items-center gap-3">
				<span className="font-prose text-(length:--lh-prose-size) text-foreground">Google Antigravity (agy)</span>
				<Toggle label="Google Antigravity" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
			</div>
			{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
			{enabled && (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : antigravityStatusLabel(status)}</span>
						<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid="antigravity-check-again">Check again</Button>
					</div>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Uses your local <strong className="font-medium">Google Antigravity CLI (<code className="font-mono">agy</code>)</strong> to run Gemini and Claude Thinking models directly through your Antigravity quota. No separate proxy daemon needed.
					</p>
				</>
			)}
		</div>
	);
}
