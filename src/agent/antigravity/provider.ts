import { createProvider, type Api, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "./constants.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Google Antigravity",
		auth: {
			apiKey: {
				name: "Antigravity CLI",
				resolve: async () => ({ auth: {}, source: "agy CLI" }),
			},
		},
		models: ANTIGRAVITY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
