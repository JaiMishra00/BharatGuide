/**
 * Route catalogs (e.g. parivahan.UP.json): recorded click paths to official
 * services. Each route is a list of open / hover / click / select steps that
 * the ghost cursor points at one by one while the user does them (routeGuide).
 * The catalog is local data; it is validated here and anything that does not
 * match the schema is skipped, never guessed.
 */
import { z } from 'zod';

const targetSchema = z.object({
  css: z.string().optional(),
  href: z.string().optional(),
  name: z.string().default(''),
  near: z.string().optional(),
  role: z.string().optional(),
  field: z.string().optional(),
});

const stepSchema = z.object({
  action: z.enum(['open', 'hover', 'click', 'select']),
  url: z.string().optional(),
  target: targetSchema.optional(),
  option: z.object({ text: z.string(), value: z.string().optional() }).optional(),
  hint: z.string().default(''),
});

const serviceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  portal: z.string().default(''),
  category: z.string().default(''),
  url: z.string().min(1),
  status: z.enum(['ok', 'unverified', 'gate']).catch('unverified'),
  gates: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  route: z.array(stepSchema).min(1),
});

const catalogSchema = z.object({
  site: z.string().default(''),
  seed: z.string().optional(),
  state: z.object({ name: z.string(), code: z.string().optional() }).optional(),
  services: z.array(z.unknown()),
});

export type RouteTarget = z.infer<typeof targetSchema>;
export type RouteStep = z.infer<typeof stepSchema>;
export type RouteService = z.infer<typeof serviceSchema> & { site: string; stateName?: string; seed?: string };

