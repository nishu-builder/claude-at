import { spawn } from "node:child_process";

export interface ClaudeResult {
  text: string;
  costUsd?: number;
  sessionId?: string;
  isError: boolean;
}

export interface ClaudeCallbacks {
  onSession?: (id: string) => void;
  onActivity?: (line: string) => void;
  onResult?: (result: ClaudeResult) => void;
  onEvent?: (evt: unknown) => void;
}

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  env?: Record<string, string>;
  callbacks?: ClaudeCallbacks;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function shortInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const pick = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  const detail =
    pick("command") ??
    pick("file_path") ??
    pick("path") ??
    pick("pattern") ??
    pick("url") ??
    pick("description");
  const one = detail ? detail.replace(/\s+/g, " ").trim() : "";
  return one ? `${name}: ${one.slice(0, 160)}` : name;
}

function handleEvent(evt: unknown, cb: ClaudeCallbacks): ClaudeResult | undefined {
  if (typeof evt !== "object" || evt === null) return undefined;
  const e = evt as Record<string, unknown>;
  const type = e.type;

  if (type === "system" && e.subtype === "init" && typeof e.session_id === "string") {
    cb.onSession?.(e.session_id);
    return undefined;
  }

  if (type === "assistant") {
    const message = e.message as { content?: ContentBlock[] } | undefined;
    const content = message?.content ?? [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.replace(/\s+/g, " ").trim();
        if (t) cb.onActivity?.(`💬 ${t.slice(0, 240)}`);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        cb.onActivity?.(`🔧 ${shortInput(block.name, block.input)}`);
      }
    }
    return undefined;
  }

  if (type === "result") {
    const text = typeof e.result === "string" ? e.result : "";
    const costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined;
    const sessionId = typeof e.session_id === "string" ? e.session_id : undefined;
    const isError = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
    const result: ClaudeResult = { text, costUsd, sessionId, isError };
    cb.onResult?.(result);
    return result;
  }

  return undefined;
}

export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const cb = opts.callbacks ?? {};
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(opts.resume ? ["--resume", opts.resume] : []),
  ];

  return new Promise<ClaudeResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let finalResult: ClaudeResult | undefined;
    let stdoutBuf = "";
    let stderr = "";

    const consume = (chunk: string): void => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        cb.onEvent?.(parsed);
        const r = handleEvent(parsed, cb);
        if (r) finalResult = r;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => consume(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (stdoutBuf.trim()) consume("\n");
      if (finalResult) {
        resolve(finalResult);
        return;
      }
      resolve({
        text: stderr.trim() || "claude exited without a result",
        costUsd: undefined,
        sessionId: undefined,
        isError: code !== 0 || true,
      });
    });
  });
}
