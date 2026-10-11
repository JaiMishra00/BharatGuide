/** Per-run context message for the planner: tabs, page, known sources, history, mode. */
import { describePage, describeTabs } from './guardrails';
import type { Host, TaskContext } from './types';

export async function buildRunContext(
  host: Host,
  ctx: TaskContext,
  grantedTitle: string | null,
  history: string[],
): Promise<string> {
  const snapshot = await host.browser.snapshot().catch(() => null);
  const parts = [describeTabs(host.browser.listTabs(), host.browser.activeTabId()), describePage(snapshot)];
  if (ctx.chunks.size) {
    parts.push(
      `<known_sources>${[...ctx.chunks.keys()].join(', ')} (retrieved earlier this session; cite them or search again)</known_sources>`,
    );
  }
  if (history.length) parts.push(`<history>\n${history.slice(-6).join('\n')}\n</history>`);
  parts.push(
    grantedTitle
      ? `<mode>YOUTUBE SEARCH COMMAND (findyt). If the active page is not www.youtube.com, navigate to https://www.youtube.com/ first. Then type exactly "${grantedTitle}" once with type_in_search into its search box, press_enter, point at the best matching result and finish. Opening the result is left to the user.</mode>`
      : `<mode>GUIDE. click allowed: ${ctx.userAskedClick}. scroll allowed: ${ctx.userAskedScroll}. typing: never.</mode>`,
  );
  return parts.join('\n');
}

export const HALT_TEXT = {
  user: 'Task stopped. You pressed Esc twice. Nothing else will happen until you send a new message.',
  overlay: 'Task stopped because the ghost cursor could not be shown. Nothing else will happen.',
  tool_cap: 'Task stopped: it took too many steps. Please ask again, maybe in smaller steps.',
  time_cap: 'Task stopped: it took too long. Please try again.',
  rejections: 'Task stopped: I could not produce a safe, sourced answer. Please rephrase or check the official helpline.',
  error: 'Task stopped because of an internal error. Please try again.',
} as const;

export type HaltReason = keyof typeof HALT_TEXT;
