"use client";
/**
 * The Custom servers group (personal fork, UI-managed custom providers):
 * one row per on-disk custom OpenAI-compatible provider — name, base URL,
 * model count, key status — with inline Edit / Refresh / Delete (no
 * confirm dialog, house style). An Add flow opens an inline editor
 * (name / URL / key / optional alias); Edit reuses the same fields with
 * the key left empty to keep. Every successful write re-reads the server
 * (GET /api/custom-providers is the truth) and fires the keys signal.
 *
 * Esc folds any open editor via a document CAPTURE-phase listener (the
 * keys-section pattern) — the only stopPropagation that outruns both the
 * input's React handler and the dialog's window-level listener.
 */

import { useEffect, useState } from "react";
import { SettingsGroup } from "./controls.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";

/** The GET /api/custom-providers row shape (mirrors the server's DTO). */
interface CustomServerRow {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyEnvVar: string;
	keyPresent: boolean;
	modelCount: number;
	aliases: string[];
}

interface EditorState {
	name: string;
	url: string;
	key: string;
	alias: string;
}

const EMPTY: EditorState = { name: "", url: "", key: "", alias: "" };

const inputCls =
	"h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

/** The four editor fields, scoped by testid prefix (add vs edit-<id>). */
function EditorFields({
	scope,
	form,
	onChange,
	keyPlaceholder,
}: {
	scope: string;
	form: EditorState;
	onChange: (next: EditorState) => void;
	keyPlaceholder: string;
}) {
	return (
		<>
			<input
				type="text"
				value={form.name}
				onChange={(e) => onChange({ ...form, name: e.target.value })}
				placeholder="Name"
				aria-label="Provider name"
				data-testid={`${scope}-name`}
				autoFocus
				className={inputCls}
			/>
			<input
				type="text"
				value={form.url}
				onChange={(e) => onChange({ ...form, url: e.target.value })}
				placeholder="Base URL (https://…)"
				aria-label="Base URL"
				data-testid={`${scope}-url`}
				className={`${inputCls} min-w-0 flex-1`}
			/>
			<input
				type="text"
				value={form.key}
				onChange={(e) => onChange({ ...form, key: e.target.value })}
				placeholder={keyPlaceholder}
				aria-label="API key"
				data-testid={`${scope}-key`}
				className={inputCls}
			/>
			<input
				type="text"
				value={form.alias}
				onChange={(e) => onChange({ ...form, alias: e.target.value })}
				placeholder="optional alias, e.g. together"
				aria-label="Alias"
				data-testid={`${scope}-alias`}
				className={inputCls}
			/>
		</>
	);
}

