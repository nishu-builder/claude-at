# Discord Bot Setup Runbook

One-time setup to create the Discord application, enable the required intent, store
the bot token, and invite the bot to your server.

## 1. Create the application

1. Go to https://discord.com/developers/applications
2. Click **New Application**.
3. Name it **Claude** (or `claude-at`) and create it.

## 2. Add the bot and enable intents

1. Open the **Bot** tab.
2. Click **Add Bot** (confirm).
3. Under **Privileged Gateway Intents**, enable:
   - **MESSAGE CONTENT INTENT** — required (the bot reads message text to detect mentions/commands).
   - **SERVER MEMBERS INTENT** — optional, enable if convenient.
4. Save changes.

## 3. Copy and store the bot token

1. Still on the **Bot** tab, click **Reset Token** (or **Copy** if shown) to reveal the **Bot Token**.
2. Store it in AWS Secrets Manager:

   ```bash
   ./scripts/store-secret.sh discord/agent-bot-token '<TOKEN>'
   ```

   The token is shown only once — store it immediately. If you lose it, reset and re-store.

## 4. Invite the bot to your server

1. Open **OAuth2 → URL Generator**.
2. Under **Scopes**, select: `bot`.
3. Under **Bot Permissions**, select:
   - View Channels
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Read Message History
   - Embed Links
4. Copy the generated URL at the bottom, open it in a browser, choose the target server, and authorize.

## Notes

- The **Application ID** and **Public Key** are only needed for the (future)
  slash-command Interactions path, not for v1. No action required now.
- Auth to Claude/Bedrock is handled by the worker's IAM task role
  (`CLAUDE_CODE_USE_BEDROCK=1`) — there is no `ANTHROPIC_API_KEY` to manage.
