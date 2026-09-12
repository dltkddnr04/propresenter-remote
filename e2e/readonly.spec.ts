import { expect } from '@playwright/test';
import { apiPath, apiUrl, attachJson, installConnectionSettings, isCoreApiUrl, productionUrl, readApiSnapshot, readUiSnapshot, waitForCoherentUi } from './helpers';
import { test } from './fixtures';

test('production controller and remote converge on the real ProPresenter state', async ({ page, context, request }, testInfo) => {
  const requests: Array<{ url: string; at: number }> = [];
  const responses: Array<{ url: string; status: number; at: number }> = [];
  const failures: Array<{ url: string; error: string | null }> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (entry) => { if (entry.url().startsWith(apiUrl)) requests.push({ url: entry.url(), at: Date.now() }); });
  page.on('response', (entry) => { if (entry.url().startsWith(apiUrl)) responses.push({ url: entry.url(), status: entry.status(), at: Date.now() }); });
  page.on('requestfailed', (entry) => { if (entry.url().startsWith(apiUrl)) failures.push({ url: entry.url(), error: entry.failure()?.errorText ?? null }); });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installConnectionSettings(page);

  try {
    await page.goto(productionUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.control-app')).toBeVisible();
    await expect(page.locator('.top-live-badge')).toContainText('연결됨', { timeout: 15_000 });
    await expect.poll(() => new Set(requests.map((entry) => apiPath(entry.url))).size >= 3, { timeout: 10_000 }).toBeTruthy();
    for (const path of ['/v1/presentation/slide_index', '/v1/playlist/active', '/v1/status/slide']) {
      expect(requests.some((entry) => apiPath(entry.url) === path), `${path} was not requested by the browser`).toBeTruthy();
    }

    const coherent = await waitForCoherentUi(page, request);
    const controller = coherent.ui.controller;
    expect(controller.connectionText).toContain('172.30.1.51:1025');
    expect(controller.connectionText).toContain('연결됨');
    expect(controller.presentationId).toBe(coherent.api.presentationId);
    expect(controller.slideIndex).toBe(coherent.api.slideIndex);
    if (coherent.api.slideIndex !== null && coherent.api.layers?.slide !== false) {
      expect(controller.activeCardIndex).toBe(coherent.api.slideIndex);
    }
    if (coherent.api.playlistId && coherent.api.playlistItemId) {
      expect(controller.title).toContain(coherent.api.playlistItemName ?? '');
      expect(await page.locator(`.slide-card.active[data-context-key*="${coherent.api.playlistId}:${coherent.api.playlistItemId}"]`).count()).toBeGreaterThan(0);
    }

    const remote = await context.newPage();
    const remoteRequests: Array<{ url: string; at: number }> = [];
    const remoteResponses: Array<{ url: string; status: number; at: number }> = [];
    const remoteFailures: Array<{ url: string; error: string | null }> = [];
    const remoteErrors: string[] = [];
    remote.on('request', (entry) => { if (entry.url().startsWith(apiUrl)) remoteRequests.push({ url: entry.url(), at: Date.now() }); });
    remote.on('response', (entry) => { if (entry.url().startsWith(apiUrl)) remoteResponses.push({ url: entry.url(), status: entry.status(), at: Date.now() }); });
    remote.on('requestfailed', (entry) => { if (entry.url().startsWith(apiUrl)) remoteFailures.push({ url: entry.url(), error: entry.failure()?.errorText ?? null }); });
    remote.on('console', (message) => { if (message.type() === 'error') remoteErrors.push(message.text()); });
    remote.on('pageerror', (error) => remoteErrors.push(error.message));
    await installConnectionSettings(remote);
    await remote.goto(`${productionUrl}/remote`, { waitUntil: 'domcontentloaded' });
    await expect(remote.locator('.remote-status')).toContainText('연결됨', { timeout: 15_000 });
    await expect.poll(() => new Set(remoteRequests.map((entry) => apiPath(entry.url))).size >= 3, { timeout: 10_000 }).toBeTruthy();
    await expect.poll(async () => (await readUiSnapshot(remote)).remote.presentationId === coherent.api.presentationId, { timeout: 12_000 }).toBeTruthy();
    const remoteUi = await readUiSnapshot(remote);
    expect(remoteUi.remote.presentationId).toBe(coherent.api.presentationId);
    expect(remoteUi.remote.slideIndex).toBe(coherent.api.slideIndex);
    if (coherent.api.currentText) expect(remoteUi.remote.currentText).toContain(coherent.api.currentText);
    expect(remoteUi.remote.connectionText).toContain('연결됨');

    await page.waitForTimeout(3_000);
    const coreResponses = responses.filter((entry) => isCoreApiUrl(entry.url));
    expect(coreResponses.filter((entry) => entry.status >= 400), 'core API returned an HTTP error').toEqual([]);
    expect(remoteResponses.filter((entry) => isCoreApiUrl(entry.url) && entry.status >= 400), 'remote core API returned an HTTP error').toEqual([]);
    expect(failures, 'browser requests to ProPresenter failed').toEqual([]);
    expect(remoteFailures, 'remote browser requests to ProPresenter failed').toEqual([]);
    expect(consoleErrors.filter((entry) => /Maximum update depth|Illegal invocation|uncaught|React/i.test(entry))).toEqual([]);
    expect(pageErrors.filter((entry) => /Maximum update depth|Illegal invocation|uncaught|React/i.test(entry))).toEqual([]);
    expect(requests.length).toBeLessThan(140);

    await attachJson(testInfo, 'runtime-comparison.json', {
      productionUrl, apiUrl, api: coherent.api, controller: coherent.ui.controller, remote: remoteUi.remote,
      controllerLatencyMs: coherent.latencyMs, requests, responses, failures, consoleErrors, pageErrors, remoteRequests, remoteResponses, remoteFailures, remoteErrors,
      observedAt: Date.now(),
    });
    expect(remoteErrors.filter((entry) => /Maximum update depth|Illegal invocation|uncaught|React/i.test(entry))).toEqual([]);
  } catch (error) {
    await attachJson(testInfo, 'failure-state.json', { error: error instanceof Error ? error.message : String(error), requests, responses, failures, consoleErrors, pageErrors, ui: await readUiSnapshot(page).catch(() => null), api: await readApiSnapshot(request).catch(() => null) });
    await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => undefined);
    throw error;
  }
});
