import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_SECONDS = 180;
const DEFAULT_MAX_TURNS = 8;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_TURNS = 32;
const MAX_TRACE_ITEMS = 120;

const OutputModeSchema = StringEnum(["json", "text"] as const, {
	description: "Final output mode returned to the parent agent",
	default: "json",
});

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
	description: "Thinking level for the sub-agent model",
});

const SubagentCallParams = Type.Object({
	objective: Type.String({
		description: "Primary objective for the sub-agent function call",
	}),
	instructions: Type.Optional(
		Type.String({
			description: "Optional additional instructions, pre/post-processing guidance, or constraints",
		}),
	),
	outputMode: Type.Optional(OutputModeSchema),
	outputSchema: Type.Optional(
		Type.String({
			description: "Optional JSON schema or contract text that the sub-agent must satisfy",
		}),
	),
	requiredKeys: Type.Optional(
		Type.Array(Type.String(), {
			description: "Required dot-path keys when outputMode=json (e.g. facts.summary, evidence[0].url)",
		}),
	),
	project: Type.Optional(
		Type.Array(Type.String(), {
			description: "Dot-path projection for parent context (only these fields are returned in tool content)",
		}),
	),
	model: Type.Optional(Type.String({ description: "Optional model override for sub-agent" })),
	thinking: Type.Optional(ThinkingLevelSchema),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional tool allowlist for sub-agent (e.g. [read,grep,find,ls])",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Optional working directory for sub-agent process" })),
	includeFiles: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional file paths to pass as @file inputs to the sub-agent",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: "Hard timeout for sub-agent execution",
			default: DEFAULT_TIMEOUT_SECONDS,
			minimum: 5,
			maximum: MAX_TIMEOUT_SECONDS,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description: "Maximum assistant turns for the sub-agent before forced stop",
			default: DEFAULT_MAX_TURNS,
			minimum: 1,
			maximum: MAX_TURNS,
		}),
	),
	includeRawOutput: Type.Optional(
		Type.Boolean({
			description: "Include raw sub-agent output preview in tool details",
			default: false,
		}),
	),
});

type SubagentCallParams = Static<typeof SubagentCallParams>;

type OutputMode = "json" | "text";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type TerminationReason = "timeout" | "aborted" | "max_turns_exceeded";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface TraceItem {
	type: "tool_call" | "tool_error" | "assistant";
	value: string;
}

interface RunResult {
	exitCode: number;
	terminationReason?: TerminationReason;
	stderr: string;
	assistantTurns: number;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
	assistantOutputs: string[];
	trace: TraceItem[];
}

