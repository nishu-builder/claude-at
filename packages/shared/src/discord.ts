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
}
