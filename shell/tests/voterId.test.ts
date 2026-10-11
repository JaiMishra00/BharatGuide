/**
 * "Click on voter ID" on a voters.eci.gov.in-like page. The ghost may click
 * voter-ID NAVIGATION links when the user asks, but never clicks or types in
 * the Voter ID / EPIC number field (rule 7, spec 6.7): it points and hands over.
 */
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/agent/executor';
import { classifyIntent } from '../src/agent/intent';
import { isSensitiveField } from '../src/bridge/sensitive';
import { makeCtx } from './fakes';
import { portal } from './voterPortal';

const halt = (): void => undefined;

describe('click on voter ID: tool guards', () => {
  it('"click on voter id" is guidance with click permission, never a typing grant', () => {
    expect(classifyIntent('click on voter id', ['findyt'])).toEqual({ kind: 'guidance', userAskedClick: true, userAskedScroll: false });
  });

  it('Voter ID / EPIC number inputs are detected as sensitive', () => {
    expect(isSensitiveField({ tag: 'input', label: 'EPIC Number / Voter ID' })).toBe(true);
    expect(isSensitiveField({ tag: 'input', name: 'epicNo' })).toBe(true);
    expect(isSensitiveField({ tag: 'input', placeholder: 'Enter Voter ID' })).toBe(true);
  });

  it('clicks "Download e-EPIC (Voter ID card)" when asked: telegraphed, at the element centre', async () => {
    const { host, browser, ghost } = portal();
    const out = await runTool('click', { element_id: 'e11' }, makeCtx('Guiding', { userAskedClick: true }), host, halt);
    expect(out.error).toBeUndefined();
    // page centre (410, 240) + page origin y=84 -> overlay (410, 324)
    expect(ghost.log.slice(0, 4)).toEqual(['move:410,324', 'pulse', 'hint:Clicking here', 'ripple']);
    expect(browser.actions).toEqual(['click:410,240']);
  });

  it('never clicks the EPIC / Voter ID input, even when the user asked to click', async () => {
    const { host, browser } = portal();
    const out = await runTool('click', { element_id: 'e13' }, makeCtx('Guiding', { userAskedClick: true }), host, halt);
    expect(out.error).toMatch(/sensitive/);
    expect(browser.actions).toEqual([]);
  });

  it('points at the EPIC field with a "do this yourself" hint instead', async () => {
    const { host, ghost, browser } = portal();
    const out = await runTool('point_at', { target_area: 'page', target_id: 'e13', hint: 'Your Voter ID goes here' }, makeCtx(), host, halt);
    expect(out.sensitive).toBe(true);
    expect(ghost.log).toContain('hint:Your Voter ID goes here (please do this yourself)');
    expect(browser.actions).toEqual([]);
  });

  it('without an explicit click request it only points', async () => {
    const { host, browser } = portal();
    const ctx = makeCtx('Guiding');
    expect((await runTool('click', { element_id: 'e11' }, ctx, host, halt)).error).toMatch(/only allowed when the user asked/);
    expect((await runTool('point_at', { target_area: 'page', target_id: 'e11', hint: 'Download your e-EPIC here' }, ctx, host, halt)).error).toBeUndefined();
    expect(browser.actions).toEqual([]);
  });

  it('an off-screen voter ID link is scrolled into view, then pointed at (never clicked)', async () => {
    const { host, ghost, browser } = portal();
    const ctx = makeCtx('Guiding');
    const out = await runTool('point_at', { target_area: 'page', target_id: 'e14', hint: 'Voter ID services' }, ctx, host, halt);
    expect(out).toMatchObject({ ok: true, pointed: 'e14', scrolled: 'down' });
    expect(ghost.log).toContain('hint:Scrolling down');
    expect(ghost.log).toContain('hint:Voter ID services'); // ghost lands on the element after the scroll
    expect(browser.actions).toEqual(['scroll_into_view:e14']); // no click, no typing
  });

  it('if the page will not scroll, the user is asked to scroll and nothing is clicked', async () => {
    const { host, ghost, browser } = portal();
    browser.canScroll = false;
    const ctx = makeCtx('Guiding', { userAskedClick: true });
    expect((await runTool('point_at', { target_area: 'page', target_id: 'e14', hint: 'Voter ID services' }, ctx, host, halt)).offscreen).toBe(true);
    expect(ghost.log).toContain('hint:Scroll down');
    expect((await runTool('click', { element_id: 'e14' }, ctx, host, halt)).error).toMatch(/off screen/);
    expect(browser.actions.some((a) => a.startsWith('click'))).toBe(false);
  });

  it('typing a voter ID number is refused', async () => {
    const { host, browser } = portal();
    expect((await runTool('type_in_search', { text: 'ABC1234567' }, makeCtx('RunningCommand'), host, halt)).error).toMatch(/no typing grant/);
    expect(browser.typed).toEqual([]);
  });
});
