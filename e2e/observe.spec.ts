import { expect } from '@playwright/test';
import { attachJson, installConnectionSettings, productionUrl, readApiSnapshot, readUiSnapshot } from './helpers';
import { test } from './fixtures';

test.skip(process.env.PP_E2E_OBSERVE_TRANSITIONS !== '1', 'Set PP_E2E_OBSERVE_TRANSITIONS=1 and operate ProPresenter during this test.');

test('observes a human-operated ProPresenter transition and measures UI convergence', async ({ page, context, request }, testInfo) => {
  const timeout = Number(process.env.PP_E2E_OBSERVE_TIMEOUT_MS ?? 30_000);
  await installConnectionSettings(page);
  await page.goto(productionUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.top-live-badge')).toContainText('연결됨', { timeout: 15_000 });
  const remote = await context.newPage();
  await installConnectionSettings(remote);
  await remote.goto(`${productionUrl}/remote`, { waitUntil: 'domcontentloaded' });
  await expect(remote.locator('.remote-status')).toContainText('연결됨', { timeout: 15_000 });
  const baseline = await readApiSnapshot(request);
  const startedAt = Date.now();
  let changed: Awaited<ReturnType<typeof readApiSnapshot>> | null = null;
  while (Date.now() - startedAt < timeout) {
    const current = await readApiSnapshot(request);
    if (current.presentationId !== baseline.presentationId || current.slideIndex !== baseline.slideIndex || current.playlistItemId !== baseline.playlistItemId || current.currentText !== baseline.currentText) { changed = current; break; }
    await page.waitForTimeout(250);
  }
  test.skip(!changed, 'No ProPresenter transition observed; operate the ProPresenter device and rerun this opt-in test.');
  const apiObservedAt = changed!.observedAt;
  let controller: Awaited<ReturnType<typeof readUiSnapshot>> | null = null;
  let remoteUi: Awaited<ReturnType<typeof readUiSnapshot>> | null = null;
  const uiDeadline = Date.now() + 15_000;
  while (Date.now() < uiDeadline) {
    controller = await readUiSnapshot(page);
    remoteUi = await readUiSnapshot(remote);
    if (controller.controller.presentationId === changed!.presentationId && controller.controller.slideIndex === changed!.slideIndex && remoteUi.remote.presentationId === changed!.presentationId && remoteUi.remote.slideIndex === changed!.slideIndex) break;
    await page.waitForTimeout(200);
  }
  expect(controller?.controller.presentationId).toBe(changed!.presentationId);
  expect(controller?.controller.slideIndex).toBe(changed!.slideIndex);
  expect(remoteUi?.remote.presentationId).toBe(changed!.presentationId);
  expect(remoteUi?.remote.slideIndex).toBe(changed!.slideIndex);
  await attachJson(testInfo, 'transition-timeline.json', { baseline, changed, apiObservedAt, controllerObservedAt: controller?.observedAt ?? null, remoteObservedAt: remoteUi?.observedAt ?? null, controllerLatencyMs: controller ? controller.observedAt - apiObservedAt : null, remoteLatencyMs: remoteUi ? remoteUi.observedAt - apiObservedAt : null, scenario: process.env.PP_E2E_OBSERVE_SCENARIO ?? 'manual transition' });
});
