# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in claude-at, please report it
privately. **Do not open a public issue, pull request, or Discord message**
for anything security-sensitive.

Email **nishu.builder@gmail.com** with:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Any relevant logs, configuration, or affected versions/commits.

You can expect an initial acknowledgement within a few days. Please give us a
reasonable window to investigate and ship a fix before any public disclosure.

## Scope

claude-at runs an autonomous Claude Code agent inside an **ephemeral, isolated
AWS Fargate container** — the container *is* the sandbox. Reports that are
especially valuable include:

- Ways for a worker to escape its container or affect other jobs.
- Exposure of secrets (GitHub App credentials, Discord tokens, AWS
  credentials) beyond the boundaries described in [CONTRIBUTING.md](CONTRIBUTING.md).
- Privilege escalation in the Terraform-defined IAM roles, or breaches of the
  least-privilege and non-root-worker constraints.
- Authentication or authorization flaws in the gateway's handling of Discord
  mentions and job dispatch.

## Out of scope

- The agent reading or modifying files **within** its own cloned repository
  and container — that is the intended, sandboxed behavior.
- Vulnerabilities in upstream dependencies that are already publicly known and
  tracked by their own maintainers (though a heads-up is still welcome).
