import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

export const REQUIRED_BENCHMARK_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"workflow",
	"subagent",
	"mcp",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"intercom",
] as const;

export interface ProviderValidation {
	readonly nonceFound: boolean;
	readonly toolNames: readonly string[];
	readonly errors: readonly string[];
}

export interface ProviderRequestRecord extends ProviderValidation {
	readonly index: number;
	readonly firstByteNs: string;
	readonly parsedAtNs: string;
	readonly requestLine: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly raw: string;
}

interface CollectorOptions {
	readonly nowNs?: () => bigint;
	readonly port?: number;
}

function objectRecord(value: object): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function collectToolNames(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const root = objectRecord(value);
	if (!Array.isArray(root.tools)) return [];
	const names: string[] = [];
	for (const tool of root.tools) {
		if (!tool || typeof tool !== "object") continue;
		const record = objectRecord(tool);
		const direct = record.name;
		const fn = record.function;
		const nested = fn && typeof fn === "object" ? objectRecord(fn).name : undefined;
		if (typeof direct === "string") names.push(direct);
		else if (typeof nested === "string") names.push(nested);
	}
	return [...new Set(names)].sort();
}

export function validateProviderRequest(body: string, nonce: string): ProviderValidation {
	const errors: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { nonceFound: false, toolNames: [], errors: ["provider request body is not valid JSON"] };
	}
	const nonceFound = body.includes(nonce);
	if (!nonceFound) errors.push("provider request body is missing the per-run nonce");
	const toolNames = collectToolNames(parsed);
	for (const required of REQUIRED_BENCHMARK_TOOLS) {
		if (!toolNames.includes(required)) errors.push(`provider request is missing required tool schema: ${required}`);
	}
	return { nonceFound, toolNames, errors };
}

function parseHeaders(text: string): { requestLine: string; headers: Record<string, string> } {
	const [requestLine = "", ...lines] = text.split("\r\n");
	const headers: Record<string, string> = {};
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
	}
	return { requestLine, headers };
}

function streamingResponse(): string {
	const chunks = [
		{
			id: "benchmark",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "benchmark-ok" }, finish_reason: null }],
		},
		{
			id: "benchmark",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return [
		"HTTP/1.1 200 OK",
		"Content-Type: text/event-stream",
		"Cache-Control: no-cache",
		"Connection: close",
		`Content-Length: ${Buffer.byteLength(body)}`,
		"",
		body,
	].join("\r\n");
}

export class LoopbackProviderCollector {
	private readonly nonce: string;
	private readonly nowNs: () => bigint;
	private readonly requestedPort: number;
	private server: Server | undefined;
	private requestWaiters: Array<(record: ProviderRequestRecord) => void> = [];
	readonly requests: ProviderRequestRecord[] = [];
	port = 0;

	constructor(nonce: string, options: CollectorOptions = {}) {
		this.nonce = nonce;
		this.nowNs = options.nowNs ?? process.hrtime.bigint;
		this.requestedPort = options.port ?? 0;
	}

	async start(): Promise<void> {
		if (this.server) throw new Error("collector is already running");
		this.server = createServer((socket) => this.handleSocket(socket));
		this.server.listen(this.requestedPort, "127.0.0.1");
		await once(this.server, "listening");
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("collector did not bind a TCP port");
		this.port = address.port;
	}

	async waitForRequest(): Promise<ProviderRequestRecord> {
		const existing = this.requests[0];
		if (existing) return existing;
		return new Promise((resolve) => this.requestWaiters.push(resolve));
	}

	assertSingleValidRequest(): ProviderRequestRecord {
		if (this.requests.length !== 1) {
			throw new Error(`expected exactly one provider request, received ${this.requests.length}`);
		}
		const record = this.requests[0]!;
		if (record.errors.length > 0) throw new Error(record.errors.join("; "));
		return record;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		server.close();
		await once(server, "close");
	}

	private handleSocket(socket: Socket): void {
		let firstByteNs: bigint | undefined;
		let bytes = Buffer.alloc(0);
		let completed = false;
		socket.on("data", (chunk) => {
			firstByteNs ??= this.nowNs();
			bytes = Buffer.concat([bytes, chunk]);
			if (completed) return;
			const headerEnd = bytes.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const headerText = bytes.subarray(0, headerEnd).toString("utf8");
			const parsedHeaders = parseHeaders(headerText);
			const contentLength = Number(parsedHeaders.headers["content-length"] ?? "0");
			const bodyStart = headerEnd + 4;
			if (!Number.isSafeInteger(contentLength) || contentLength < 0 || bytes.length < bodyStart + contentLength)
				return;
			completed = true;
			const body = bytes.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
			const validation = validateProviderRequest(body, this.nonce);
			const record: ProviderRequestRecord = {
				index: this.requests.length,
				firstByteNs: (firstByteNs ?? this.nowNs()).toString(),
				parsedAtNs: this.nowNs().toString(),
				requestLine: parsedHeaders.requestLine,
				headers: parsedHeaders.headers,
				body,
				raw: bytes.subarray(0, bodyStart + contentLength).toString("utf8"),
				...validation,
			};
			this.requests.push(record);
			for (const waiter of this.requestWaiters.splice(0)) waiter(record);
			socket.end(streamingResponse());
		});
		socket.on("error", () => {});
	}
}
