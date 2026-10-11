/** Single-use TypingGrant (spec rule 4, 8.9). Created only by the chat layer. */
export type TypingGrant = {
  taskId: string;
  text: string;
  field: 'search';
  usesLeft: 1 | 0;
  expiresAt: number;
};

export const GRANT_TTL_MS = 120_000;

export class GrantStore {
  private grant: TypingGrant | null = null;

  /** Only AgentCore.handleUserMessage calls this, after classifyIntent(). */
  create(taskId: string, text: string, now = Date.now()): TypingGrant {
    this.grant = { taskId, text, field: 'search', usesLeft: 1, expiresAt: now + GRANT_TTL_MS };
    return this.grant;
  }

  check(taskId: string, text: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const grant = this.grant;
    if (!grant) return { ok: false, reason: 'no typing grant: typing only happens for an explicit "findyt <title>" YouTube search command' };
    if (grant.taskId !== taskId) return { ok: false, reason: 'the typing grant belongs to another task' };
    if (grant.usesLeft < 1) return { ok: false, reason: 'the typing grant was already used' };
    if (now >= grant.expiresAt) return { ok: false, reason: 'the typing grant expired' };
    if (text !== grant.text) return { ok: false, reason: `text differs from the granted title; only "${grant.text}" may be typed` };
    return { ok: true };
  }

  consume(): void {
    if (this.grant) this.grant = { ...this.grant, usesLeft: 0 };
  }

  get current(): TypingGrant | null {
    return this.grant;
  }

  drop(): void {
    this.grant = null;
  }
}
