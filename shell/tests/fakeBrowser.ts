/** Fake BrowserPort + GhostPort for tests. No Electron. */
import type { ElementInfo } from '../src/bridge/cdp';
import type { GhostRect, TabInfo } from '../src/shared/ipc';
import type { PageEvent, PageSnapshot, SnapElement } from '../src/shared/page';
import type { BrowserPort, Point, WaitEvent } from '../src/agent/types';

const el = (id: string, role: string, name: string, y: number, extra: Partial<SnapElement> = {}): SnapElement => ({
  id, role, name, rect: { x: 100, y, width: 200, height: 40 }, inViewport: true, sensitive: false, isSearch: false, order: 1, ...extra,
});

export const SEARCH_BOX = el('e1', 'searchbox', 'Search', 20, { isSearch: true });
export const REGISTER_BTN = el('e2', 'button', 'Register as new elector', 200);
export const OTP_FIELD = el('e3', 'textbox', 'Enter OTP', 300, { sensitive: true });

export function snapshot(elements: SnapElement[] = [SEARCH_BOX, REGISTER_BTN, OTP_FIELD]): PageSnapshot {
  return {
    url: 'https://www.youtube.com/', title: 'Page', scrollY: 0, scrollHeight: 2000,
    viewport: { width: 1000, height: 700 }, elements, searchFieldId: elements.find((e) => e.isSearch)?.id ?? null,
  };
}

export class FakeBrowser implements BrowserPort {
  snap: PageSnapshot | null = snapshot();
  actions: string[] = [];
  typed: string[] = [];
  tabs: TabInfo[] = [{ id: 't1', title: 'Voter portal', url: 'https://voters.eci.gov.in/', loading: false }];
  active: string | null = 't1';
  nextEvent: PageEvent | null = { type: 'click', at: 0, elementId: 'e2' };

  async snapshot() { return this.snap; }
  async elementInfo(id: string): Promise<ElementInfo> {
    const e = this.snap?.elements.find((x) => x.id === id);
    return e ? { found: true, rect: e.rect, inViewport: e.inViewport, sensitive: e.sensitive, isSearch: e.isSearch } : { found: false };
  }
  pageOrigin(): Point { return { x: 0, y: 84 }; }
  pageSize() { return { width: 1000, height: 700 }; }
  toolbarRect(id: string): GhostRect | null {
    if (id === 'address_bar') return { id, x: 120, y: 44, width: 600, height: 32 };
    if (id.startsWith('tab:')) return { id, x: 10, y: 6, width: 180, height: 34 };
    return null;
  }
  listTabs() { return this.tabs; }
  activeTabId() { return this.active; }
  maxTabs() { return 6; }
  async openTab(url: string) {
    this.actions.push(`open_tab:${url}`);
    const id = `t${this.tabs.length + 1}`;
    this.tabs.push({ id, title: url, url, loading: false });
    this.active = id;
    return id;
  }
  switchTab(id: string) { this.actions.push(`switch:${id}`); this.active = id; }
  /** Test hooks: change the page when the agent navigates / when the user "acts". */
  onNavigate?: (url: string) => void;
  onWait?: (event: WaitEvent) => void;
  async navigate(url: string) { this.actions.push(`navigate:${url}`); this.onNavigate?.(url); }
  animateUrl(url: string) { this.actions.push(`animate:${url}`); }
  async click(x: number, y: number) { this.actions.push(`click:${x},${y}`); }
  async wheel(_x: number, _y: number, dy: number) { this.actions.push(`wheel:${dy}`); }
  /** Elements present on the page but NOT in the 60-element snapshot (found only by findByText). */
  hidden: SnapElement[] = [];
  async findByText(query: string) {
    const q = query.toLowerCase();
    const pool = [...(this.snap?.elements ?? []), ...this.hidden];
    const hit = pool.find((e) => q.split(/\s+/).filter((w) => w.length > 2).every((w) => e.name.toLowerCase().includes(w)));
    if (!hit) return null;
    if (this.snap && !this.snap.elements.includes(hit)) this.snap = { ...this.snap, elements: [...this.snap.elements, hit] };
    return { id: hit.id, name: hit.name, score: 80 };
  }
  async similarLabels(query: string) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    return [...(this.snap?.elements ?? []), ...this.hidden]
      .filter((e) => ['link', 'button'].includes(e.role) && words.some((w) => e.name.toLowerCase().includes(w)))
      .map((e) => e.name)
      .slice(0, 4);
  }
  /** false = simulate a page that refuses to scroll (element stays off screen). */
  canScroll = true;
  async scrollIntoView(id: string) {
    this.actions.push(`scroll_into_view:${id}`);
    const snap = this.snap;
    const e = snap?.elements.find((x) => x.id === id);
    if (!snap || !e || !this.canScroll) return Boolean(e);
    // Replace with a copy: element fixtures are shared module constants across tests.
    const moved = { ...e, rect: { ...e.rect, y: 300 }, inViewport: true };
    this.snap = { ...snap, elements: snap.elements.map((x) => (x.id === id ? moved : x)) };
    return true;
  }
  async focusSearch() { return true; }
  async insertText(text: string) { this.typed.push(text); }
  async searchValue() { return this.typed.at(-1) ?? ''; }
  async pressEnter() { this.actions.push('enter'); }
  /** Every waitForEvent call, in order (kept out of `actions`, which records page-changing actions). */
  waits: WaitEvent[] = [];
  async waitForEvent(event: WaitEvent) {
    this.waits.push(event);
    this.onWait?.(event);
    return this.nextEvent;
  }
  /** CSS selector -> element id, for catalog route targets. Only elements in the snapshot or `hidden` are "visible". */
  selectors = new Map<string, string>();
  async findBySelector(css: string, expectedName?: string) {
    const id = this.selectors.get(css);
    const pool = [...(this.snap?.elements ?? []), ...this.hidden];
    const hit = id ? pool.find((e) => e.id === id) : undefined;
    if (!hit) return null;
    if (expectedName && !hit.name.toLowerCase().includes(expectedName.toLowerCase())) return null;
    if (this.snap && !this.snap.elements.includes(hit)) this.snap = { ...this.snap, elements: [...this.snap.elements, hit] };
    return { id: hit.id, name: hit.name, score: 100 };
  }
}

export class FakeGhost {
  alive = true;
  log: string[] = [];
  move(x: number, y: number) { this.log.push(`move:${Math.round(x)},${Math.round(y)}`); }
  pulse() { this.log.push('pulse'); }
  ripple() { this.log.push('ripple'); }
  hint(text: string) { this.log.push(`hint:${text}`); }
  hide() { this.log.push('hide'); }
}
