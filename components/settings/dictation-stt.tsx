"use client";
/**
 * The dictation STT provider row (personal fork): one SettingsRow inside
 * the Dictation keys group — the bridge's STT engine (Auto/Groq/Logfare/
 * Local). Rendered only when the local STT bridge is configured (the
 * language preference lives upstream in DictationLanguageSetting and
 * drives both Deepgram and the bridge). Pure presentation: the row
 * receives the current value + change callback from keys-section, which
 * owns the PUT /api/settings/stt. SSR-clean so the render tests can pin
 * the markup.
 */

import { SettingsRow, ThinSelect } from "./controls.tsx";

export function SttProviderRows({
	provider,
	onProviderChange,
	error,
}: {
	provider: string;
	onProviderChange: (next: string) => void;
	error?: string | null;
}) {
	return (
		<>
			<SettingsRow label="Dictation provider" testid="row-stt-provider">
				<ThinSelect value={provider} onChange={onProviderChange} ariaLabel="Dictation provider" testid="stt-provider">
					<option value="auto">Auto</option>
					<option value="groq">Groq</option>
					<option value="logfare">Logfare</option>
					<option value="local">Local</option>
				</ThinSelect>
			</SettingsRow>
			{error && (
				<p role="alert" data-testid="stt-error" className="px-1 text-xs text-red-500">
					{error}
				</p>
			)}
		</>
	);
}
