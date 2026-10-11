/** "guide me to <service>": catalog routes (parivahan.UP.json) walked with the ghost cursor. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/agent/core';
import { locateTarget } from '../src/agent/intent';
import { matchService, parseCatalog, routeHosts, samePage, siteRequest } from '../src/agent/routes';
import { stepAfterUrl } from '../src/agent/routeGuide';
import { searchPhrasesFrom } from '../src/main/config';
import type { SnapElement } from '../src/shared/page';
import { assistantText, makeHost, snapshot } from './fakes';

const HOME_URL = 'https://parivahan.gov.in/parivahan/';
const STATE_URL = 'https://sarathi.parivahan.gov.in/sarathiservice/stateSelection.do';
const LL_URL = 'https://sarathi.parivahan.gov.in/sarathiservice/newLLDet.do';

const el = (id: string, role: string, name: string, y: number): SnapElement => ({
  id, role, name, rect: { x: 300, y, width: 220, height: 40 }, inViewport: true, sensitive: false, isSearch: false, order: 1,
});
const ONLINE = el('p1', 'link', 'Online Services', 100);
const DLRS = el('p2', 'link', 'Driving License Related Services', 160);
const STATE = el('p3', 'combobox', '', 200);
const APPLY_LL = el('p4', 'link', 'Apply for Learner Licence', 260);

const step = (action: string, extra: Record<string, unknown>) => ({ action, hint: '', ...extra });
const service = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, portal: 'Sarathi', category: 'Home', url: LL_URL, status: 'unverified', gates: [], aliases: [],
  route: [
    step('open', { url: HOME_URL }),
    step('hover', { target: { css: '#Online', name: 'Online Services', role: 'link' } }),
    step('click', { target: { css: '#dlrs', name: 'Driving License Related Services', role: 'link' }, url: STATE_URL }),
    step('select', { target: { css: '#stfNameId', name: '', role: 'combobox' }, option: { text: 'Uttar Pradesh', value: 'UP' } }),
    step('click', { target: { css: '#ll', name: 'Apply for Learner Licence', role: 'link' }, url: LL_URL }),
  ],
  ...extra,
});

const CATALOG = {
  site: 'parivahan',
  state: { name: 'Uttar Pradesh', code: 'UP' },
  services: [
    service('sarathi.apply-for-learner-licence', 'Apply for Learner Licence'),
    service('sarathi.change-of-address-in-dl', 'CHANGE OF ADDRESS IN DL', { status: 'gate', gates: ['login'] }),
    service('sarathi.change-of-address-in-cl', 'CHANGE OF ADDRESS IN CL', { status: 'gate', gates: ['login'] }),
    service('bad.http', 'Insecure Service', { url: 'http://parivahan.gov.in/x' }),
  ],
};
const ROUTES = parseCatalog(CATALOG).services;

/** A fake Parivahan site: the agent's navigate loads pages; each wait = the user doing the pointed step. */
function parivahanSite(startUrl = 'https://voters.eci.gov.in/') {
  const made = makeHost();
  const { browser, host } = made;
  host.config.allowedHosts = [...host.config.allowedHosts, ...routeHosts(ROUTES)];
  browser.selectors = new Map([['#Online', 'p1'], ['#dlrs', 'p2'], ['#stfNameId', 'p3'], ['#ll', 'p4']]);
  const load = (url: string, elements: SnapElement[]) => {
    browser.tabs[0].url = url;
    browser.snap = { ...snapshot(elements), url };
  };
  load(startUrl, startUrl === STATE_URL ? [STATE] : snapshot().elements);
  browser.onNavigate = (url) => load(url, [ONLINE]);
  let userActs = true;
  browser.onWait = () => {
    if (!userActs) return;
    const url = browser.tabs[0].url;
    const ids = (browser.snap?.elements ?? []).map((e) => e.id);
    if (url === HOME_URL && !ids.includes('p2')) load(HOME_URL, [ONLINE, DLRS]); // hovered: menu opens
    else if (url === HOME_URL) load(STATE_URL, [STATE]); // clicked DL services
    else if (url === STATE_URL && !ids.includes('p4')) load(STATE_URL, [STATE, APPLY_LL]); // chose the state
    else if (url === STATE_URL) load(LL_URL, []); // clicked Apply for Learner Licence
  };
  return { ...made, stopActing: () => (userActs = false) };
}

const noPlanner = (flag: { ran: boolean }) => () => ({ name: 'x', async run() { flag.ran = true; }, cancel() {} });

