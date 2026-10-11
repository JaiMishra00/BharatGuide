/**
 * Intent classification in code, by the chat layer (spec 8.9). This module is
 * the ONLY origin of a TypingGrant. The planner can never create one.
 */
export type Intent =
  | { kind: 'search_command'; title: string }
  | { kind: 'guidance'; userAskedClick: boolean; userAskedScroll: boolean; locate?: string };

/**
 * Phrases that start a YouTube search command (the only typing the agent ever
 * does). "find X" / "search for X" are NOT search commands: they are ghost
 * cursor guidance (see locateTarget).
 */
export const DEFAULT_SEARCH_PHRASES = ['findyt'];

/**
 * "guide me to the submit appeal option", "where is Fill Form 6", "show me the
 * login button", "find Apply for Learner Licence", "search for track appeal"
 * -> the target label/service. A where-is-it request answered in code: a route
 * from the catalog, or the label on the page (no model needed).
 */
export function locateTarget(message: string): string | null {
  const text = message.trim().replace(/[?.!]+$/, '');
  const m =
    /^(?:please\s+|can you\s+|could you\s+)?(?:guide me to|guide me through|take me to|take me through|walk me through|navigate me to|navigate me through|navigate through|navigate to|go to|open|point me to|point to|point at|show me|lead me to|help me find|where is|where's|where do i find|how do i get to|search for|search|find|look for|locate)\s+(.+)$/i.exec(text);
  if (!m) return null;
  // "find out how to ..." is a question, not a where-is-it request.
  if (/^out\b/i.test(m[1])) return null;
  const target = m[1]
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+(?:option|button|link|tab|section|menu|page|on this page|here|website|web site|site|portal|homepage|home page)$/i, '')
    .replace(/["“”'‘’]/g, '')
    .trim();
  return target.length >= 3 && target.length <= 80 ? target : null;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifyIntent(message: string, phrases: string[]): Intent {
  const text = message.trim();
  const alternatives = phrases.map(escape).join('|') || DEFAULT_SEARCH_PHRASES.map(escape).join('|');
  const match = new RegExp(`^(?:please\\s+)?(?:${alternatives})\\s+(.+)$`, 'i').exec(text);
  if (match) {
    let title = match[1].trim();
    const quoted = /^["“'](.+?)["”']/.exec(title);
    if (quoted) title = quoted[1];
    title = title.replace(/\s+on\s+youtube\.?$/i, '').replace(/[.?!]+$/, '').trim();
    // "find the register button" is guidance, not a video search.
    const looksLikeUi = /^(the\s+)?(button|link|tab|field|box|form|menu|page|option)\b/i.test(title) ||
      /\b(button|link|field|box|menu)$/i.test(title);
    if (title && title.length <= 120 && !looksLikeUi) return { kind: 'search_command', title };
  }
  const lowered = text.toLowerCase();
  const locate = locateTarget(text);
  return {
    kind: 'guidance',
    userAskedClick: /\b(click|press|tap|open it|select it|choose it)\b/.test(lowered),
    userAskedScroll: /\bscroll\b/.test(lowered),
    ...(locate ? { locate } : {}),
  };
}
