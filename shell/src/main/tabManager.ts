/**
 * Tab manager (spec 6.4) + BrowserPort for the agent. One WebContentsView per
 * tab, in a separate session partition ('persist:browse'), no preload, no Node.
 * Only the active tab is attached. Coordinates returned to the agent are
 * overlay-local DIP (overlay bounds == main window content bounds).
 */
import { randomUUID } from 'node:crypto';
import { WebContentsView, type BaseWindow } from 'electron';
import { checkUrl } from '../agent/allowlist';
import type { BrowserPort, LoggerPort, Point, WaitEvent } from '../agent/types';
import { CdpBridge, type ElementInfo } from '../bridge/cdp';
import type { GhostRect, TabInfo, ToolbarState } from '../shared/ipc';
import type { PageEvent, PageSnapshot } from '../shared/page';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

export const MAX_TABS = 6;
export const PARTITION = 'persist:browse';

type Tab = { id: string; view: WebContentsView; bridge: CdpBridge; url: string; title: string; loading: boolean };
export type Layout = { page: { x: number; y: number; width: number; height: number } };

export class TabManager implements BrowserPort {
  private readonly tabs: Tab[] = [];
  private active: Tab | null = null;
  private toolbarRects = new Map<string, GhostRect>();
  private readonly pageListeners = new Set<(tabId: string, event: PageEvent) => void>();

  constructor(
    private readonly win: BaseWindow,
    private readonly layout: () => Layout,
    private readonly allowedHosts: () => { hosts: string[]; sourceHosts: Iterable<string> },
    private readonly onState: (state: ToolbarState) => void,
    private readonly onFx: (url: string, ms: number) => void,
    private readonly logger: LoggerPort,
  ) {}

  onPageEvent(listener: (tabId: string, event: PageEvent) => void): () => void {
    this.pageListeners.add(listener);
    return () => this.pageListeners.delete(listener);
  }

  setToolbarRects(rects: GhostRect[], toolbarOrigin: Point): void {
    this.toolbarRects = new Map(rects.map((r) => [r.id, { ...r, x: r.x + toolbarOrigin.x, y: r.y + toolbarOrigin.y }]));
  }

