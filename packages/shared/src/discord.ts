const API = "https://discord.com/api/v10";

export const DISCORD_MAX = 2000;

export function truncate(s: string, max = DISCORD_MAX): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export class Discord {
  constructor(private token: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "claude-at (https://github.com/nishu-builder/claude-at, 0.0.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, (retry + 0.25) * 1000));
      return this.req(method, path, body);
    }
    if (!res.ok) throw new Error(`discord ${method} ${path} ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  me(): Promise<{ id: string; username: string }> {
    return this.req("GET", "/users/@me");
  }

  createMessage(channelId: string, content: string): Promise<{ id: string }> {
    return this.req("POST", `/channels/${channelId}/messages`, { content: truncate(content) });
  }

  editMessage(channelId: string, messageId: string, content: string): Promise<{ id: string }> {
    return this.req("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: truncate(content) });
  }

  startThreadFromMessage(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    return this.req("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
      name: truncate(name, 100),
      auto_archive_duration: 1440,
    });
  }

  createThread(channelId: string, name: string): Promise<{ id: string }> {
    return this.req("POST", `/channels/${channelId}/threads`, {
      name: truncate(name, 100),
      type: 11,
      auto_archive_duration: 1440,
    });
  }

  listChannelWebhooks(channelId: string): Promise<Webhook[]> {
    return this.req("GET", `/channels/${channelId}/webhooks`);
  }

  createWebhook(channelId: string, name: string): Promise<Webhook> {
    return this.req("POST", `/channels/${channelId}/webhooks`, { name: truncate(name, 80) });
  }

  // Find an existing claude-at webhook on the channel, or create one. Webhooks
  // live on the parent text channel; a message is delivered into a thread via
  // the `thread_id` query param at execute time.
  async ensureWebhook(channelId: string, name = "claude-at"): Promise<Webhook> {
    const hooks = await this.listChannelWebhooks(channelId);
    const mine = hooks.find((h) => h.name === name && h.token);
    return mine ?? (await this.createWebhook(channelId, name));
  }

  // Post as a per-message identity (custom username + avatar). Unlike editing
  // the bot's own profile, each execute call carries its own username/avatar,
  // so previously posted messages are never retroactively changed. `threadId`
  // routes the message into a thread under the webhook's parent channel. With
  // `wait` the created message is returned (so it can later be edited).
  async executeWebhook(
    webhook: Webhook,
    opts: { content: string; username?: string; avatarUrl?: string; threadId?: string; wait?: boolean },
  ): Promise<{ id: string } | null> {
    const params = new URLSearchParams();
    if (opts.wait) params.set("wait", "true");
    if (opts.threadId) params.set("thread_id", opts.threadId);
    const qs = params.toString() ? `?${params}` : "";
    return this.req("POST", `/webhooks/${webhook.id}/${webhook.token}${qs}`, {
      content: truncate(opts.content),
      username: opts.username,
      avatar_url: opts.avatarUrl,
    });
  }

  editWebhookMessage(
    webhook: Webhook,
    messageId: string,
    content: string,
    threadId?: string,
  ): Promise<{ id: string }> {
    const qs = threadId ? `?thread_id=${threadId}` : "";
    return this.req("PATCH", `/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}${qs}`, {
      content: truncate(content),
    });
  }
}

export interface Webhook {
  id: string;
  token?: string;
  name?: string;
  channel_id?: string;
}
