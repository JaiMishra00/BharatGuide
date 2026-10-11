/**
 * Electron main entry. Boot: config -> logger -> main window (toolbar, page,
 * chat views) -> ghost overlay window -> tab manager -> RAG client -> agent.
 * Renderers hold no secrets (rule 12); the service token stays here.
 */
import { Menu, app, globalShortcut, ipcMain, session, webContents, type BaseWindow } from 'electron';
import { join } from 'node:path';
import { AgentCore } from '../agent/core';
import { ClinePlanner, warmUpSdk } from '../agent/clinePlanner';
import { DemoPlanner } from '../agent/demoPlanner';
import { JUDGES_DEMO_MESSAGE, REGISTER_DEMO_MESSAGE, RegisterDemoPlanner } from '../agent/registerDemoPlanner';
import { FallbackPlanner } from '../agent/fallbackPlanner';
import type { Planner, PlannerDeps } from '../agent/planner';
import type { Host } from '../agent/types';
import { checkUrl } from '../agent/allowlist';
import { RagClient } from '../rag/client';
import { IPC, type ChatCommand, type ChatEvent, type GhostRect, type ToolbarCommand } from '../shared/ipc';
import { loadConfig, loadEnvFiles } from './config';
import { FileLogger } from './logger';
import { loadRouteCatalogs } from './routeCatalog';
import { routeHosts } from '../agent/routes';
import { OverlayWindow } from './overlayWindow';
import { PARTITION, TabManager } from './tabManager';
import { computeLayout, createLocalView, createMainWindow } from './views';
import { ChatWindow } from './chatWindow';

// The ghost overlay is a transparent, never-focused, always-on-top window.
// Windows occlusion tracking / background throttling can freeze its renderer,
// which stops the heartbeat and the animation, so turn those off.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

loadEnvFiles(app.getAppPath());
const config = loadConfig();
let agent: AgentCore | null = null;
/** Main window, for the single-instance "bring to front". */
let mainWindowRef: BaseWindow | null = null;
/**
 * Next run uses a scripted planner: "tour" = ghost showcase ("/demo", --demo),
 * "register" = real task, new voter registration ("/demo-register", --demo=register).
 */