  async openTab(url: string): Promise<string> {
    if (this.tabs.length >= MAX_TABS) throw new Error(`at most ${MAX_TABS} tabs`);
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    const wc = view.webContents;
    const bridge = new CdpBridge(wc, (m, d) => this.logger.info('cdp', m, d as Record<string, unknown>));
    const tab: Tab = { id: `t${randomUUID().slice(0, 6)}`, view, bridge, url, title: 'New tab', loading: true };
    this.tabs.push(tab);

    // window.open / target=_blank -> new tab only if allowlisted (spec 6.4).
    wc.setWindowOpenHandler(({ url: target }) => {
      const allow = this.allowedHosts();
      const check = checkUrl(target, allow.hosts, allow.sourceHosts);
      if (check.ok && this.tabs.length < MAX_TABS) void this.openTab(check.url);
      else this.logger.warn('tabs', 'window.open denied', { reason: check.ok ? 'tab limit' : check.reason });
      return { action: 'deny' };
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.emitState();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emitState();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      tab.url = wc.getURL();
      this.emitState();
    });
    wc.on('did-navigate', (_e, navUrl) => {
      tab.url = navUrl;
      void bridge.ensureListener();
      this.emitState();
    });
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame) this.logger.warn('tabs', 'did-fail-load', { code, desc, url: failedUrl });
    });
    wc.on('did-navigate-in-page', (_e, navUrl) => {
      tab.url = navUrl;
      this.emitState();
    });
    bridge.onEvent((event) => {
      for (const listener of this.pageListeners) listener(tab.id, event);
    });
    this.switchTab(tab.id);
    // CDP commands on a never-navigated webContents can hang, so attach as soon
    // as the first navigation starts, and never block tab creation on it.
    wc.once('did-start-navigation', () => {
      void withTimeout(bridge.attach(), 5000).catch((error) => this.logger.warn('cdp', 'attach failed', { error: String(error) }));
    });
    await withTimeout(this.loadIn(tab, url), 20_000).catch(() => undefined);
    return tab.id;
  }

  private async loadIn(tab: Tab, url: string): Promise<void> {
    tab.url = url;
    this.emitState();
    try {
      this.logger.info('tabs', 'load', { url });
      await tab.view.webContents.loadURL(url);
      this.logger.info('tabs', 'loaded', { url: tab.view.webContents.getURL(), bounds: tab.view.getBounds() });
    } catch (error) {
      // ERR_ABORTED happens on redirects; the page still loads.
      this.logger.warn('tabs', 'load error', { error: String(error) });
    }
  }

  switchTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (this.active && this.active !== tab) this.win.contentView.removeChildView(this.active.view);
    this.active = tab;
    this.win.contentView.addChildView(tab.view);
    this.applyLayout();
    this.emitState();
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    if (this.active === tab) {
      this.win.contentView.removeChildView(tab.view);
      this.active = null;
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) this.switchTab(next.id);
    }
    tab.bridge.detach();
    tab.view.webContents.close();
    this.emitState();
  }

  async navigate(url: string): Promise<void> {
    if (!this.active) {
      await this.openTab(url);
      return;
    }
    await this.loadIn(this.active, url);
  }

  back(): void {
    this.active?.view.webContents.navigationHistory.goBack();
  }
  forward(): void {
    this.active?.view.webContents.navigationHistory.goForward();
  }
  reload(): void {
    this.active?.view.webContents.reload();
  }
  applyLayout(): void {
    if (this.active) this.active.view.setBounds(this.layout().page);
  }
  focusPage(): void {
    this.active?.view.webContents.focus();
  }
  emitState(): void {
    const wc = this.active?.view.webContents;
    this.onState({
      tabs: this.listTabs(),
      activeId: this.active?.id ?? null,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    });
  }

  // ---- BrowserPort (agent side) -------------------------------------------

  listTabs(): TabInfo[] {
    return this.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, loading: t.loading }));
  }
  activeTabId(): string | null {
    return this.active?.id ?? null;
  }
  maxTabs(): number {
    return MAX_TABS;
  }
  animateUrl(url: string, ms: number): void {
    this.onFx(url, ms);
  }
  pageOrigin(): Point {
    const p = this.layout().page;
    return { x: p.x, y: p.y };
  }
  pageSize(): { width: number; height: number } {
    const p = this.layout().page;
    return { width: p.width, height: p.height };
  }
  toolbarRect(ghostId: string): GhostRect | null {
    return this.toolbarRects.get(ghostId) ?? null;
  }

  private async waitLoaded(tab: Tab, timeoutMs = 10_000): Promise<void> {
    const wc = tab.view.webContents;
    if (!wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', done);
        resolve();
      }
      wc.once('did-stop-loading', done);
    });
  }

  async snapshot(): Promise<PageSnapshot | null> {
    const tab = this.active;
    if (!tab) return null;
    await this.waitLoaded(tab);
    try {
      return await tab.bridge.snapshot();
    } catch (error) {
      this.logger.warn('tabs', 'snapshot failed', { error: String(error) });
      return null;
    }
  }

  async elementInfo(elementId: string): Promise<ElementInfo> {
    if (!this.active) return { found: false };
    try {
      return await this.active.bridge.elementInfo(elementId);
    } catch {
      return { found: false };
    }
  }

  private bridge(): CdpBridge {
    if (!this.active) throw new Error('no active tab');
    return this.active.bridge;
  }

  click(pageX: number, pageY: number): Promise<void> {
    return this.bridge().click(pageX, pageY);
  }
  /**
   * Scroll by deltaY: real wheel input first; if the page did not move (wheel
   * landed on a non-scrollable spot, or the page scrolls an inner container),
   * fall back to scrolling the document/container directly.
   */
  async wheel(pageX: number, pageY: number, deltaY: number): Promise<void> {
    const bridge = this.bridge();
    const before = await bridge.scrollY().catch(() => null);
    await bridge.wheel(pageX, pageY, deltaY);
    await new Promise((r) => setTimeout(r, 250));
    const after = await bridge.scrollY().catch(() => null);
    if (before !== null && after !== null && Math.abs(after - before) < 5) {
      this.logger.info('tabs', 'wheel did not scroll; using scrollBy fallback', { before, deltaY });
      await bridge.scrollBy(deltaY).catch(() => undefined);
    }
  }
  async findByText(query: string): Promise<{ id: string; name: string; score: number } | null> {
    if (!this.active) return null;
    try {
      return await this.active.bridge.findByText(query);
    } catch (error) {
      this.logger.warn('tabs', 'findByText failed', { error: String(error) });
      return null;
    }
  }
  async similarLabels(query: string): Promise<string[]> {
    if (!this.active) return [];
    try {
      return await this.active.bridge.similarLabels(query);
    } catch {
      return [];
    }
  }
  async findBySelector(css: string, expectedName?: string): Promise<{ id: string; name: string; score: number } | null> {
    if (!this.active) return null;
    try {
      return await this.active.bridge.findBySelector(css, expectedName ?? '');
    } catch (error) {
      this.logger.warn('tabs', 'findBySelector failed', { error: String(error) });
      return null;
    }
  }
  async scrollIntoView(elementId: string): Promise<boolean> {
    if (!this.active) return false;
    try {
      return await this.active.bridge.scrollIntoView(elementId);
    } catch {
      return false;
    }
  }
  focusSearch(elementId: string): Promise<boolean> {
    return this.bridge().focusSearch(elementId);
  }
  insertText(text: string): Promise<void> {
    return this.bridge().insertText(text);
  }
  searchValue(elementId: string): Promise<string | null> {
    return this.bridge().searchValue(elementId);
  }
  pressEnter(): Promise<void> {
    return this.bridge().pressEnter();
  }

  waitForEvent(event: WaitEvent, timeoutMs: number, signal: AbortSignal): Promise<PageEvent | null> {
    return new Promise((resolve) => {
      let off: () => void = () => undefined;
      const finish = (value: PageEvent | null): void => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal.addEventListener('abort', onAbort);
      off = this.onPageEvent((tabId, e) => {
        if (tabId !== this.active?.id || e.type === 'escape') return;
        if (event === 'any' || e.type === event) finish(e);
        else if (event === 'input' && e.type === 'click' && e.isSearch) return;
      });
    });
  }

  destroy(): void {
    for (const tab of this.tabs) {
      tab.bridge.detach();
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.length = 0;
    this.active = null;
  }
}
