import { expect } from '@playwright/test';
import { attachJson, installConnectionSettings, productionUrl, readApiSnapshot, readUiSnapshot } from './helpers';
import { test } from './fixtures';

test.skip(process.env.PP_E2E_LIVE_COMMANDS !== '1' || process.env.PP_E2E_ALLOW_OUTPUT_CHANGES !== '1', 'Live output tests require PP_E2E_LIVE_COMMANDS=1 and PP_E2E_ALLOW_OUTPUT_CHANGES=1.');

test('opt-in remote next command is reflected by the canonical state', async ({ page, request }, testInfo) => {
  await installConnectionSettings(page);
  await page.goto(`${productionUrl}/remote`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.remote-status')).toContainText('연결됨', { timeout: 15_000 });
  const baseline = await readApiSnapshot(request);
  const commandRequests: string[] = [];
  page.on('request', (entry) => { if (/\/v1\/trigger\/(next|previous)$/.test(new URL(entry.url()).pathname)) commandRequests.push(entry.url()); });
  await page.getByRole('button', { name: '다음 ›' }).click();
  await expect.poll(async () => (await readApiSnapshot(request)).slideIndex, { timeout: 10_000 }).not.toBe(baseline.slideIndex);
  const after = await readApiSnapshot(request);
  const ui = await readUiSnapshot(page);
  expect(commandRequests).toHaveLength(1);
  expect(ui.remote.presentationId).toBe(after.presentationId);
  expect(ui.remote.slideIndex).toBe(after.slideIndex);
  await attachJson(testInfo, 'live-command.json', { baseline, after, ui, commandRequests, note: 'This test changes live output and does not attempt restoration automatically.' });
});