describe('route catalog', () => {
  it('parses services, skips invalid ones and lists their hosts', () => {
    expect(ROUTES.map((s) => s.id)).toEqual([
      'sarathi.apply-for-learner-licence', 'sarathi.change-of-address-in-dl', 'sarathi.change-of-address-in-cl',
    ]);
    expect(parseCatalog(CATALOG).skipped).toBe(1);
    expect(routeHosts(ROUTES).sort()).toEqual(['parivahan.gov.in', 'sarathi.parivahan.gov.in']);
  });

  it('matches by words, spelling and abbreviations; ties are ambiguous; generic words never match', () => {
    expect(matchService(ROUTES, 'apply for learner license')).toMatchObject({ kind: 'match', service: { id: 'sarathi.apply-for-learner-licence' } });
    expect(matchService(ROUTES, 'learner licence')).toMatchObject({ kind: 'match' });
    expect(matchService(ROUTES, 'change of address in driving licence')).toMatchObject({ kind: 'match', service: { id: 'sarathi.change-of-address-in-dl' } });
    expect(matchService(ROUTES, 'change of address')).toMatchObject({ kind: 'ambiguous' });
    expect(matchService(ROUTES, 'login')).toBeNull();
    expect(matchService(ROUTES, 'submit appeal')).toBeNull();
  });

  it('knows where the user is on a route', () => {
    const s = ROUTES[0];
    expect(stepAfterUrl(s, -1, 'https://voters.eci.gov.in/')).toBe(-1);
    expect(stepAfterUrl(s, -1, STATE_URL)).toBe(3);
    expect(stepAfterUrl(s, -1, LL_URL)).toBe(5);
    expect(samePage(`${STATE_URL}/`, STATE_URL)).toBe(true);
    expect(samePage('https://x.gov.in/a.do?q=1', 'https://x.gov.in/a.do?q=2')).toBe(false);
  });

  it('old .env search phrases ("search for,find") are reduced to findyt', () => {
    expect(searchPhrasesFrom('search for,find')).toEqual(['findyt']);
    expect(searchPhrasesFrom(undefined)).toEqual(['findyt']);
    expect(searchPhrasesFrom('findyt,yt')).toEqual(['findyt', 'yt']);
  });
});

describe('"guide me to <service>" follows the route with the ghost cursor', () => {
  it('opens the start page, points at every step, waits for the user, never clicks or types', async () => {
    const { host, browser, ghost, events } = parivahanSite();
    const flag = { ran: false };
    const agent = new AgentCore(host, noPlanner(flag), ['findyt'], ROUTES);
    await agent.handleUserMessage('guide me to apply for learner license');
    expect(flag.ran).toBe(false);
    expect(browser.actions).toEqual([`animate:${HOME_URL}`, `navigate:${HOME_URL}`]); // the only action the agent took
    expect(browser.typed).toEqual([]);
    const hints = ghost.log.filter((l) => l.startsWith('hint:Step'));
    expect(hints).toEqual([
      'hint:Step 2/5: move your mouse over Online Services to open its menu',
      'hint:Step 3/5: click Driving License Related Services',
      'hint:Step 4/5: choose Uttar Pradesh in this list',
      'hint:Step 5/5: click Apply for Learner Licence',
    ]);
    expect(browser.waits.length).toBeGreaterThanOrEqual(4);
    expect(assistantText(events)).toContain("You're on the **Apply for Learner Licence** page now.");
    expect(agent.state).toBe('Idle');
  });

  it('"find <service>" is the same ghost guidance (no YouTube search, no typing grant)', async () => {
    const { host, browser, ghost } = parivahanSite();
    const agent = new AgentCore(host, noPlanner({ ran: false }), ['findyt'], ROUTES);
    await agent.handleUserMessage('find apply for learner licence');
    expect(browser.typed).toEqual([]);
    expect(agent.grants.current).toBeNull();
    expect(ghost.log).toContain('hint:Step 5/5: click Apply for Learner Licence');
  });

  it('starts part-way when the user is already on the route', async () => {
    const { host, browser, ghost, events } = parivahanSite(STATE_URL);
    const agent = new AgentCore(host, noPlanner({ ran: false }), ['findyt'], ROUTES);
    await agent.handleUserMessage('guide me to apply for learner licence');
    expect(browser.actions.some((a) => a.startsWith('navigate'))).toBe(false);
    expect(ghost.log.filter((l) => l.startsWith('hint:Step'))).toEqual([
      'hint:Step 4/5: choose Uttar Pradesh in this list',
      'hint:Step 5/5: click Apply for Learner Licence',
    ]);
    expect(assistantText(events)).toContain('we start at step 4 of 5');
  });

  it('pauses with a message when the user does not act in time', async () => {
    const site = parivahanSite();
    site.stopActing();
    let clock = 0;
    site.host.now = () => (clock += 30_000);
    const agent = new AgentCore(site.host, noPlanner({ ran: false }), ['findyt'], ROUTES);
    await agent.handleUserMessage('guide me to apply for learner licence');
    expect(assistantText(site.events)).toContain('I paused at step 2 of 5');
    expect(site.browser.actions.some((a) => a.startsWith('click'))).toBe(false);
  });

  it('a gated service warns that login/captcha is for the user', async () => {
    const { host, events } = parivahanSite();
    const agent = new AgentCore(host, noPlanner({ ran: false }), ['findyt'], ROUTES);
    await agent.handleUserMessage('guide me to change of address in DL');
    expect(assistantText(events)).toContain('This service will ask you to log in. Please do that yourself');
  });

  it('several matching services: lists them instead of guessing', async () => {
    const { host, browser, events } = parivahanSite();
    const agent = new AgentCore(host, noPlanner({ ran: false }), ['findyt'], ROUTES);
    await agent.handleUserMessage('guide me to change of address');
    expect(assistantText(events)).toContain('Several services match');
    expect(assistantText(events)).toContain('CHANGE OF ADDRESS IN DL');
    expect(browser.actions).toEqual([]);
  });

  it('a request that is not in the catalog still goes to the page/planner path', async () => {
    const { host } = parivahanSite();
    const flag = { ran: false };
    await new AgentCore(host, noPlanner(flag), ['findyt'], ROUTES).handleUserMessage('guide me to the submit appeal option');
    expect(flag.ran).toBe(true);
  });
});

