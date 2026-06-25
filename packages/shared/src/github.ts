import jwt from "jsonwebtoken";
import { getSecret } from "./secrets";
import { SECRET_IDS } from "./config";

async function appJwt(): Promise<string> {
  const appId = (await getSecret(SECRET_IDS.githubAppId)).trim();
  const pem = await getSecret(SECRET_IDS.githubAppPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 30, exp: now + 540, iss: appId }, pem, { algorithm: "RS256" });
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-at",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`github ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function installationToken(owner: string, repo: string): Promise<string> {
  const app = await appJwt();
  const inst = await gh(`/repos/${owner}/${repo}/installation`, app);
  const tok = await gh(`/app/installations/${inst.id}/access_tokens`, app, { method: "POST" });
  return tok.token as string;
}

export function authedCloneUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export async function createPullRequest(
  owner: string,
  repo: string,
  token: string,
  pr: { title: string; head: string; base: string; body?: string },
): Promise<{ url: string; number: number }> {
  const data = await gh(`/repos/${owner}/${repo}/pulls`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pr),
  });
  return { url: data.html_url as string, number: data.number as number };
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`invalid repo '${repo}', expected owner/name`);
  return { owner, name };
}

export function extractRepo(text: string): { repo?: string; rest: string } {
  const m = text.match(/^\s*in\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)[\s:]+([\s\S]*)$/i);
  if (m && m[1]) return { repo: m[1], rest: (m[2] ?? "").trim() };
  return { rest: text.trim() };
}
