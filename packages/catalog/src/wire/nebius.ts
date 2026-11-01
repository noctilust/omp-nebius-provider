/**
 * Nebius Token Factory endpoint, shared so a host migration — or a
 * self-hosted proxy override — touches a single module.
 */
export const NEBIUS_API_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * Resolve a configured Token Factory base URL onto the endpoint discovery and
 * inference target.
 *
 * The model-cache namespace is hashed from the same value, so a trailing slash
 * must not split one endpoint across two cache rows.
 */
export function normalizeNebiusBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : NEBIUS_API_BASE_URL;
}