function isHttps(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate one catalog file's JSON. Invalid services are skipped (and counted). */
export function parseCatalog(json: unknown): { services: RouteService[]; skipped: number } {
  const catalog = catalogSchema.safeParse(json);
  if (!catalog.success) return { services: [], skipped: 0 };
  const services: RouteService[] = [];
  let skipped = 0;
  for (const raw of catalog.data.services) {
    const parsed = serviceSchema.safeParse(raw);
    const ok =
      parsed.success &&
      isHttps(parsed.data.url) &&
      parsed.data.route.every(
        (s) => (s.action === 'open' ? isHttps(s.url) : Boolean(s.target)) && (!s.url || isHttps(s.url)),
      );
    if (!ok) {
      skipped += 1;
      continue;
    }
    const seed = isHttps(catalog.data.seed) ? catalog.data.seed : undefined;
    services.push({ ...parsed.data, site: catalog.data.site, stateName: catalog.data.state?.name, seed });
  }
  return { services, skipped };
}

/** Every host a catalog route may open (added to the navigation allowlist at boot). */
export function routeHosts(services: RouteService[]): string[] {
  const hosts = new Set<string>();
  for (const service of services) {
    for (const raw of [service.url, ...service.route.map((s) => s.url)]) {
      if (!raw) continue;
      try {
        hosts.add(new URL(raw).hostname.toLowerCase());
      } catch {
        // validated already
      }
    }
  }
  return [...hosts];
}

/** origin + path (+ query when withQuery), lower case, no trailing slash: for "is the user on this page?". */
export function normUrl(raw: string, withQuery = true): string | null {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${u.hostname.toLowerCase()}${path}${withQuery ? u.search : ''}`;
  } catch {
    return null;
  }
}

/** True when `current` is the page `target` (query must match too when the target has one). */
export function samePage(current: string, target: string): boolean {
  const t = normUrl(target, true);
  if (!t) return false;
  const hasQuery = (() => {
    try {
      return new URL(target).search.length > 1;
    } catch {
      return false;
    }
  })();
  return hasQuery ? normUrl(current, true) === t : normUrl(current, false) === normUrl(target, false);
}

// ---- Matching a user request ("apply for learner license") to a service ----

/** Spelling + common transport abbreviations, applied to both sides. */
const CANON: [RegExp, string][] = [
  [/\blicen[cs]es?\b/g, 'licence'],
  [/\bdriving school licence\b/g, 'dsl'],
  [/\b(?:learner|learners|learning) licence\b/g, 'll'],
  [/\b(?:conductor|conductors) licence\b/g, 'cl'],
  [/\bdriving licence\b/g, 'dl'],
  [/\binternational driving permit\b/g, 'idp'],
  [/\bregistration certificate\b/g, 'rc'],
  [/\brenew(?:ing)?\b/g, 'renewal'],
];

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'at', 'my', 'me', 'i', 'im', 'and', 'or', 'with', 'from', 'is',
  'page', 'option', 'link', 'button', 'tab', 'menu', 'section', 'website', 'web', 'site', 'portal',
  'service', 'services', 'online', 'please', 'parivahan', 'sarathi', 'vahan', 'up', 'uttar', 'pradesh',
  // request words, so a whole sentence ("how do I renew my DL on parivahan") can be matched
  'how', 'do', 'does', 'can', 'could', 'want', 'need', 'would', 'like', 'get', 'help', 'guide', 'navigate',
  'through', 'take', 'show', 'open', 'go', 'you', 'it', 'there', 'where', 'use', 'visit', 'explore', 'about',
  'tour', 'around', 'walk', 'main', 'official', 'gov', 'govt', 'government',
]);

export type SiteRequest = { portal: 'Sarathi' | 'Vahan' | null };

/**
 * "navigate me through parivahan website", "open sarathi": the user names the
 * site itself, not a service. Only when nothing but the site name (and filler
 * words) is left.
 */
export function siteRequest(query: string): SiteRequest | null {
  if (!/\b(parivahan|sarathi|vahan)\b/i.test(query)) return null;
  if (routeTokens(query).length) return null;
  return { portal: /\bsarathi\b/i.test(query) ? 'Sarathi' : /\bvahan\b/i.test(query) ? 'Vahan' : null };
}

/** Transport words: a whole question that mentions them may be answered with a catalog route. */
export const TRANSPORT_TOPIC = /\b(parivahan|sarathi|vahan|licen[cs]e|dl|ll|driving|learner|vehicle|permit|rc|fitness|conductor)\b/i;

/** Words that alone are too generic to pick a catalog route ("guide me to login"). */
const GENERIC = new Set(['home', 'login', 'log', 'contact', 'us', 'help', 'apply', 'how', 'status', 'print', 'receipt']);

function stem(token: string): string {
  return token.length > 4 ? token.replace(/(?:ings?|ions?|ments?|s)$/, '') : token;
}

export function routeTokens(text: string): string[] {
  let t = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of CANON) t = t.replace(re, to);
  return [...new Set(t.split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
}

export type RouteMatch =
  | { kind: 'match'; service: RouteService; score: number }
  | { kind: 'ambiguous'; options: RouteService[] };

const STATUS_RANK: Record<RouteService['status'], number> = { ok: 0, unverified: 1, gate: 2 };

/**
 * Best service for the request, or null when nothing fits well enough.
 * Accepts when every request word is in the title (or an alias), or most of
 * them are and they cover at least half the title. A tie between different
 * titles ("change of address" -> CL and DL) is reported as ambiguous.
 */
export function matchService(services: RouteService[], query: string): RouteMatch | null {
  const q = routeTokens(query);
  if (!q.length) return null;
  const mentionsSite = /\b(parivahan|sarathi|vahan)\b/i.test(query);
  if (!mentionsSite && q.every((t) => GENERIC.has(t))) return null;

  const scored: { service: RouteService; score: number; key: string }[] = [];
  for (const service of services) {
    let best = 0;
    for (const label of [service.title, ...service.aliases]) {
      const t = routeTokens(label);
      if (!t.length) continue;
      const shared = q.filter((w) => t.includes(w)).length;
      const qCov = shared / q.length;
      const tCov = shared / t.length;
      if (!(qCov === 1 || (qCov >= 0.67 && tCov >= 0.5))) continue;
      const exact = qCov === 1 && tCov === 1 ? 1 : 0;
      best = Math.max(best, qCov * 2 + tCov + exact);
    }
    if (best > 0) scored.push({ service, score: best, key: routeTokens(service.title).join(' ') });
  }
  if (!scored.length) return null;
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      STATUS_RANK[a.service.status] - STATUS_RANK[b.service.status] ||
      a.service.route.length - b.service.route.length,
  );
  const top = scored[0];
  const tied = scored.filter((s) => Math.abs(s.score - top.score) < 1e-6);
  const distinct = [...new Map(tied.map((s) => [s.key, s.service])).values()];
  if (distinct.length > 1) return { kind: 'ambiguous', options: distinct.slice(0, 5) };
  return { kind: 'match', service: top.service, score: top.score };
}