let demoRequested: 'tour' | 'register' | 'judges' | null = null;
/** Judges run (`--demo=judges`): starts on Google, scripted first query, then live mode. */
const JUDGES_START_URL = 'https://www.google.com/';
const judgesRun = process.argv.includes('--demo=judges');
// Contains "click" and "scroll" so the user-asked permissions apply to the demo.
const DEMO_MESSAGE = 'Ghost demo: point, navigate, scroll, open a tab, click and switch back';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function boot(): Promise<void> {
  const logger = new FileLogger(join(app.getPath('userData'), 'logs'), config.debugLog);
  logger.info('system', 'boot', { planner: config.plannerImpl, model: config.plannerModel, rag: config.ragUrl });

  // Route catalogs ("guide me to <service>"): their official hosts join the allowlist.
  const routes = loadRouteCatalogs(config.routeCatalogs, app.getAppPath(), logger);
  config.allowedHosts = [...new Set([...config.allowedHosts, ...routeHosts(routes)])];

  // Remote pages: own partition, no permissions by default.
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  Menu.setApplicationMenu(null);
  const win = createMainWindow();
  mainWindowRef = win;
  const toolbarView = createLocalView('toolbar');
  win.contentView.addChildView(toolbarView);
  const chatWindow = new ChatWindow(win);
  const chatView = { webContents: chatWindow.win.webContents };

  const layout = () => {
    const b = win.getContentBounds();
    return computeLayout(b.width, b.height);
  };

  const sendChat = (event: ChatEvent): void => {
    if (!chatView.webContents.isDestroyed()) chatView.webContents.send(IPC.chatEvent, event);
  };

  const tabs = new TabManager(
    win,
    layout,
    () => ({ hosts: config.allowedHosts, sourceHosts: agent?.currentTask?.sourceHosts ?? [] }),
    (state) => !toolbarView.webContents.isDestroyed() && toolbarView.webContents.send(IPC.toolbarState, state),
    (url, ms) => !toolbarView.webContents.isDestroyed() && toolbarView.webContents.send(IPC.toolbarFx, { t: 'animate_url', url, ms }),
    logger,
  );

  const applyLayout = (): void => {
    const l = layout();
    logger.info('layout', 'apply', { content: win.getContentBounds(), ...l });
    toolbarView.setBounds(l.toolbar);
    tabs.applyLayout();
    chatWindow.sync();
  };
  applyLayout();
  win.on('resize', applyLayout);
  win.on('maximize', applyLayout);
  win.on('unmaximize', applyLayout);
  win.on('restore', applyLayout);

  const overlay = new OverlayWindow(win, logger, () => {
    sendChat({ t: 'state', state: 'Halted' });
    agent?.handleOverlayLost();
  });
  overlay.start();

  const rag = new RagClient(config.ragUrl, config.serviceToken);
  const host: Host = {
    browser: tabs,
    ghost: overlay,
    chat: { emit: sendChat },
    rag,
    logger,
    config: { allowedHosts: config.allowedHosts, helplineFallback: config.helplineFallback },
    sleep,
    now: () => Date.now(),
  };

  const makePlanner = (deps: PlannerDeps): Planner => {
    const demo = demoRequested;
    demoRequested = null; // one-shot
    if (demo === 'tour') return new DemoPlanner(deps, tabs, logger);
    if (demo === 'register') return new RegisterDemoPlanner(deps, tabs, logger);
    if (demo === 'judges') return new RegisterDemoPlanner(deps, tabs, logger, 'judges');
    return config.plannerImpl === 'fallback'
      ? new FallbackPlanner(
          { baseUrl: config.plannerUrl, modelId: config.plannerModel, apiKey: config.plannerApiKey, reasoningEffort: config.plannerReasoning || undefined },
          deps,
          logger,
        )
      : new ClinePlanner(
          {
            providerId: config.plannerProviderId,
            modelId: config.plannerModel,
            baseUrl: config.plannerUrl,
            apiKey: config.plannerApiKey,
            reasoningEffort: config.plannerReasoning || undefined,
          },
          deps,
          logger,
        );
  };
  agent = new AgentCore(host, makePlanner, config.searchCommandPhrases, routes);

  wireIpc({ chatView, chatWindow, toolbarView, tabs, layout, logger, sendChat });
  tabs.onPageEvent((_id, event) => {
    if (event.type === 'escape') agent?.handleEsc();
  });

  // Hotkey toggles the Guide panel: hide it completely, press again to show it.
  globalShortcut.register(config.hotkey.replace('Ctrl', 'CommandOrControl'), () => {
    const visible = chatWindow.toggleVisible();
    logger.info('chat', visible ? 'panel shown (hotkey)' : 'panel hidden (hotkey)');
    if (visible) chatView.webContents.send(IPC.chatFocusInput);
  });

  void pollHealth(rag, sendChat);
  if (config.plannerImpl === 'cline') {
    if (config.planner === 'hosted' && !config.plannerApiKey) {
      logger.warn('planner', 'PLANNER=hosted but no PLANNER_API_KEY / CLINE_API_KEY is set; answers will fail');
    }
    void warmUpSdk(
      {
        providerId: config.plannerProviderId,
        modelId: config.plannerModel,
        baseUrl: config.plannerUrl,
        apiKey: config.plannerApiKey,
        reasoningEffort: config.plannerReasoning || undefined,
      },
      logger,
    );
  }
  await tabs.openTab(judgesRun ? JUDGES_START_URL : config.startUrl).catch((error) => logger.warn('tabs', 'start url failed', { error: String(error) }));

  // Diagnostic hook: `--dump-labels` logs every clickable label on the start page.
  if (process.argv.includes('--dump-labels')) {
    setTimeout(() => {
      void tabs
        .snapshot()
        .then(async () => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(config.startUrl.replace(/\/$/, '')));
          const labels = (await wc?.executeJavaScript(
            `Array.from(document.querySelectorAll('a,button,[role=button],[role=link],h1,h2,h3,h4')).map(e => (e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim()).filter(t => t && t.length < 90)`,
          )) as string[] | undefined;
          logger.info('diag', 'labels', { count: labels?.length ?? 0, labels: [...new Set(labels ?? [])].slice(0, 250) });
        })
        .catch((error) => logger.warn('diag', 'labels failed', { error: String(error) }));
    }, Number(process.env.DEMO_DELAY_MS ?? 9000));
  }

  // Test hook: `--ask="guide me to ..."` sends one chat message after load (live model runs).
  const ask = process.argv.find((a) => a.startsWith('--ask='))?.slice('--ask='.length);
  if (ask) {
    setTimeout(() => void agent?.handleUserMessage(ask.slice(0, 500)), Number(process.env.DEMO_DELAY_MS ?? 9000));
  }

  const demoArg = process.argv.includes('--demo')
    ? 'tour'
    : process.argv.includes('--demo=register')
      ? 'register'
      : judgesRun
        ? 'judges'
        : null;
  if (demoArg) {
    const message = { tour: DEMO_MESSAGE, register: REGISTER_DEMO_MESSAGE, judges: JUDGES_DEMO_MESSAGE }[demoArg];
    setTimeout(() => {
      demoRequested = demoArg;
      void agent?.handleUserMessage(message);
    }, Number(process.env.DEMO_DELAY_MS ?? 9000));
  }

  win.on('closed', () => {
    void agent?.shutdown();
    chatWindow.destroy();
    overlay.destroy();
    tabs.destroy();
    app.quit();
  });
}
type WireDeps = {
  chatView: { webContents: Electron.WebContents };
  chatWindow: ChatWindow;
  toolbarView: Electron.WebContentsView;
  tabs: TabManager;
  layout: () => ReturnType<typeof computeLayout>;
  logger: FileLogger;
  sendChat: (event: ChatEvent) => void;
};