describe('naming the Parivahan site itself (real chat: "navigate me through parivahan website")', () => {
  it('recognises site requests, but not service requests', () => {
    expect(siteRequest('parivahan')).toEqual({ portal: null });
    expect(siteRequest('parivahan website')).toEqual({ portal: null });
    expect(siteRequest('sarathi portal')).toEqual({ portal: 'Sarathi' });
    expect(siteRequest('learner licence on parivahan')).toBeNull();
    expect(siteRequest('voter portal')).toBeNull();
    expect(locateTarget('navigate me through parivahan website')).toBe('parivahan');
    expect(locateTarget('take me to the parivahan site')).toBe('parivahan');
  });

  it('opens parivahan.gov.in and points at its services menu, without the model', async () => {
    const { host, browser, ghost, events } = parivahanSite();
    const flag = { ran: false };
    const agent = new AgentCore(host, noPlanner(flag), ['findyt'], ROUTES);
    await agent.handleUserMessage('navigate me through parivahan website');
    expect(flag.ran).toBe(false);
    expect(browser.actions).toEqual([`animate:${HOME_URL}`, `navigate:${HOME_URL}`]);
    expect(ghost.log).toContain('hint:Move your mouse over Online Services to see all services');
    expect(assistantText(events)).toContain('guide me to Apply for Learner Licence');
    expect(assistantText(events)).not.toMatch(/outside my scope/i);
    expect(agent.state).toBe('Idle');
  });

  it('a whole question about a service is guided by its route', async () => {
    const { host, ghost } = parivahanSite();
    const flag = { ran: false };
    await new AgentCore(host, noPlanner(flag), ['findyt'], ROUTES).handleUserMessage('how do I apply for a learner licence on parivahan?');
    expect(flag.ran).toBe(false);
    expect(ghost.log).toContain('hint:Step 5/5: click Apply for Learner Licence');
  });

  it('a question that matches no route still goes to the model', async () => {
    const { host } = parivahanSite();
    const flag = { ran: false };
    await new AgentCore(host, noPlanner(flag), ['findyt'], ROUTES).handleUserMessage('what documents do I need for a driving licence?');
    expect(flag.ran).toBe(true);
  });
});

describe('the real parivahan.UP.json', () => {
  const real = parseCatalog(JSON.parse(readFileSync(resolve(__dirname, '../../parivahan.UP.json'), 'utf8')));

  it('loads every service with only official https hosts', () => {
    expect(real.services.length).toBeGreaterThan(90);
    expect(real.skipped).toBe(0);
    expect(routeHosts(real.services).every((h) => h === 'parivahan.gov.in' || h.endsWith('.parivahan.gov.in'))).toBe(true);
  });

  it('finds common services by plain requests', () => {
    expect(matchService(real.services, 'apply for learner license')).toMatchObject({ kind: 'match', service: { id: 'sarathi.apply-for-learner-licence' } });
    expect(matchService(real.services, 'DL renewal')).toMatchObject({ kind: 'match', service: { id: 'sarathi.renewal-of-dl' } });
    expect(matchService(real.services, 'apply for DL renewal')).toMatchObject({ kind: 'match', service: { id: 'sarathi.apply-for-dl-renewal' } });
    expect(matchService(real.services, 'vehicle recall')).toMatchObject({ kind: 'match', service: { id: 'vahan.vehicle-recall' } });
    expect(matchService(real.services, 'change of address in DL')).toMatchObject({ kind: 'match', service: { id: 'sarathi.change-of-address-in-dl' } });
    // Too broad: several services fit, so the user is asked which one.
    expect(matchService(real.services, 'driving licence')).toMatchObject({ kind: 'ambiguous' });
  });
});
