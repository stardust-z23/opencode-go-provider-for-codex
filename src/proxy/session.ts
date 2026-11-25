import { createHash } from "crypto";
import * as http from "http";

export type SessionIdSource = "header" | "metadata" | "fingerprint";

export interface ResolvedSessionId {
	id: string;
	source: SessionIdSource;
	clientProvided: boolean;
}

const SESSION_HEADERS = [
	"x-opencode-session",
	"session_id",
	"x-session-id",
	"session-id",
	"thread-id",
	"x-claude-code-session-id",
	"claude-code-session-id",
];

/**
 * OpenCode Go uses this value for routing and prompt-cache affinity. Prefer a
 * client-provided conversation id, then fall back to a stable fingerprint of
 * the immutable conversation prefix. Never use a per-request id here.
 */
export function resolveSessionId(
	headers: http.IncomingHttpHeaders,
	body: Record<string, unknown>,
): ResolvedSessionId {
	for (const name of SESSION_HEADERS) {
		const value = headerValue(headers[name])?.trim();
		if (value) {
			return { id: value, source: "header", clientProvided: true };
		}
	}

	const metadataSession = sessionIdFromMetadata(body);
	if (metadataSession) {
		return {
			id: metadataSession,
			source: "metadata",
			clientProvided: true,
		};
	}

	return {
		id: `codexgo-${conversationFingerprint(body)}`,
		source: "fingerprint",
		clientProvided: false,
	};
}

function sessionIdFromMetadata(body: Record<string, unknown>): string | undefined {
	const metadata = isRecord(body.metadata) ? body.metadata : undefined;
	if (!metadata) {
		return undefined;
	}

	if (typeof metadata.session_id === "string" && metadata.session_id.trim()) {
		return metadata.session_id.trim();
	}

	const userId = typeof metadata.user_id === "string" ? metadata.user_id.trim() : "";
	if (!userId) {
		return undefined;
	}
	if (userId.startsWith("{")) {
		try {
			const parsed = JSON.parse(userId) as unknown;
			if (isRecord(parsed) && typeof parsed.session_id === "string" && parsed.session_id.trim()) {
				return parsed.session_id.trim();
			}
		} catch {
			// Fall through to the legacy marker below.
		}
	}
	const marker = userId.indexOf("_session_");
	return marker >= 0 ? userId.slice(marker + "_session_".length).trim() || undefined : undefined;
}

function conversationFingerprint(body: Record<string, unknown>): string {
	const prefix = {
		model: typeof body.model === "string" ? body.model : "",
		instructions: stableValue(
			typeof body.instructions === "string"
				? body.instructions
				: typeof body.system === "string"
					? body.system
					: body.system,
		),
		firstUser: firstUserInput(body),
	};
	return createHash("sha256")
		.update(stableStringify(prefix))
		.digest("hex")
		.slice(0, 32);
}

function firstUserInput(body: Record<string, unknown>): unknown {
	if (typeof body.input === "string") {
		return body.input;
	}
	if (Array.isArray(body.input)) {
		const first = body.input.find(
			(item) =>
				isRecord(item) &&
				(item.type === undefined || item.type === "message") &&
				item.role === "user",
		);
		if (first) {
			return stableValue(first);
		}
	}
	if (Array.isArray(body.messages)) {
		const first = body.messages.find(
			(item) => isRecord(item) && item.role === "user",
		);
		if (first) {
			return stableValue(first);
		}
	}
	return "";
}

function stableValue(value: unknown, depth = 0): unknown {
	if (depth > 20 || value === undefined) {
		return null;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => stableValue(item, depth + 1));
	}
	if (!isRecord(value)) {
		return String(value);
	}

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (key === "cache_control" || key === "request_id" || key === "x-request-id") {
			continue;
		}
		result[key] = stableValue(value[key], depth + 1);
	}
	return result;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value);
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