interface ToolDetails {
	status: "ok" | "error";
	objective: string;
	outputMode: OutputMode;
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	timeoutSeconds: number;
	maxTurns: number;
	assistantTurns: number;
	usage: UsageStats;
	stopReason?: string;
	terminationReason?: TerminationReason;
	errorMessage?: string;
	parseError?: string;
	missingKeys?: string[];
	projection?: string[];
	artifactPath?: string;
	trace: TraceItem[];
	rawOutputPreview?: string;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || Number.isNaN(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function trimPreview(text: string, max = 200): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max)}...`;
}

function pushTrace(trace: TraceItem[], item: TraceItem): void {
	trace.push(item);
	if (trace.length > MAX_TRACE_ITEMS) trace.shift();
}

function resolveWorkingDirectory(baseCwd: string, requested?: string): string {
	if (!requested) return baseCwd;
	const stripped = requested.startsWith("@") ? requested.slice(1) : requested;
	const resolved = path.isAbsolute(stripped) ? stripped : path.resolve(baseCwd, stripped);
	if (!existsSync(resolved)) throw new Error(`cwd does not exist: ${requested}`);
	if (!statSync(resolved).isDirectory()) throw new Error(`cwd is not a directory: ${requested}`);
	return resolved;
}

function normalizeFileArgs(baseCwd: string, files: string[] | undefined): string[] {
	if (!files || files.length === 0) return [];
	const resolved: string[] = [];
	for (const raw of files) {
		const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
		const abs = path.isAbsolute(stripped) ? stripped : path.resolve(baseCwd, stripped);
		if (!existsSync(abs)) throw new Error(`includeFiles path does not exist: ${raw}`);
		if (!statSync(abs).isFile()) throw new Error(`includeFiles entry is not a file: ${raw}`);
		resolved.push(abs);
	}
	return resolved;
}

function normalizeTools(tools: string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	const cleaned = Array.from(new Set(tools.map((t) => t.trim()).filter(Boolean)));
	return cleaned;
}

function extractAssistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	const chunks: string[] = [];
	for (const part of message.content) {
		if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
	}
	return chunks.join("\n").trim();
}

function buildSystemPrompt(params: {
	outputMode: OutputMode;
	outputSchema?: string;
	requiredKeys?: string[];
	maxTurns: number;
}): string {
	const lines: string[] = [
		"You are a programmatic sub-agent invoked as a function by a parent orchestrator agent.",
		"Work independently and use available tools when needed.",
		"Do not ask follow-up questions. Make reasonable assumptions and finish decisively.",
		`Keep the run bounded and complete within ${params.maxTurns} assistant turns.`,
		"Do not include conversational filler in the final answer.",
	];

	if (params.outputMode === "json") {
		lines.push("Final answer must be strict JSON only (no markdown, no code fences, no commentary).");
		if (params.outputSchema) {
			lines.push("The JSON output contract is:");
			lines.push(params.outputSchema);
		}
		if (params.requiredKeys && params.requiredKeys.length > 0) {
			lines.push(`Required keys: ${params.requiredKeys.join(", ")}.`);
		}
	} else {
		lines.push("Final answer should be concise text focused on actionable findings.");
	}

	return lines.join("\n");
}

function buildTaskPrompt(params: {
	objective: string;
	instructions?: string;
	outputMode: OutputMode;
	outputSchema?: string;
	requiredKeys?: string[];
	projection?: string[];
	includeFiles?: string[];
}): string {
	const lines: string[] = [
		"# Programmatic Sub-Agent Function Call",
		"",
		"## Objective",
		params.objective,
	];

	if (params.instructions) {
		lines.push("", "## Additional Instructions", params.instructions);
	}

	if (params.includeFiles && params.includeFiles.length > 0) {
		lines.push("", "## Attached Files", params.includeFiles.map((f) => `- ${f}`).join("\n"));
	}

	lines.push("", "## Output Contract", `- mode: ${params.outputMode}`);

	if (params.outputSchema) lines.push(`- schema: ${params.outputSchema}`);
	if (params.requiredKeys && params.requiredKeys.length > 0) {
		lines.push(`- required keys: ${params.requiredKeys.join(", ")}`);
	}
	if (params.projection && params.projection.length > 0) {
		lines.push(`- parent projection hint: ${params.projection.join(", ")}`);
	}

	if (params.outputMode === "json") {
		lines.push("", "Return only valid JSON in your final answer.");
	}

	return lines.join("\n");
}

function writeTempPromptFile(prefix: string, content: string): { dir: string; filePath: string } {
	const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
	const filePath = path.join(dir, "prompt.md");
	writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function cleanupTempPrompt(tmp: { dir: string; filePath: string } | null): void {
	if (!tmp) return;
	try {
		rmSync(tmp.filePath, { force: true });
	} catch {
		// Ignore cleanup errors.
	}
	try {
		rmSync(tmp.dir, { force: true, recursive: true });
	} catch {
		// Ignore cleanup errors.
	}
}

function getDotPathValue(source: unknown, dotPath: string): unknown {
	if (!dotPath) return undefined;
	const normalized = dotPath.replace(/\[(\d+)\]/g, ".$1");
	const parts = normalized.split(".").filter(Boolean);
	let current: any = source;
	for (const part of parts) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== "object") return undefined;
		current = current[part];
	}
	return current;
}

function setDotPathValue(target: Record<string, any>, dotPath: string, value: unknown): void {
	const normalized = dotPath.replace(/\[(\d+)\]/g, ".$1");
	const parts = normalized.split(".").filter(Boolean);
	if (parts.length === 0) return;

	let cursor: Record<string, any> = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i];
		if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
		cursor = cursor[key];
	}
	cursor[parts[parts.length - 1]] = value;
}

function projectObject(source: unknown, paths: string[] | undefined): unknown {
	if (!paths || paths.length === 0) return source;
	const projected: Record<string, any> = {};
	for (const p of paths) {
		const value = getDotPathValue(source, p);
		if (value !== undefined) setDotPathValue(projected, p, value);
	}
	return projected;
}

function findMissingRequiredKeys(source: unknown, requiredKeys: string[] | undefined): string[] {
	if (!requiredKeys || requiredKeys.length === 0) return [];
	const missing: string[] = [];
	for (const key of requiredKeys) {
		if (getDotPathValue(source, key) === undefined) missing.push(key);
	}
	return missing;
}

function extractJsonPayload(rawText: string): { value?: unknown; error?: string } {
	const text = rawText.trim();
	if (!text) return { error: "Sub-agent returned empty output; expected JSON" };

	const direct = tryParseJson(text);
	if (direct.ok) return { value: direct.value };

	const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
	let fencedMatch: RegExpExecArray | null;
	while ((fencedMatch = fencedRegex.exec(text)) !== null) {
		const candidate = fencedMatch[1]?.trim() ?? "";
		const parsed = tryParseJson(candidate);
		if (parsed.ok) return { value: parsed.value };
	}

	for (let start = 0; start < text.length; start++) {
		const ch = text[start];
		if (ch !== "{" && ch !== "[") continue;
		const candidate = extractBalancedJsonCandidate(text, start);
		if (!candidate) continue;
		const parsed = tryParseJson(candidate);
		if (parsed.ok) return { value: parsed.value };
	}

	return {
		error: `Unable to parse JSON output. Parse error: ${direct.error ?? "unknown"}`,
	};
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Unknown JSON parse error" };
	}
}

function extractBalancedJsonCandidate(text: string, start: number): string | undefined {
	const openToClose: Record<string, string> = { "{": "}", "[": "]" };
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{" || ch === "[") {
			stack.push(openToClose[ch]);
			continue;
		}

		if (ch === "}" || ch === "]") {
			if (stack.length === 0) return undefined;
			const expected = stack.pop();
			if (expected !== ch) return undefined;
			if (stack.length === 0) return text.slice(start, i + 1);
		}
	}

	return undefined;
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input > 0) parts.push(`↑${usage.input}`);
	if (usage.output > 0) parts.push(`↓${usage.output}`);
	if (usage.cacheRead > 0) parts.push(`R${usage.cacheRead}`);
	if (usage.cacheWrite > 0) parts.push(`W${usage.cacheWrite}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${usage.contextTokens}`);
	return parts.join(" ");
}

async function runSubagent(
	params: {
		cwd: string;
		includeFiles: string[];
		model?: string;
		thinking?: ThinkingLevel;
		tools?: string[];
		timeoutSeconds: number;
		maxTurns: number;
		systemPrompt: string;
		taskPrompt: string;
	},
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void) | undefined,
): Promise<RunResult> {
	const usage: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};

	const trace: TraceItem[] = [];
	const assistantOutputs: string[] = [];
	let stderr = "";
	let assistantTurns = 0;
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let terminationReason: TerminationReason | undefined;

	const tmpPrompt = writeTempPromptFile("pi-subagent-system", params.systemPrompt);
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--append-system-prompt",
		tmpPrompt.filePath,
	];

	if (params.model) args.push("--model", params.model);
	if (params.thinking) args.push("--thinking", params.thinking);
	if (params.tools) {
		if (params.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", params.tools.join(","));
	}
	for (const file of params.includeFiles) args.push(`@${file}`);
	args.push(params.taskPrompt);

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn("pi", args, {
				cwd: params.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuffer = "";
			let timeoutHandle: NodeJS.Timeout | undefined;

			const emitProgress = (status: string) => {
				onUpdate?.({
					content: [{ type: "text", text: status }],
					details: {
						assistantTurns,
						usage,
						status,
					},
				});
			};

			const killChild = (reason: TerminationReason) => {
				if (terminationReason) return;
				terminationReason = reason;
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000);
			};

			const processLine = (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;

				let event: any;
				try {
					event = JSON.parse(trimmed);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start") {
					const name = typeof event.toolName === "string" ? event.toolName : "unknown";
					pushTrace(trace, { type: "tool_call", value: `${name} ${trimPreview(JSON.stringify(event.args ?? {}), 120)}` });
					emitProgress(`Sub-agent running (${assistantTurns} turns, tool: ${name})...`);
					return;
				}

				if (event.type === "tool_execution_end" && event.isError) {
					const name = typeof event.toolName === "string" ? event.toolName : "unknown";
					pushTrace(trace, { type: "tool_error", value: `${name} failed` });
					return;
				}

				if (event.type !== "message_end" || !event.message) return;
				const message = event.message;
				if (message.role !== "assistant") return;

				assistantTurns += 1;
				usage.turns = assistantTurns;
				if (assistantTurns > params.maxTurns) {
					killChild("max_turns_exceeded");
					return;
				}

				const text = extractAssistantText(message);
				if (text) {
					assistantOutputs.push(text);
					pushTrace(trace, { type: "assistant", value: trimPreview(text, 220) });
				}

				const msgUsage = message.usage;
				if (msgUsage) {
					usage.input += msgUsage.input ?? 0;
					usage.output += msgUsage.output ?? 0;
					usage.cacheRead += msgUsage.cacheRead ?? 0;
					usage.cacheWrite += msgUsage.cacheWrite ?? 0;
					usage.cost += msgUsage.cost?.total ?? 0;
					usage.contextTokens = msgUsage.totalTokens ?? usage.contextTokens;
				}

				if (!model && typeof message.model === "string") model = message.model;
				if (typeof message.stopReason === "string") stopReason = message.stopReason;
				if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;

				emitProgress(`Sub-agent running (${assistantTurns} turns)...`);
			};

			child.stdout.on("data", (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});

			if (params.timeoutSeconds > 0) {
				timeoutHandle = setTimeout(() => killChild("timeout"), params.timeoutSeconds * 1000);
			}

			const abortHandler = () => killChild("aborted");
			if (signal?.aborted) abortHandler();
			signal?.addEventListener("abort", abortHandler, { once: true });

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", abortHandler);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			child.on("error", () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", abortHandler);
				resolve(1);
			});
		});

		return {
			exitCode,
			terminationReason,
			stderr,
			assistantTurns,
			model,
			stopReason,
			errorMessage,
			usage,
			assistantOutputs,
			trace,
		};
	} finally {
		cleanupTempPrompt(tmpPrompt);
	}
}

function writeArtifact(run: {
	params: SubagentCallParams;
	resolvedCwd: string;
	systemPrompt: string;
	taskPrompt: string;
	result: RunResult;
	processedOutput?: unknown;
	parseError?: string;
	missingKeys?: string[];
}): string | undefined {
	try {
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-artifact-"));
		const filePath = path.join(dir, "run.json");
		const payload = {
			timestamp: new Date().toISOString(),
			params: run.params,
			resolvedCwd: run.resolvedCwd,
			systemPrompt: run.systemPrompt,
			taskPrompt: run.taskPrompt,
			result: run.result,
			processedOutput: run.processedOutput,
			parseError: run.parseError,
			missingKeys: run.missingKeys,
		};
		writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
		return filePath;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_call",
		label: "Subagent Function",
		description: [
			"Programmatic sub-agent primitive: invoke an isolated sub-agent as a function.",
			"Parent agent composes objective, constraints, and output contract at call-time.",
			"Returns projected result only (minimal context), while detailed trace stays in tool details/artifact.",
			`Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		].join(" "),
		parameters: SubagentCallParams,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as SubagentCallParams;
			const outputMode: OutputMode = params.outputMode ?? "json";
			const timeoutSeconds = clamp(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 5, MAX_TIMEOUT_SECONDS);
			const maxTurns = clamp(params.maxTurns, DEFAULT_MAX_TURNS, 1, MAX_TURNS);
			const includeRawOutput = params.includeRawOutput ?? false;

			const resolvedCwd = resolveWorkingDirectory(ctx.cwd, params.cwd);
			const includeFiles = normalizeFileArgs(resolvedCwd, params.includeFiles);
			const tools = normalizeTools(params.tools);

			const systemPrompt = buildSystemPrompt({
				outputMode,
				outputSchema: params.outputSchema,
				requiredKeys: params.requiredKeys,
				maxTurns,
			});

			const taskPrompt = buildTaskPrompt({
				objective: params.objective,
				instructions: params.instructions,
				outputMode,
				outputSchema: params.outputSchema,
				requiredKeys: params.requiredKeys,
				projection: params.project,
				includeFiles,
			});

			onUpdate?.({
				content: [{ type: "text", text: "Launching sub-agent function..." }],
				details: { status: "starting" },
			});

			const run = await runSubagent(
				{
					cwd: resolvedCwd,
					includeFiles,
					model: params.model,
					thinking: params.thinking,
					tools,
					timeoutSeconds,
					maxTurns,
					systemPrompt,
					taskPrompt,
				},
				signal,
				onUpdate,
			);

			const lastOutput = run.assistantOutputs[run.assistantOutputs.length - 1]?.trim() ?? "";
			const runError =
				run.terminationReason !== undefined ||
				run.exitCode !== 0 ||
				run.stopReason === "error" ||
				run.stopReason === "aborted";

			let contentText = "";
			let isError = false;
			let parseError: string | undefined;
			let missingKeys: string[] | undefined;
			let processedOutput: unknown;

			if (outputMode === "json") {
				const parsed = extractJsonPayload(lastOutput);
				if (parsed.error) {
					parseError = parsed.error;
					isError = true;
					contentText = [
						"Sub-agent JSON contract violation.",
						parseError,
						lastOutput ? `Raw output preview:\n${lastOutput}` : "(no output)",
					].join("\n\n");
				} else {
					missingKeys = findMissingRequiredKeys(parsed.value, params.requiredKeys);
					if (missingKeys.length > 0) {
						isError = true;
						contentText = [
							"Sub-agent JSON output is missing required keys.",
							`Missing: ${missingKeys.join(", ")}`,
							`Raw output:\n${lastOutput || "(no output)"}`,
						].join("\n\n");
					} else {
						processedOutput = projectObject(parsed.value, params.project);
						contentText = JSON.stringify(processedOutput, null, 2);
					}
				}
			} else {
				processedOutput = lastOutput;
				contentText = lastOutput || "(no output)";
			}

			if (!contentText.trim()) {
				isError = true;
				contentText = "Sub-agent returned empty output.";
			}

			if (runError) {
				isError = true;
				const errorBits: string[] = ["Sub-agent execution failed."];
				if (run.terminationReason) errorBits.push(`Termination: ${run.terminationReason}`);
				if (run.stopReason) errorBits.push(`Stop reason: ${run.stopReason}`);
				if (run.errorMessage) errorBits.push(`Error: ${run.errorMessage}`);
				if (run.stderr.trim()) errorBits.push(`stderr: ${trimPreview(run.stderr, 600)}`);
				errorBits.push("", "Last output:", lastOutput || "(no output)");
				contentText = errorBits.join("\n");
			}

			const contentTruncation = truncateHead(contentText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let finalContent = contentTruncation.content;
			if (contentTruncation.truncated) {
				finalContent += `\n\n[Output truncated: ${contentTruncation.outputLines} of ${contentTruncation.totalLines} lines (${formatSize(contentTruncation.outputBytes)} of ${formatSize(contentTruncation.totalBytes)})]`;
			}

			let rawOutputPreview: string | undefined;
			if (includeRawOutput) {
				const raw = run.assistantOutputs.join("\n\n");
				if (raw) {
					const rawTruncation = truncateTail(raw, {
						maxLines: 300,
						maxBytes: 30 * 1024,
					});
					rawOutputPreview = rawTruncation.content;
				}
			}

			const artifactPath = writeArtifact({
				params,
				resolvedCwd,
				systemPrompt,
				taskPrompt,
				result: run,
				processedOutput,
				parseError,
				missingKeys,
			});

			const details: ToolDetails = {
				status: isError ? "error" : "ok",
				objective: params.objective,
				outputMode,
				cwd: resolvedCwd,
				model: run.model ?? params.model,
				thinking: params.thinking,
				tools,
				timeoutSeconds,
				maxTurns,
				assistantTurns: run.assistantTurns,
				usage: run.usage,
				stopReason: run.stopReason,
				terminationReason: run.terminationReason,
				errorMessage: run.errorMessage,
				parseError,
				missingKeys,
				projection: params.project,
				artifactPath,
				trace: run.trace,
				rawOutputPreview,
			};

			return {
				content: [{ type: "text", text: finalContent }],
				details,
				isError,
			};
		},

		renderCall(args, theme) {
			const mode = (args.outputMode as OutputMode | undefined) ?? "json";
			const model = typeof args.model === "string" ? args.model : "default";
			const objective = typeof args.objective === "string" ? args.objective : "(missing objective)";
			let text = theme.fg("toolTitle", theme.bold("subagent_call "));
			text += theme.fg("accent", mode);
			text += theme.fg("muted", ` model:${model}`);
			text += `\n${theme.fg("dim", trimPreview(objective, 120))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const icon = details.status === "ok" ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const usage = formatUsage(details.usage);

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent_call"))} ${theme.fg("muted", `[${details.outputMode}]`)}`;
			if (details.model) text += ` ${theme.fg("dim", details.model)}`;
			if (usage) text += `\n${theme.fg("dim", usage)}`;

			if (details.terminationReason) text += `\n${theme.fg("warning", `termination: ${details.terminationReason}`)}`;
			if (details.parseError) text += `\n${theme.fg("warning", `parse: ${details.parseError}`)}`;
			if (details.missingKeys && details.missingKeys.length > 0) {
				text += `\n${theme.fg("warning", `missing keys: ${details.missingKeys.join(", ")}`)}`;
			}

			if (expanded) {
				text += `\n\n${theme.fg("muted", "Objective:")} ${details.objective}`;
				text += `\n${theme.fg("muted", "cwd:")} ${details.cwd}`;
				if (details.tools) text += `\n${theme.fg("muted", "tools:")} ${details.tools.join(",") || "(none)"}`;
				text += `\n${theme.fg("muted", "limits:")} timeout=${details.timeoutSeconds}s, maxTurns=${details.maxTurns}`;
				if (details.artifactPath) {
					text += `\n${theme.fg("muted", "artifact:")} ${details.artifactPath}`;
				}
				if (details.trace.length > 0) {
					text += `\n\n${theme.fg("muted", "Trace:")}`;
					for (const item of details.trace) {
						const prefix = item.type === "tool_call" ? "→" : item.type === "tool_error" ? "!" : "•";
						text += `\n${theme.fg("dim", `${prefix} ${item.value}`)}`;
					}
				}
				if (details.rawOutputPreview) {
					text += `\n\n${theme.fg("muted", "Raw output preview:")}\n${theme.fg("dim", details.rawOutputPreview)}`;
				}
			} else {
				text += `\n${theme.fg("muted", "(Ctrl+O to expand details)")}`;
			}

			return new Text(text, 0, 0);
		},
	});
}
