export const REGION = process.env.AWS_REGION ?? "us-east-1";

export const MODEL = {
  main: "us.anthropic.claude-opus-4-8",
  smallFast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} as const;

export const NAMES = {
  project: "claude-at",
  table: "claude-at",
  cluster: "claude-at",
  gatewayService: "claude-at-gateway",
  workerFamily: "claude-at-worker",
  gatewayContainer: "gateway",
  workerContainer: "worker",
  ecrGateway: "claude-at/gateway",
  ecrWorker: "claude-at/worker",
  logGroupGateway: "/claude-at/gateway",
  logGroupWorker: "/claude-at/worker",
} as const;

export const SECRET_IDS = {
  discordBotToken: "discord/agent-bot-token",
  discordWebhookUrl: "discord/agent-webhook-url",
  githubAppId: "claude-at/github-app-id",
  githubAppPrivateKey: "claude-at/github-app-private-key",
} as const;

export const DEFAULT_REPO = process.env.DEFAULT_REPO ?? "";

export const AUDIT_BUCKET = process.env.AUDIT_BUCKET ?? "";
export const MEMORY_BUCKET = process.env.MEMORY_BUCKET ?? "";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}