export function CustomServersGroup() {
	const [rows, setRows] = useState<CustomServerRow[] | null>(null);
	/** "add" | "edit" | null — the open editor, one at a time. */
	const [mode, setMode] = useState<"add" | "edit" | null>(null);
	const [editId, setEditId] = useState<string | null>(null);
	const [form, setForm] = useState<EditorState>(EMPTY);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	const [refreshingId, setRefreshingId] = useState<string | null>(null);

	const reload = () =>
		fetch("/api/custom-providers")
			.then((r) => r.json())
			.then((body: CustomServerRow[]) => setRows(Array.isArray(body) ? body : []))
			.catch(() => setRows([]));

	useEffect(() => {
		void reload();
	}, []);

	const closeEditor = () => {
		setMode(null);
		setEditId(null);
		setForm(EMPTY);
		setEditorError(null);
	};

	// Esc folds any open editor WITHOUT closing the dialog (keys-section
	// capture-phase pattern).
	useEffect(() => {
		if (mode === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			closeEditor();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [mode]);

	async function saveEditor() {
		if (mode === null) return;
		const editing = mode === "edit";
		const url = editing ? `/api/custom-providers/${editId}` : "/api/custom-providers";
		const payload: Record<string, string> = { name: form.name, baseUrl: form.url };
		if (editing) {
			payload.alias = form.alias;
			if (form.key) payload.apiKey = form.key;
		} else {
			payload.apiKey = form.key;
			if (form.alias) payload.alias = form.alias;
		}
		const res = await fetch(url, {
			method: editing ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setEditorError(body.error ?? `Save failed (${res.status})`);
			return;
		}
		closeEditor();
		await reload();
		notifySettingsSaved("keys");
	}

	async function refreshRow(id: string) {
		setRefreshingId(id);
		setRowErrors((prev) => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
		try {
			const res = await fetch(`/api/custom-providers/${id}/refresh`, { method: "POST" });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setRowErrors((prev) => ({ ...prev, [id]: body.error ?? `Refresh failed (${res.status})` }));
				return;
			}
			await reload();
			notifySettingsSaved("keys");
		} finally {
			setRefreshingId(null);
		}
	}

	async function deleteRow(id: string) {
		const res = await fetch(`/api/custom-providers/${id}`, { method: "DELETE" });
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setRowErrors((prev) => ({ ...prev, [id]: body.error ?? `Delete failed (${res.status})` }));
			return;
		}
		await reload();
		notifySettingsSaved("keys");
	}

	if (rows === null) {
		return (
			<SettingsGroup label="Custom servers" testid="group-custom-servers">
				<p className="px-1 text-xs text-muted-foreground/70">Loading custom servers…</p>
			</SettingsGroup>
		);
	}

	return (
		<SettingsGroup label="Custom servers" testid="group-custom-servers">
			{rows.map((row) =>
				mode === "edit" && editId === row.id ? (
					<div key={row.id} data-testid={`custom-server-${row.id}`}>
						<div className="flex flex-wrap items-center gap-2 rounded-sm px-1 py-1.5" data-testid={`custom-server-edit-${row.id}-editor`}>
							<EditorFields
								scope={`custom-server-edit-${row.id}`}
								form={form}
								onChange={setForm}
								keyPlaceholder="leave empty to keep"
							/>
							<button
								type="button"
								onClick={() => void saveEditor()}
								disabled={!form.name.trim() || !form.url.trim()}
								data-testid={`custom-server-edit-${row.id}-save`}
								className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
							>
								Save
							</button>
							<button
								type="button"
								onClick={closeEditor}
								data-testid={`custom-server-edit-${row.id}-cancel`}
								className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
							>
								Cancel
							</button>
						</div>
						{editorError && (
							<p role="alert" data-testid={`custom-server-edit-${row.id}-error`} className="px-1 text-xs text-red-500">
								{editorError}
							</p>
						)}
					</div>
				) : (
					<div key={row.id} data-testid={`custom-server-${row.id}`}>
						<div
							data-testid={`custom-server-${row.id}-row`}
							className="flex items-center justify-between gap-3 rounded-sm px-1 py-1.5"
						>
							<span className="min-w-0 font-ui text-xs text-foreground">
								<span>{row.name}</span>
								<span data-testid={`custom-server-${row.id}-url`} className="ml-2 font-mono text-[11px] text-muted-foreground">
									{row.baseUrl}
								</span>
								<span data-testid={`custom-server-${row.id}-count`} className="ml-2 font-mono text-[11px] text-muted-foreground">
									{row.modelCount} models
								</span>
								<span data-testid={`custom-server-${row.id}-key`} className="ml-2 font-mono text-[11px] text-muted-foreground">
									{row.keyPresent ? "key set" : "no key"}
								</span>
							</span>
							<span className="flex shrink-0 items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setMode("edit");
										setEditId(row.id);
										setForm({ name: row.name, url: row.baseUrl, key: "", alias: row.aliases[0] ?? "" });
										setEditorError(null);
									}}
									data-testid={`custom-server-${row.id}-edit`}
									className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline"
								>
									Edit
								</button>
								<button
									type="button"
									onClick={() => void refreshRow(row.id)}
									disabled={refreshingId === row.id}
									data-testid={`custom-server-${row.id}-refresh`}
									className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
								>
									{refreshingId === row.id ? "Refreshing…" : "Refresh"}
								</button>
								<button
									type="button"
									onClick={() => void deleteRow(row.id)}
									data-testid={`custom-server-${row.id}-delete`}
									className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete
								</button>
							</span>
						</div>
						{rowErrors[row.id] && (
							<p role="alert" data-testid={`custom-server-${row.id}-error`} className="px-1 text-xs text-red-500">
								{rowErrors[row.id]}
							</p>
						)}
					</div>
				),
			)}

			<button
				type="button"
				data-testid="add-custom-server"
				onClick={() => {
					setMode("add");
					setEditId(null);
					setForm(EMPTY);
					setEditorError(null);
				}}
				className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
			>
				<span>+ Add custom server</span>
			</button>

			{mode === "add" && (
				<div className="flex flex-wrap items-center gap-2 rounded-sm px-1 py-1.5" data-testid="custom-server-new-editor">
					<EditorFields scope="custom-server-new" form={form} onChange={setForm} keyPlaceholder="API key" />
					<button
						type="button"
						onClick={() => void saveEditor()}
						disabled={!form.name.trim() || !form.url.trim()}
						data-testid="custom-server-new-save"
						className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={closeEditor}
						data-testid="custom-server-new-cancel"
						className="shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
					>
						Cancel
					</button>
				</div>
			)}
			{mode === "add" && editorError && (
				<p role="alert" data-testid="custom-server-new-error" className="px-1 text-xs text-red-500">
					{editorError}
				</p>
			)}
		</SettingsGroup>
	);
}