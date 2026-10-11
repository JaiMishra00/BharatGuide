/**
 * Guided route (catalog, e.g. parivahan.UP.json): walk the recorded steps one
 * at a time. The agent opens the start page itself (allowlisted navigate),
 * then for every hover / click / select it ONLY points (point_at) and waits
 * until the USER has done it: the page moved on, the next menu item appeared,
 * or the expected URL loaded. It never clicks, selects or types for the user.
 * If the user is already part-way along the route, it starts from there.
 */
import { runTool, type HaltFn } from './executor';
import { checkUserFacingText } from './guardrails';
import { samePage, type RouteService, type RouteStep, type RouteTarget } from './routes';
import { streamAssistant } from './speak';
import { stripPageLabels } from './tools/pointAt';
import type { Host, TaskContext } from './types';

/** How long the user has for one step before the guide pauses. */
export const STEP_WAIT_MS = 120_000;
/** How long a step's element may take to appear (page still rendering). */
export const TARGET_APPEAR_MS = 8_000;
const TICK_MS = 500;

type Hit = { id: string; name: string };

/** One line, no quote marks (keeps the fact guard out of UI text). */
export function cleanLabel(text: string, max = 60): string {
  return text.replace(/\s+/g, ' ').replace(/["“”'‘’]/g, '').trim().slice(0, max);
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function labelsMatch(found: string, wanted: string): boolean {
  const a = norm(found);
  const b = norm(wanted);
  return Boolean(a && b) && (a.includes(b) || (a.length >= 3 && b.includes(a)));
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

export function currentUrl(host: Host): string {
  const id = host.browser.activeTabId();
  return host.browser.listTabs().find((t) => t.id === id)?.url ?? '';
}

/**
 * Index of the step to do next when the browser is at `url`, considering only
 * steps after `after`: the final service page -> route length (done); the
 * destination of step j -> j + 1. -1 when the URL is not on the route.
 */
export function stepAfterUrl(service: RouteService, after: number, url: string): number {
  if (!url) return -1;
  if (samePage(url, service.url)) return service.route.length;
  for (let j = service.route.length - 1; j > after; j -= 1) {
    const target = service.route[j].url;
    if (target && samePage(url, target)) return j + 1;
  }
  return -1;
}

/** Find a step's element on the current page: recorded selector first, then its visible label. */
export async function findTarget(host: Host, target: RouteTarget): Promise<Hit | null> {
  const name = cleanLabel(target.name ?? '', 120);
  if (target.css) {
    const hit = await host.browser.findBySelector(target.css, name || undefined).catch(() => null);
    if (hit) return hit;
  }
  const text = name || cleanLabel(target.near ?? '', 120);
  if (text.length < 2) return null;
  const hit = await host.browser.findByText(text).catch(() => null);
  return hit && labelsMatch(hit.name, text) ? hit : null;
}

export async function waitForTarget(host: Host, ctx: TaskContext, target: RouteTarget): Promise<Hit | null> {
  for (let k = 0; k <= TARGET_APPEAR_MS / TICK_MS; k += 1) {
    const hit = await findTarget(host, target);
    if (hit || ctx.signal.aborted) return hit;
    await host.sleep(TICK_MS, ctx.signal).catch(() => undefined);
  }
  return null;
}

function stepHint(step: RouteStep, label: string, k: number, n: number): string {
  const at = `Step ${k}/${n}:`;
  if (step.action === 'hover') return `${at} move your mouse over ${label} to open its menu`;
  if (step.action === 'select') {
    const option = cleanLabel(step.option?.text ?? '', 40);
    return option ? `${at} choose ${option} in this list` : `${at} choose an option in this list`;
  }
  return `${at} click ${label}`;
}

/** The hint must pass the same guard as any model hint; fall back to a bare one if not. */
function safeHint(hint: string, label: string, ctx: TaskContext, k: number, n: number): string {
  const unlabeled = stripPageLabels(hint, label ? [label.toLowerCase()] : []);
  return checkUserFacingText(unlabeled, 'ui', [], ctx.chunks).ok ? hint : `Step ${k}/${n}: here`;
}

function verb(step: RouteStep): string {
  return step.action === 'hover' ? 'move your mouse over' : step.action === 'select' ? 'choose from' : 'click';
}

const GATE_TEXT: Record<string, string> = { login: 'log in', captcha: 'type the captcha', mobile: 'verify your mobile number' };

export function gateNote(service: RouteService): string {
  const asks = service.gates.map((g) => GATE_TEXT[g] ?? g).filter(Boolean);
  if (!asks.length) return '';
  const list = asks.length > 1 ? `${asks.slice(0, -1).join(', ')} and ${asks.at(-1)}` : asks[0];
  return ` This service will ask you to ${list}. Please do that yourself; I never type logins, captchas or OTPs.`;
}

/**
 * "navigate me through parivahan website": open the portal home page (the
 * shared first step of the catalog routes), point at its main menu and, for a
 * named portal (Sarathi = licences, Vahan = vehicles), at that portal's entry.
 * Returns false only when the open itself failed; true = shown to the user.
 */
export async function tourSite(
  services: RouteService[],
  portal: 'Sarathi' | 'Vahan' | null,
  ctx: TaskContext,
  host: Host,
  halt: HaltFn,
): Promise<'ok' | 'stopped' | 'failed'> {
  const pool = portal ? services.filter((s) => s.portal === portal) : services;
  const first = pool.find((s) => s.route[0]?.action === 'open');
  const home = first?.route[0].url ?? services[0]?.seed;
  if (!home) return 'failed';
  ctx.toolCap = Math.max(ctx.toolCap ?? 0, 10);
  if (!samePage(currentUrl(host), home)) {
    const out = await runTool('navigate', { url: home }, ctx, host, halt);
    if (out.stop) return 'stopped';
    if (out.error) return 'failed';
  }
  // Point at the menu every route starts with ("Online Services"), then the portal's own entry.
  const menu = first?.route.find((s) => s.action === 'hover')?.target;
  const entry = first?.route.find((s, k) => k > 0 && s.action === 'click')?.target;
  if (menu) {
    const hit = await waitForTarget(host, ctx, menu);
    if (hit) {
      const label = cleanLabel(menu.name || hit.name);
      const out = await runTool('point_at', { target_area: 'page', target_id: hit.id, target_text: label, hint: `Move your mouse over ${label} to see all services` }, ctx, host, halt);
      if (out.stop) return 'stopped';
      if (portal && entry) {
        ctx.machine.apply('wait_entered');
        host.chat.emit({ t: 'status', text: `Waiting for you to open ${label}…` });
        let shown: Hit | null = null;
        const deadline = host.now() + STEP_WAIT_MS;
        for (let k = 0; k < STEP_WAIT_MS / TICK_MS && !shown && host.now() < deadline && !ctx.signal.aborted; k += 1) {
          shown = await findTarget(host, entry);
          if (shown) break;
          await host.browser.waitForEvent('any', TICK_MS * 2, ctx.signal);
          await host.sleep(TICK_MS, ctx.signal).catch(() => undefined);
        }
        if (!ctx.signal.aborted) ctx.machine.apply('user_acted');
        host.chat.emit({ t: 'status', text: null });
        if (ctx.signal.aborted) return 'stopped';
        if (shown) {
          const name = cleanLabel(entry.name || shown.name);
          const out2 = await runTool('point_at', { target_area: 'page', target_id: shown.id, target_text: name, hint: `Click ${name} for ${portal} services` }, ctx, host, halt);
          if (out2.stop) return 'stopped';
        }
      }
    }
  }
  return 'ok';
}

/** A few example services for the chat, one per category. */
export function exampleServices(services: RouteService[], portal: 'Sarathi' | 'Vahan' | null, max = 6): string[] {
  const pool = (portal ? services.filter((s) => s.portal === portal) : services).filter((s) => s.status !== 'gate');
  const picks: string[] = [];
  const preferred = ['Apply for Learner Licence', 'Apply for Driving Licence', 'Apply for DL Renewal', 'Application Status', 'Appointments', 'Vehicle Related Services', 'Permit Related Services', 'Vehicle Fitness Testing'];
  for (const title of preferred) {
    if (pool.some((s) => s.title === title) && !picks.includes(title)) picks.push(title);
  }
  for (const s of pool) if (picks.length < max && !picks.includes(s.title)) picks.push(s.title);
  return picks.slice(0, max).map((t) => cleanLabel(t, 60));
}

export type RouteOutcome = 'done' | 'arrived' | 'lost' | 'timeout' | 'stopped';

/**
 * Has the user done step i? True when the page moved on along the route, the
 * expected URL loaded, or (hover/select) the next step's element appeared.
 */
async function stepDone(host: Host, service: RouteService, i: number, startUrl: string): Promise<number | null> {
  const step = service.route[i];
  const url = currentUrl(host);
  const along = stepAfterUrl(service, i - 1, url);
  if (along > i) return along;
  if (step.url && samePage(url, step.url)) return i + 1;
  const next = service.route[i + 1];
  if ((step.action === 'hover' || step.action === 'select') && next?.target) {
    if (await findTarget(host, next.target)) return i + 1;
  }
  // A click that left the page without reaching the recorded URL (redirect, session id in the URL).
  if (step.action === 'click' && url && startUrl && url !== startUrl) return i + 1;
  return null;
}

async function waitForStep(host: Host, ctx: TaskContext, service: RouteService, i: number): Promise<number | 'timeout' | 'stopped'> {
  const startUrl = currentUrl(host);
  const deadline = host.now() + STEP_WAIT_MS;
  ctx.machine.apply('wait_entered');
  host.chat.emit({ t: 'status', text: `Waiting for you to ${verb(service.route[i])} it…` });
  try {
    for (let k = 0; k < STEP_WAIT_MS / TICK_MS && host.now() < deadline; k += 1) {
      if (ctx.signal.aborted || ctx.stopped) return 'stopped';
      const done = await stepDone(host, service, i, startUrl);
      if (done !== null) return done;
      // Woken early by any user action; otherwise re-check every tick.
      await host.browser.waitForEvent('any', TICK_MS * 2, ctx.signal);
      if (ctx.signal.aborted) return 'stopped';
      await host.sleep(TICK_MS, ctx.signal).catch(() => undefined);
    }
    return 'timeout';
  } finally {
    if (!ctx.signal.aborted) ctx.machine.apply('user_acted');
    host.chat.emit({ t: 'status', text: null });
  }
}

/**
 * Walk the route. Returns how it ended; the caller writes the closing message
 * (finish) for every outcome except 'stopped'.
 */
export async function runRoute(service: RouteService, ctx: TaskContext, host: Host, halt: HaltFn): Promise<{ outcome: RouteOutcome; step: number; label?: string }> {
  const steps = service.route;
  const n = steps.length;
  // Each step uses at most point_at (+ navigate for open), plus finish.
  ctx.toolCap = Math.max(ctx.toolCap ?? 0, n * 2 + 4);

  let i = stepAfterUrl(service, -1, currentUrl(host));
  if (i >= n) return { outcome: 'arrived', step: n };
  if (i < 0) i = 0;
  if (i > 0) await streamAssistant(host, `You are already on the way, so we start at step ${i + 1} of ${n}.`, undefined, ctx.signal);

  while (i < n) {
    if (ctx.signal.aborted || ctx.stopped) return { outcome: 'stopped', step: i };
    const step = steps[i];
    if (step.action === 'open') {
      const out = await runTool('navigate', { url: step.url }, ctx, host, halt);
      if (out.stop) return { outcome: 'stopped', step: i };
      if (out.error) return { outcome: 'lost', step: i, label: hostOf(step.url ?? '') };
      i += 1;
      // A redirect may already have moved us further along the route.
      const along = stepAfterUrl(service, i - 1, currentUrl(host));
      if (along > i) i = along;
      continue;
    }

    const target = step.target!;
    // A hover whose menu item is already showing (menu open, mobile layout) needs no pointing.
    const next = steps[i + 1];
    if (step.action === 'hover' && next?.target && (await findTarget(host, next.target))) {
      i += 1;
      continue;
    }
    const hit = await waitForTarget(host, ctx, target);
    if (!hit) {
      // Not on the page: maybe the user already did it (menu open, page changed).
      const along = stepAfterUrl(service, i, currentUrl(host));
      if (along > i) {
        i = along;
        continue;
      }
      return { outcome: 'lost', step: i, label: cleanLabel(target.name || target.near || '') };
    }

    const label = cleanLabel(target.name || hit.name) || cleanLabel(hit.name);
    const hint = safeHint(stepHint(step, label, i + 1, n), label, ctx, i + 1, n);
    const out = await runTool('point_at', { target_area: 'page', target_id: hit.id, target_text: label || undefined, hint }, ctx, host, halt);
    if (out.stop) return { outcome: 'stopped', step: i };
    if (out.error) return { outcome: 'lost', step: i, label };

    const moved = await waitForStep(host, ctx, service, i);
    if (moved === 'stopped') return { outcome: 'stopped', step: i };
    if (moved === 'timeout') return { outcome: 'timeout', step: i, label };
    i = Math.max(i + 1, moved);
  }
  return { outcome: 'done', step: n };
}
