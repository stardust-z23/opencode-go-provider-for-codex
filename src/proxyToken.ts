import { createHmac } from "crypto";

const PROXY_TOKEN_CONTEXT = "opencode-go-provider-for-codex:local-proxy:v1";

/**
 * Derive the low-value bearer token Codex uses for the loopback proxy.
 *
 * The token stays valid only for the local proxy and cannot be used to
 * authenticate to OpenCode Go. Deriving it from the upstream key means there
 * is no second credential to persist or rotate.
 */
export function deriveProxyToken(apiKey: string): string {
	const key = apiKey.trim();
	if (!key) {
		throw new Error("apiKey must not be empty");
	}
	return createHmac("sha256", key).update(PROXY_TOKEN_CONTEXT).digest("base64url");
}
