/**
 * CDP bridge for ONE tab (spec D4, rule 1). Everything goes through
 * webContents.debugger (CDP inside our own process). No OS-level input, no
 * remote-debugging port, no puppeteer. The user's real cursor is never moved.
 */
import type { WebContents } from 'electron';
import type { PageEvent, PageSnapshot, Rect } from '../shared/page';
import {
  BINDING_NAME,
  ISOLATED_WORLD,
  SCROLL_Y_SCRIPT,
  elementInfoScript,
  findBySelectorScript,
  findByTextScript,
  focusSearchScript,
  scrollByScript,
  scrollIntoViewScript,
  searchValueScript,
  similarLabelsScript,
} from './pageHelpers';
import { LISTENER_SCRIPT } from './pageListener';
import { SNAPSHOT_SCRIPT } from './snapshotScript';

/** Electron isolated world id used for read-only page scripts. */
const READ_WORLD_ID = 1999;

export type ElementInfo =
  | { found: false }
  | { found: true; rect: Rect; inViewport: boolean; sensitive: boolean; isSearch: boolean };

export class CdpBridge {
  private attached = false;
  private readonly listeners = new Set<(event: PageEvent) => void>();

  constructor(private readonly wc: WebContents, private readonly log: (msg: string, data?: object) => void) {}

  async attach(): Promise<void> {
    if (this.attached) return;
    try {
      this.wc.debugger.attach('1.3');
    } catch (error) {
      this.log('cdp attach failed', { error: String(error) });
      return;
    }
    this.attached = true;
    this.wc.debugger.on('detach', (_e, reason) => {
      this.attached = false;
      this.log('cdp detached', { reason });
    });
    this.wc.debugger.on('message', (_e, method, params) => {
      if (method !== 'Runtime.bindingCalled' || params?.name !== BINDING_NAME) return;
      try {
        const event = JSON.parse(String(params.payload)) as PageEvent;
        for (const listener of this.listeners) listener(event);
      } catch {
        // Malformed payloads from the page are ignored.
      }
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    // Binding is visible only in our isolated world, so page JS cannot fake events.
    await this.send('Runtime.addBinding', { name: BINDING_NAME, executionContextName: ISOLATED_WORLD });
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: LISTENER_SCRIPT,
      worldName: ISOLATED_WORLD,
      runImmediately: true,
    });
  }

  /** Re-install into the current document (called after did-navigate, spec 15 risk table). */
  async ensureListener(): Promise<void> {
    if (!this.attached) return;
    try {
      const tree = (await this.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const world = (await this.send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: ISOLATED_WORLD,
        grantUniveralAccess: false,
      })) as { executionContextId: number };
      await this.send('Runtime.evaluate', { expression: LISTENER_SCRIPT, contextId: world.executionContextId });
    } catch (error) {
      this.log('listener re-install failed', { error: String(error) });
    }
  }

  onEvent(listener: (event: PageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async send(method: string, params?: object): Promise<unknown> {
    if (!this.attached) throw new Error('CDP is not attached to this tab');
    return this.wc.debugger.sendCommand(method, params);
  }

  private async readEval<T>(code: string): Promise<T> {
    return (await this.wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code }])) as T;
  }

  async snapshot(): Promise<PageSnapshot> {
    const snap = await this.readEval<PageSnapshot>(SNAPSHOT_SCRIPT);
    return snap;
  }

  async elementInfo(elementId: string): Promise<ElementInfo> {
    return this.readEval<ElementInfo>(elementInfoScript(elementId));
  }

  async click(x: number, y: number): Promise<void> {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left' as const };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 1 });
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: 0,
      deltaY: Math.round(deltaY),
    });
  }

  async findByText(query: string): Promise<{ id: string; name: string; score: number } | null> {
    return this.readEval<{ id: string; name: string; score: number } | null>(findByTextScript(query));
  }

  async similarLabels(query: string): Promise<string[]> {
    return (await this.readEval<string[]>(similarLabelsScript(query))) ?? [];
  }

  async findBySelector(css: string, expectedName = ''): Promise<{ id: string; name: string; score: number } | null> {
    return this.readEval<{ id: string; name: string; score: number } | null>(findBySelectorScript(css, expectedName));
  }

  async scrollIntoView(elementId: string): Promise<boolean> {
    return this.readEval<boolean>(scrollIntoViewScript(elementId));
  }

  async scrollY(): Promise<number> {
    return this.readEval<number>(SCROLL_Y_SCRIPT);
  }

  async scrollBy(deltaY: number): Promise<void> {
    await this.readEval(scrollByScript(deltaY));
  }

  async focusSearch(elementId: string): Promise<boolean> {
    return this.readEval<boolean>(focusSearchScript(elementId));
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async searchValue(elementId: string): Promise<string | null> {
    return this.readEval<string | null>(searchValueScript(elementId));
  }

  async pressEnter(): Promise<void> {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  detach(): void {
    if (this.attached) {
      try {
        this.wc.debugger.detach();
      } catch {
        // already gone
      }
    }
    this.attached = false;
    this.listeners.clear();
  }
}
