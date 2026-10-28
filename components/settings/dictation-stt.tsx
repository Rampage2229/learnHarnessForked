"use client";
/**
 * The dictation STT rows (personal fork): two SettingsRows inside the
 * Dictation keys group — provider (Auto/Groq/Logfare/Local) and language
 * (Auto-detect + the bridge's common codes). Pure presentation: the rows
 * receive the current values + change callbacks from keys-section, which
 * owns the PUT /api/settings/stt and the inline error. SSR-clean so the
 * render tests can pin the markup.
 */

import { SettingsRow, ThinSelect } from "./controls.tsx";

export function DictationSttRows({
	provider,
	language,
	onProviderChange,
	onLanguageChange,
	error,
}: {
	provider: string;
	language: string;
	onProviderChange: (next: string) => void;
	onLanguageChange: (next: string) => void;
	error: string | null;
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
			<SettingsRow label="Dictation language" testid="row-stt-language">
				<ThinSelect value={language} onChange={onLanguageChange} ariaLabel="Dictation language" testid="stt-language">
					<option value="">Auto-detect</option>
					<option value="es">es</option>
					<option value="ca">ca</option>
					<option value="en">en</option>
					<option value="pt">pt</option>
					<option value="fr">fr</option>
					<option value="de">de</option>
					<option value="it">it</option>
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