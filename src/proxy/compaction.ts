import { randomUUID } from "crypto";

export const COMPACTION_PROMPT =
	"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n" +
	"Include:\n" +
	"- Current progress and key decisions made\n" +
	"- Important context, constraints, or user preferences\n" +
	"- What remains to be done (clear next steps)\n" +
	"- Any critical data, examples, or references needed to continue\n\n" +
	"Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\n";

export const SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use this summary to assist with your own analysis:";

const COMPACTION_PREFIX = "codexgo-compaction-v1:";
const OPAQUE_COMPACTION_NOTE =
	"[earlier conversation was compacted; the summary is stored in a format this proxy cannot read]";

export function isCompactionItem(item: unknown): boolean {
	return (
		isRecord(item) &&
		(item.type === "compaction" ||
			item.type === "compaction_summary" ||
			item.type === "context_compaction")
	);
}

export function isCompactionTrigger(item: unknown): boolean {
	return isRecord(item) && item.type === "compaction_trigger";
}

export function hasCompactionTrigger(body: Record<string, unknown>): boolean {
	return Array.isArray(body.input) && body.input.some(isCompactionTrigger);
}

/**
 * Convert a Codex compaction turn into a normal summary request. This removes
 * tools so the upstream cannot answer with another tool call instead of the
 * handoff summary.
 */
export function prepareCompactionRequest(body: Record<string, unknown>): void {
	const input = Array.isArray(body.input) ? body.input : [];
	let insertedPrompt = false;
	const rewritten: unknown[] = [];
	for (const item of input) {
		if (isCompactionTrigger(item)) {
			rewritten.push(textMessage(COMPACTION_PROMPT));
			insertedPrompt = true;
		} else if (isCompactionItem(item)) {
			rewritten.push(textMessage(compactionReplayText(item)));
		} else {
			rewritten.push(item);
		}
	}
	if (!insertedPrompt) {
		rewritten.push(textMessage(COMPACTION_PROMPT));
	}
	body.input = rewritten;
	delete body.tools;
	delete body.tool_choice;
	delete body.parallel_tool_calls;
	if (isRecord(body.text)) {
		delete body.text.format;
		if (Object.keys(body.text).length === 0) {
			delete body.text;
		}
	}
}

/**
 * A thread can switch from a Chat/Anthropic model to native Responses. Convert
 * only this proxy's own compaction envelopes back into readable summary
 * messages; foreign opaque state is left for the native upstream to validate.
 */
export function replayOwnCompactionItems(body: Record<string, unknown>): number {
	if (!Array.isArray(body.input)) {
		return 0;
	}
	let replayed = 0;
	const rewritten = body.input.map((item) => {
		if (!isCompactionItem(item)) {
			return item;
		}
		const summary = decodeCompactionSummary(item.encrypted_content);
		if (!summary) {
			return item;
		}
		replayed++;
		return textMessage(`${SUMMARY_PREFIX}\n${summary}`);
	});
	if (replayed > 0) {
		body.input = rewritten;
	}
	return replayed;
}

export function compactionReplayText(item: Record<string, unknown>): string {
	const summary = decodeCompactionSummary(item.encrypted_content);
	return summary ? `${SUMMARY_PREFIX}\n${summary}` : OPAQUE_COMPACTION_NOTE;
}

export function encodeCompactionSummary(summary: string): string {
	return `${COMPACTION_PREFIX}${Buffer.from(summary, "utf8").toString("base64url")}`;
}

export function decodeCompactionSummary(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) {
		return undefined;
	}
	try {
		const decoded = Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64url").toString("utf8");
		return decoded.trim() ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function summaryFromResponsesOutput(
	output: unknown,
): string {
	const parts: string[] = [];
	const items = Array.isArray(output) ? output : [];
	for (const item of items) {
		if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
			continue;
		}
		for (const part of item.content) {
			if (
				isRecord(part) &&
				part.type === "output_text" &&
				typeof part.text === "string" &&
				part.text.trim()
			) {
				parts.push(part.text.trim());
			}
		}
	}
	return parts.join("\n\n");
}

export function compactionOutputItem(summary: string): Record<string, unknown> {
	return {
		id: `cmp_${randomUUID().replace(/-/g, "")}`,
		type: "compaction",
		encrypted_content: encodeCompactionSummary(summary),
	};
}

export function compactionResponse(
	model: string,
	summary: string,
	usage: Record<string, unknown> | undefined,
	responseId?: string,
): Record<string, unknown> {
	return {
		id: responseId || `resp_${randomUUID()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status: "completed",
		model,
		output: [compactionOutputItem(summary)],
		usage: usage ?? null,
	};
}

export function compactionSse(response: Record<string, unknown>): string {
	const item = Array.isArray(response.output) && isRecord(response.output[0])
		? response.output[0]
		: undefined;
	const events: Array<[string, Record<string, unknown>]> = [
		[
			"response.created",
			{
				response: {
					...response,
					status: "in_progress",
					output: [],
					usage: null,
				},
			},
		],
	];
	if (item) {
		events.push([
			"response.output_item.added",
			{
				output_index: 0,
				item: {
					id: item.id,
					type: item.type,
					encrypted_content: "",
				},
			},
		]);
		events.push([
			"response.output_item.done",
			{
				output_index: 0,
				item,
			},
		]);
	}
	events.push(["response.completed", { response }]);
	return events
		.map(
			([type, data]) =>
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		)
		.join("");
}

function textMessage(text: string): Record<string, unknown> {
	return {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
