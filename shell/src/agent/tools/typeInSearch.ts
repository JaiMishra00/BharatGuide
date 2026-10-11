import { z } from 'zod';
import { center, telegraph } from '../guardrails';
import type { ToolDef } from '../types';

const schema = z.object({ text: z.string().min(1).max(120).describe('Exactly the granted title from the user command') });

export const typeInSearch: ToolDef<z.infer<typeof schema>> = {
  name: 'type_in_search',
  description:
    "Type the user's granted title into the page's main search box, once. Only during a \"findyt <title>\" YouTube search command; any other text is refused.",
  schema,
  async execute(input, ctx, host) {
    const grant = ctx.grants.check(ctx.taskId, input.text, host.now());
    if (!grant.ok) return { error: grant.reason };
    const snapshot = await host.browser.snapshot();
    const fieldId = snapshot?.searchFieldId;
    if (!fieldId) return { error: 'this page has no main search box; navigate to the site first' };
    const info = await host.browser.elementInfo(fieldId);
    if (!info.found) return { error: 'the search box disappeared; take a fresh look' };
    if (info.sensitive || !info.isSearch) return { error: 'refused: that field is not a plain search box' };
    if (!info.inViewport) return { error: 'the search box is off screen' };

    const c = center(info.rect);
    const origin = host.browser.pageOrigin();
    await telegraph(host, ctx, { x: origin.x + c.x, y: origin.y + c.y }, `Typing: ${input.text}`);
    ctx.grants.consume(); // single use, consumed before typing so a retry can never type twice
    await host.browser.click(c.x, c.y);
    const focused = await host.browser.focusSearch(fieldId);
    if (!focused) return { error: 'could not focus the search box' };
    await host.browser.insertText(input.text);
    const value = await host.browser.searchValue(fieldId);
    return { ok: true, typed: input.text, verified: value === input.text };
  },
};
