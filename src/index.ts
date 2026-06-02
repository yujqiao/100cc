import OpenAI from "openai";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const SESSION_FILE = "session.json";
const SYSTEM_PROMPT = "You are 100cc, a coding agent.";

function log(label: string, content: string) {
	console.log(`${label}:\t${content}`);
}

class Context {
	constructor(public messages: ChatMsg[] = [{ role: "system", content: [SYSTEM_PROMPT, `Current Workdir: ${process.cwd()}`].join('\n') }]) { }
	save(path: string) {
		writeFileSync(path, JSON.stringify({ messages: this.messages }, null, 2));
	}
	static load(path: string): Context {
		if (!existsSync(path)) return new Context();
		return new Context(JSON.parse(readFileSync(path, "utf8")).messages ?? []);
	}
}

class Model {
	client: OpenAI;
	constructor(private baseURL = process.env.OPENAI_BASE_URL, private apiKey = process.env.OPENAI_API_KEY, private model = process.env.OPENAI_MODEL) {
		if (!this.apiKey) throw new Error("OPENAI_API_KEY is not set");
		if (!this.model) throw new Error("OPENAI_MODEL is not set");
		this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
	}
	async prompt(ctx: Context, userInput: string) {
		log("user", userInput);
		ctx.messages.push({ role: "user", content: userInput });
		while (true) {
			const response = await this.client.chat.completions.create({
				model: this.model!, messages: ctx.messages, tools: TOOLS, tool_choice: "auto",
			});
			const message = response.choices[0]!.message;
			ctx.messages.push(message as ChatMsg);
			if (message.content) log("assistant", message.content);
			if (!message.tool_calls?.length) break;
			ctx.messages.push(...handleToolCalls(message.tool_calls));
		}
	}
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [{
	type: "function",
	function: {
		name: "bash",
		description: "Run a bash command. Returns stdout/stderr and exit code.",
		parameters: {
			type: "object",
			required: ["command"],
			properties: {
				command: { type: "string" },
				timeout_ms: { type: "number", description: "default 60s" },
			},
		},
	},
}]; // bash is all you need

function runBash(command: string, timeout_ms = 60_000): string {
	const result = spawnSync("bash", ["-lc", command], { encoding: "utf8", timeout: timeout_ms });
	const out = [result.stdout, result.stderr && `[stderr]\n${result.stderr}`].filter(Boolean).join('\n').trim();
	const status = result.status ?? `signal:${result.signal}`;
	return `${out}\n[exit ${status}]`.slice(0, 16_000);
}

function handleToolCalls(toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]): ChatMsg[] {
	return toolCalls.flatMap((toolCall): ChatMsg[] => {
		if (toolCall.type !== "function" || toolCall.function.name !== "bash") return [];
		const { name, arguments: argsJson } = toolCall.function;
		log("tool_call", `${name}(${argsJson})`);
		let content: string = "missing result";
		try {
			const args = JSON.parse(argsJson || "{}");
			content = runBash(args.command, args.timeout_ms);
		} catch (e) {
			content = `tool error: ${(e as Error).message}`;
		}
		log("tool_result", content.replaceAll("\n", " ").slice(0, 120) + "...");
		return [{ role: "tool", tool_call_id: toolCall.id, content }];
	});
}

await new Command()
	.name("100cc").description("a minimal coding agent").argument("[prompt]", "prompt to run")
	.option("-p, --print", "non-interactive mode: run prompt and exit")
	.option("-c, --continue", "continue the last session")
	.action(async (prompt: string | undefined, opts: { print?: boolean; continue?: boolean }) => {
		if (!opts.print) throw new Error("FIXME: interactive mode not implemented yet; ask the program to write itself");
		if (!prompt) throw new Error("missing prompt: 100cc -p <prompt>");
		const ctx = opts.continue ? Context.load(SESSION_FILE) : new Context();
		await new Model().prompt(ctx, prompt);
		ctx.save(SESSION_FILE);
	})
	.parseAsync(process.argv)
