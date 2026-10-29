"use client";
/**
 * The Sync section (personal fork): Nextcloud sync control. NOT a
 * UserSettings record section — self-fetching like Memory/Keys (GET/PUT
 * /api/sync, POST to run). The password is write-only (the status never
 * returns it; a saved password renders as a placeholder). Two-way sync:
 * uploads + downloads + JSONL merges, conflict copies kept, secrets and
 * provider config excluded by construction.
 */

import { useEffect, useState } from "react";
import { SettingsGroup, SettingsRow, SettingsSection } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

export interface SyncStatus {
	enabled: boolean;
	serverUrl: string;
	username: string;
	hasPassword: boolean;
	autoSyncMinutes: number;
	lastSyncAt: string | null;
	lastSyncError: string | null;
}

export function SyncSection() {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [draft, setDraft] = useState<{ serverUrl: string; username: string; password: string }>({
		serverUrl: "",
		username: "",
		password: "",
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		const res = await fetch("/api/sync");
		if (!res.ok) return;
		const body = (await res.json()) as SyncStatus;
		setStatus(body);
		setDraft((d) => ({ serverUrl: body.serverUrl || d.serverUrl, username: body.username || d.username, password: d.password }));
	};

	useEffect(() => {
		void reload();
	}, []);

	const save = async (patch: Record<string, unknown>) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});
			const body = (await res.json()) as (SyncStatus & { error?: string });
			if (!res.ok) {
				setError(body.error ?? `Save failed (${res.status})`);
				return;
			}
			setStatus(body);
			notifySettingsSaved("sync");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Save failed");
		} finally {
			setBusy(false);
		}
	};

	const runNow = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/sync", { method: "POST" });
			const body = (await res.json()) as SyncStatus & { report?: { error?: string; uploaded?: number; downloaded?: number; merged?: number; conflicts?: number } };
			setStatus(body);
			if (!res.ok || body.report?.error) {
				setError(body.report?.error ?? `Sync failed (${res.status})`);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Sync failed");
		} finally {
			setBusy(false);
		}
	};

	if (status === null) {
		return <p className="px-6 py-5 text-xs text-muted-foreground/70">Loading sync…</p>;
	}

	return (
		<SettingsSection title="Sync" testid="section-sync">
			<p className="px-1 text-xs text-muted-foreground/70">
				Two-way Nextcloud sync for your sessions, knowledge graph, memory, topics and settings. API keys, provider
				config and credentials never sync. Use a Nextcloud <span className="font-mono">app password</span> (required with 2FA).
			</p>
			<SettingsGroup label="Nextcloud" testid="group-sync-nextcloud">
				<SettingsRow label="Enabled" testid="row-sync-enabled">
					<label className="flex items-center gap-2 text-xs">
						<input
							type="checkbox"
							checked={status.enabled}
							data-testid="sync-enabled"
							onChange={(e) => void save({ enabled: e.target.checked })}
							className="size-3.5 accent-primary"
						/>
						Sync automatically
					</label>
				</SettingsRow>
				<SettingsRow label="Server URL" testid="row-sync-server">
					<input
						value={draft.serverUrl}
						data-testid="sync-server"
						placeholder="https://cloud.example.com"
						onChange={(e) => setDraft((d) => ({ ...d, serverUrl: e.target.value }))}
						onBlur={() => void save({ serverUrl: draft.serverUrl })}
						className="h-8 w-64 rounded-lg border bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</SettingsRow>
				<SettingsRow label="Username" testid="row-sync-username">
					<input
						value={draft.username}
						data-testid="sync-username"
						onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
						onBlur={() => void save({ username: draft.username })}
						className="h-8 w-64 rounded-lg border bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</SettingsRow>
				<SettingsRow label="App password" testid="row-sync-password">
					<input
						type="password"
						value={draft.password}
						data-testid="sync-password"
						placeholder={status.hasPassword ? "•••••••• (saved)" : "app password"}
						onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
						onBlur={() => {
							if (draft.password) void save({ password: draft.password }).then(() => setDraft((d) => ({ ...d, password: "" })));
						}}
						className="h-8 w-64 rounded-lg border bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</SettingsRow>
				<SettingsRow label="Auto-sync" testid="row-sync-interval">
					<select
						value={String(status.autoSyncMinutes)}
						data-testid="sync-interval"
						onChange={(e) => void save({ autoSyncMinutes: Number(e.target.value) })}
						className="h-8 rounded-lg border bg-background px-2 text-xs outline-none focus:border-ring"
					>
						<option value="0">Manual only</option>
						<option value="15">Every 15 minutes</option>
						<option value="60">Every hour</option>
					</select>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Status" testid="group-sync-status">
				<div className="flex items-center justify-between gap-3 px-1 py-1">
					<span className="text-xs text-muted-foreground">
						{status.lastSyncAt ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}` : "Never synced"}
					</span>
					<button
						type="button"
						disabled={busy || !status.enabled}
						onClick={() => void runNow()}
						data-testid="sync-now"
						className="h-8 rounded-lg border bg-card px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
					>
						{busy ? "Syncing…" : "Sync now"}
					</button>
				</div>
				{status.lastSyncError && (
					<p data-testid="sync-last-error" className="px-1 text-xs text-muted-foreground/70">
						Last error: {status.lastSyncError}
					</p>
				)}
			</SettingsGroup>
			{error && (
				<p role="alert" data-testid="sync-error" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</SettingsSection>
	);
}