function fromView(view: { webContents: Electron.WebContents }) {
  return (event: Electron.IpcMainEvent): boolean => event.sender.id === view.webContents.id;
}

/** IPC: each renderer may only use its own channels (spec 7.3). */
function wireIpc({ chatView, chatWindow, toolbarView, tabs, layout, logger, sendChat }: WireDeps): void {
  const isChat = fromView(chatView);
  const isToolbar = fromView(toolbarView);

  ipcMain.on(IPC.chatCommand, (event, command: ChatCommand) => {
    if (!isChat(event) || !command || typeof command !== 'object') return;
    if (command.t === 'send' && typeof command.text === 'string') {
      let text = command.text.slice(0, 2000);
      const slash = text.trim().toLowerCase();
      if (slash === '/demo') {
        demoRequested = 'tour';
        text = DEMO_MESSAGE;
      } else if (slash === '/demo-register') {
        demoRequested = 'register';
        text = REGISTER_DEMO_MESSAGE;
      } else if (slash === '/demo-judges') {
        demoRequested = 'judges';
        text = JUDGES_DEMO_MESSAGE;
      }
      tabs.focusPage(); // focus returns to the page after send (spec 7.1)
      void agent?.handleUserMessage(text).catch((error) => logger.error('agent', 'message failed', { error: String(error) }));
    } else if (command.t === 'kill') {
      agent?.kill();
    } else if (command.t === 'esc') {
      agent?.handleEsc();
    } else if (command.t === 'collapse') {
      chatWindow.setCollapsed(Boolean(command.collapsed));
    } else if (command.t === 'open_source' && typeof command.url === 'string') {
      // Source links open as a new tab, through the allowlist (spec 7.1).
      const check = checkUrl(command.url, config.allowedHosts, agent?.currentTask?.sourceHosts ?? sourceHostsFrom(command.url));
      if (check.ok) void tabs.openTab(check.url).catch(() => undefined);
      else sendChat({ t: 'card', kind: 'service_down', body: `That link is not on the allowlist: ${check.reason}` });
    }
  });

  ipcMain.on(IPC.toolbarCommand, (event, command: ToolbarCommand) => {
    if (!isToolbar(event) || !command || typeof command !== 'object') return;
    switch (command.t) {
      case 'switch':
        tabs.switchTab(command.id);
        break;
      case 'close':
        tabs.closeTab(command.id);
        break;
      case 'new_tab':
        if (tabs.listTabs().length < tabs.maxTabs()) void tabs.openTab('https://www.google.com/');
        break;
      case 'navigate':
        // The user's own typing in the address bar: they may go anywhere https/http.
        void tabs.navigate(normalizeTyped(command.url));
        break;
      case 'back':
        tabs.back();
        break;
      case 'forward':
        tabs.forward();
        break;
      case 'reload':
        tabs.reload();
        break;
      case 'esc':
        agent?.handleEsc();
        break;
    }
  });

  ipcMain.on(IPC.toolbarRects, (event, rects: GhostRect[]) => {
    if (!isToolbar(event) || !Array.isArray(rects)) return;
    const l = layout();
    tabs.setToolbarRects(
      rects.filter((r) => r && typeof r.id === 'string').slice(0, 40),
      { x: l.toolbar.x, y: l.toolbar.y },
    );
  });

  ipcMain.on(IPC.toolbarReady, (event) => {
    if (isToolbar(event)) tabs.emitState();
  });
  ipcMain.on(IPC.chatReady, (event) => {
    if (isChat(event)) sendChat({ t: 'state', state: agent?.state ?? 'Idle' });
  });
}

/** Source chips may point at a citation host that is not in ALLOWED_HOSTS. */
function sourceHostsFrom(url: string): string[] {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(eci|uidai)\.gov\.in$/.test(host) ? [host] : [];
  } catch {
    return [];
  }
}

function normalizeTyped(text: string): string {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

async function pollHealth(rag: RagClient, sendChat: (event: ChatEvent) => void): Promise<void> {
  let last = '';
  let lastVerified = '';
  for (;;) {
    const health = await rag.health();
    const status = !health ? 'down' : health.model_loaded ? 'ok' : 'warming_up';
    if (status !== last) {
      sendChat({ t: 'service', status });
      last = status;
    }
    if (health?.corpus_last_updated && health.corpus_last_updated !== lastVerified) lastVerified = health.corpus_last_updated;
    await sleep(status === 'ok' ? 15_000 : 3000);
  }
}

// One Guide at a time: a second launch (e.g. double-clicking the desktop
// shortcut again) brings the existing window to the front instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      console.error('startup failed', error);
      app.quit();
    });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
