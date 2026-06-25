#!/usr/bin/env node
// Create a personal GitHub App for claude-at via the manifest flow, and store
// its id + generated private key in AWS Secrets Manager.
//
// Usage:
//   AWS_PROFILE=sandbox-admin node scripts/create-github-app.mjs [app-name]
//   GH_ORG=my-org AWS_PROFILE=sandbox-admin node scripts/create-github-app.mjs [app-name]
//
// Requires: AWS creds (for Secrets Manager) and a browser. Opens a localhost
// page that submits an App manifest to GitHub; you confirm; GitHub redirects
// back with a one-time code that we exchange for the App id + PEM.

import http from "node:http";
import { exec } from "node:child_process";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const PORT = 8723;
const REGION = process.env.AWS_REGION || "us-east-1";
const APP_NAME = process.argv[2] || "claude-at-agent";
const ORG = process.env.GH_ORG;
const REPO_URL = "https://github.com/nishu-builder/claude-at";

const newAppUrl = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new`
  : "https://github.com/settings/apps/new";

const manifest = {
  name: APP_NAME,
  url: REPO_URL,
  redirect_url: `http://localhost:${PORT}/callback`,
  public: false,
  default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  default_events: [],
};

const sm = new SecretsManagerClient({ region: REGION });

async function storeSecret(name, value) {
  try {
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: value }));
  } catch (e) {
    if (e?.name === "ResourceExistsException") {
      await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } else {
      throw e;
    }
  }
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="font-family:sans-serif">
<p>Creating GitHub App "<b>${esc(APP_NAME)}</b>"… confirm on the next GitHub screen.</p>
<form id="f" method="post" action="${newAppUrl}">
<input type="hidden" name="manifest" value='${esc(JSON.stringify(manifest))}'>
</form><script>document.getElementById("f").submit()</script>
</body></html>`);
    return;
  }

  if (u.pathname === "/callback") {
    const code = u.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("missing code");
      return;
    }
    try {
      const conv = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "claude-at-setup",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!conv.ok) throw new Error(`manifest conversion failed ${conv.status}: ${await conv.text()}`);
      const app = await conv.json();
      await storeSecret("claude-at/github-app-id", String(app.id));
      await storeSecret("claude-at/github-app-private-key", app.pem);
      const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body style="font-family:sans-serif">
<h2>✅ Created GitHub App: ${esc(app.slug)}</h2>
<p>App id <b>${app.id}</b> + private key stored in Secrets Manager
(<code>claude-at/github-app-id</code>, <code>claude-at/github-app-private-key</code>).</p>
<p><a href="${installUrl}">Install it on your repos →</a> (pick only the repos the agent may touch.)</p>
<p>You can close this tab.</p></body></html>`);
      console.log(`\n✅ Created GitHub App: ${app.slug} (id ${app.id})`);
      console.log("   Stored: claude-at/github-app-id, claude-at/github-app-private-key");
      console.log(`   Install on repos: ${installUrl}\n`);
      setTimeout(() => { server.close(); process.exit(0); }, 500);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
      console.error("ERROR:", e);
      setTimeout(() => { server.close(); process.exit(1); }, 500);
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`App name: "${APP_NAME}"${ORG ? `, org: ${ORG}` : ", personal account"}`);
  console.log(`Opening ${url} — confirm the App creation in your browser…`);
  exec(`open "${url}"`, (e) => {
    if (e) console.log("Could not auto-open; open this URL manually:", url);
  });
});
