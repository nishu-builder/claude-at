import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_BUCKET,
  DATA_SECRET_PREFIX,
  getSecret,
  syncPrefix,
  type Identity,
} from "@claude-at/shared";

// Where synced datasets live. Deliberately outside the per-job clone (which is
// a fresh mkdtemp deleted after each job) so a warm pool worker keeps the cache
// across jobs and re-syncs incrementally instead of re-downloading.
const DATA_ROOT = join(homedir(), ".claude-at", "data");

// Hook timeout: long enough to start a DB or fetch fixtures, bounded so a
// hanging hook can't pin a pool worker forever.
const SETUP_TIMEOUT_MS = 10 * 60_000;

// Datasets/secrets expose themselves to the hook and the agent as env vars:
// each dataset as `CLAUDE_AT_DATA_<NAME>` (its synced dir) and each secret
// under its configured `env` name. `CLAUDE_AT_DATA_DIR` points at the root.
const envKey = (name: string): string =>
  "CLAUDE_AT_DATA_" + name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();

function parseSource(source: string): { bucket: string; prefix: string } | undefined {
  const m = source.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (m && m[1]) return { bucket: m[1], prefix: m[2] ?? "" };
  if (!DATA_BUCKET) return undefined;
  return { bucket: DATA_BUCKET, prefix: source.replace(/^\/+/, "") };
}

export interface Provisioned {
  env: Record<string, string>;
  lines: string[];
}

// Sync the identity's datasets into the on-worker cache and resolve its mounted
// secrets. Returns env vars to pass to both the hook and the agent, plus
// human-readable lines for the thread. Best-effort per item: a failure is
// reported but doesn't abort the job (the agent may still do useful work).
export async function provisionData(identity: Identity): Promise<Provisioned> {
  const env: Record<string, string> = {};
  const lines: string[] = [];

  const datasets = identity.datasets ?? [];
  if (datasets.length > 0) env.CLAUDE_AT_DATA_DIR = join(DATA_ROOT, identity.id);
  for (const ds of datasets) {
    const loc = parseSource(ds.source);
    if (!loc) {
      lines.push(`⚠️ dataset \`${ds.name}\`: no DATA_BUCKET and source is not an s3:// URI`);
      continue;
    }
    const dest = join(DATA_ROOT, identity.id, ds.name);
    try {
      const { downloaded, total } = await syncPrefix(loc.bucket, loc.prefix, dest);
      env[envKey(ds.name)] = dest;
      lines.push(`📦 dataset \`${ds.name}\`: ${total} object(s), ${downloaded} fetched → \`${dest}\``);
    } catch (e) {
      lines.push(`⚠️ dataset \`${ds.name}\` sync failed: ${String(e)}`);
    }
  }

  for (const sec of identity.secrets ?? []) {
    if (!sec.secretId.startsWith(DATA_SECRET_PREFIX)) {
      lines.push(`⚠️ secret \`${sec.env}\` refused: \`${sec.secretId}\` is outside \`${DATA_SECRET_PREFIX}\``);
      continue;
    }
    try {
      env[sec.env] = await getSecret(sec.secretId);
      lines.push(`🔐 secret → \`$${sec.env}\``);
    } catch (e) {
      lines.push(`⚠️ secret \`${sec.env}\` unavailable: ${String(e)}`);
    }
  }

  return { env, lines };
}

const SETUP_HOOK = ".claude-at/setup.sh";

export interface SetupResult {
  ran: boolean;
  ok: boolean;
  output: string;
}

// Run the repo's setup hook if present, streaming combined stdout/stderr via
// `onChunk` and capturing it. A non-zero exit or timeout resolves `ok: false`
// — the caller decides whether to hand off to the agent on a broken env.
export async function runSetupHook(
  cwd: string,
  env: Record<string, string>,
  onChunk: (text: string) => void,
): Promise<SetupResult> {
  const script = join(cwd, SETUP_HOOK);
  try {
    await access(script);
  } catch {
    return { ran: false, ok: true, output: "" };
  }

  return new Promise<SetupResult>((resolve) => {
    const child = spawn("bash", [SETUP_HOOK], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (d: string): void => {
      output += d;
      if (output.length > 200_000) output = output.slice(-200_000);
      onChunk(d);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      output += `\n[setup hook killed after ${SETUP_TIMEOUT_MS / 1000}s]`;
      child.kill("SIGKILL");
    }, SETUP_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ran: true, ok: false, output: output + `\n[failed to start: ${String(err)}]` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ran: true, ok: code === 0, output });
    });
  });
}

export { SETUP_HOOK };
