"use client";
/**
 * The dictation STT provider row (personal fork): one SettingsRow inside
 * the Dictation keys group — the bridge's STT engine (Auto/Groq/Logfare/
 * NVIDIA/Local). Rendered only when the local STT bridge is configured
 * (the language preference lives upstream in DictationLanguageSetting and
 * drives both Deepgram and the bridge). Pure presentation: the row
 * receives the current value + change callback from keys-section, which
 * owns the PUT /api/settings/stt. SSR-clean so the render tests can pin
 * the markup.
 *
 * Engine-key honesty (personal fork): on mount the row fetches
 * /api/stt/status and, for every engine option that has NO credential,
 * appends " (no key)" to its label, plus renders the route's `reason`
 * line under the select. A pinned-but-unkeyed engine silently falls back
 * to the bridge default at request time (see /api/stt/token); surfacing
 * that here stops the menu from lying about a selected engine that can't
 * run. The fetch runs in an effect, so the SSR/static snapshot (used by
 * the render tests) keeps the plain labels — the " (no key)" suffix and
 * the reason line appear only after hydration.
 */

import { useEffect, useState } from "react";
import { SettingsRow, ThinSelect } from "./controls.tsx";

/** The status route's per-engine row. */
interface SttEngineStatus {
	id: "groq" | "logfare" | "nvidia" | "local";
	label: string;
	keyed: boolean;
}
interface SttStatus {
	bridge: boolean;
	selected: string;
	engines: SttEngineStatus[];
	reason: string;
}

export function SttProviderRows({
	provider,
	onProviderChange,
	error,
}: {
	provider: string;
	onProviderChange: (next: string) => void;
	error?: string | null;
}) {
	const [status, setStatus] = useState<SttStatus | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		void fetch("/api/stt/status")
			.then((r) => (r.ok ? r.json() : undefined))
			.then((body: SttStatus | undefined) => {
				if (!cancelled) setStatus(body);
			})
			.catch(() => {
				if (!cancelled) setStatus(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Map option value → " (no key)" suffix when the status route reports
	// the engine unkeyed. "auto" is the bridge's delegate (never keyed or
	// unkeyed), so it is never suffixed.
	const unkeyed = new Set<string>(status?.engines.filter((e) => !e.keyed).map((e) => e.id) ?? []);
	const labelFor = (value: string, plain: string) => (unkeyed.has(value) ? `${plain} (no key)` : plain);

	return (
		<>
			<SettingsRow label="Dictation provider" testid="row-stt-provider">
				<ThinSelect value={provider} onChange={onProviderChange} ariaLabel="Dictation provider" testid="stt-provider">
					<option value="auto">{labelFor("auto", "Auto")}</option>
					<option value="groq">{labelFor("groq", "Groq")}</option>
					<option value="logfare">{labelFor("logfare", "Logfare")}</option>
					<option value="nvidia">{labelFor("nvidia", "NVIDIA NIM")}</option>
					<option value="local">{labelFor("local", "Local")}</option>
				</ThinSelect>
			</SettingsRow>
			{status?.reason && (
				<p data-testid="stt-engine-status" className="px-1 text-xs text-muted-foreground">
					{status.reason}
				</p>
			)}
			{error && (
				<p role="alert" data-testid="stt-error" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</>
	);
}
