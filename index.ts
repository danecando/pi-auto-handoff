/**
 * Auto-handoff extension for pi coding agent.
 *
 * Counts completed user turns in the current session. Once the count crosses
 * the configured threshold, the user is notified once and the editor is
 * pre-filled with /handoff. Running /handoff generates a structured
 * continuation summary and opens a fresh session with it ready to submit.
 *
 * Off by default. Enable per session with /auto-handoff on, or set defaults
 * for a project by creating .pi/auto-handoff.json:
 *
 *   { "enabled": true, "turnsThreshold": 25 }
 *
 * Install: pi install https://github.com/danecando/pi-auto-handoff
 *
 * Commands:
 *   /auto-handoff              show current status
 *   /auto-handoff on|off       toggle for current session
 *   /handoff                   generate handoff summary and start new session
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const DEFAULT_TURNS_THRESHOLD = 25;

// Mirrors core/compaction/utils.ts SUMMARIZATION_SYSTEM_PROMPT — kept inline
// because the package does not export it. Update here if pi changes its prompt.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// Mirrors core/compaction/compaction.ts SUMMARIZATION_PROMPT.
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

interface ProjectConfig {
	enabled: boolean;
	turnsThreshold: number;
}

const readProjectConfig = (cwd: string): ProjectConfig => {
	const defaults: ProjectConfig = { enabled: false, turnsThreshold: DEFAULT_TURNS_THRESHOLD };
	try {
		const raw = readFileSync(join(cwd, ".pi", "auto-handoff.json"), "utf8");
		const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
			turnsThreshold:
				typeof parsed.turnsThreshold === "number" && parsed.turnsThreshold > 0
					? parsed.turnsThreshold
					: defaults.turnsThreshold,
		};
	} catch {
		return defaults;
	}
};

const countUserTurns = (entries: SessionEntry[]): number =>
	entries.filter((e) => e.type === "message" && e.message.role === "user").length;

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let turnsThreshold = DEFAULT_TURNS_THRESHOLD;
	let notified = false;

	const loadConfig = (cwd: string) => {
		const cfg = readProjectConfig(cwd);
		enabled = cfg.enabled;
		turnsThreshold = cfg.turnsThreshold;
		notified = false;
	};

	pi.on("session_start", (_event, ctx) => {
		loadConfig(ctx.cwd);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!enabled || notified || !ctx.hasUI) return;
		const turns = countUserTurns(ctx.sessionManager.getBranch());
		if (turns < turnsThreshold) return;

		notified = true;
		ctx.ui.notify(
			`Session has ${turns} user turns (threshold ${turnsThreshold}). Run /handoff to continue in a fresh session.`,
			"warning",
		);
		ctx.ui.setEditorText("/handoff");
	});

	pi.registerCommand("auto-handoff", {
		description: "Toggle automatic handoff prompt for long sessions (on|off, no args = status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				notified = false;
				ctx.ui.notify(`auto-handoff: ON (threshold ${turnsThreshold} turns)`, "info");
				return;
			}
			if (arg === "off") {
				enabled = false;
				ctx.ui.notify("auto-handoff: OFF", "info");
				return;
			}
			if (arg !== "" && arg !== "status") {
				ctx.ui.notify("Usage: /auto-handoff [on|off]", "error");
				return;
			}
			const turns = countUserTurns(ctx.sessionManager.getBranch());
			ctx.ui.notify(
				`auto-handoff: ${enabled ? "ON" : "OFF"} — ${turns}/${turnsThreshold} user turns${notified ? " (already notified)" : ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("handoff", {
		description: "Summarize current session and start a fresh one with handoff context",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const summary = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Summarizing session for handoff...");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok || !auth.apiKey) {
						throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
					}

					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") return null;

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("Handoff summary failed:", err);
						done(null);
					});

				return loader;
			});

			if (summary === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", summary);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready — submit when ready.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
