# Setting up the GitHub App (for cloning repos + opening PRs)

claude-at authenticates to GitHub as a **GitHub App** so the worker can clone target
repos and open pull requests as itself. You create one App (under your account or an
org), install it on the repos the agent may touch, and store its credentials in Secrets
Manager as `claude-at/github-app-id` and `claude-at/github-app-private-key`.

The App needs these **repository permissions**: **Contents: Read & write**,
**Pull requests: Read & write**, **Metadata: Read-only**.

## Fast path (recommended) — one command

```sh
cd ~/repos/claude-at
AWS_PROFILE=sandbox-admin node scripts/create-github-app.mjs claude-at-agent
# for an org-owned app instead:  GH_ORG=<org> AWS_PROFILE=sandbox-admin node scripts/create-github-app.mjs <name>
```

This opens your browser, pre-fills an App manifest with the correct permissions, and asks
you to confirm. On confirmation it:
- creates the App and generates its private key,
- stores the id + key in Secrets Manager (`claude-at/github-app-id`, `claude-at/github-app-private-key`),
- prints an **install URL** — open it and install the App on **only** the repos the agent
  should be able to read/PR.

> App names are globally unique. If `claude-at-agent` is taken, pass a different name.
> `AWS_PROFILE` must point at the account where the worker runs (the secrets live there).

## Manual fallback

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Name it; Homepage URL can be anything (e.g. the repo URL). **Uncheck Webhook → Active**.
3. **Repository permissions:** Contents = *Read & write*, Pull requests = *Read & write*,
   Metadata = *Read-only* (auto).
4. "Where can this GitHub App be installed?" → *Only on this account*. **Create GitHub App**.
5. Note the **App ID**. Click **Generate a private key** (downloads a `.pem`).
6. Store both in Secrets Manager:
   ```sh
   AWS_PROFILE=sandbox-admin ./scripts/store-secret.sh claude-at/github-app-id '<APP_ID>'
   AWS_PROFILE=sandbox-admin ./scripts/store-secret.sh claude-at/github-app-private-key "$(cat ~/Downloads/<your-key>.pem)"
   ```
7. **Install** the App (App page → *Install App*) on the repos the agent may touch.

## After setup

- Point the default target repo at one the App is installed on:
  `terraform apply -var profile=sandbox-admin -var 'default_repo=<owner>/<name>'`
  (or just route per-message: `@Claude in <owner>/<name>: <task>`).
- Redeploy the worker so it picks up the new secret names + PR code:
  `AWS_PROFILE=sandbox-admin ./scripts/build-and-push.sh`
- Test: `@ClaudeTag in <owner>/<repo>: add a CONTRIBUTING.md with a one-line summary` →
  the worker clones, makes the change, pushes a `claude-at/<id>` branch, and posts the PR link.
