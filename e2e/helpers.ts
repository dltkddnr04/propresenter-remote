import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

export const productionUrl = process.env.PP_E2E_URL ?? 'https://propresenter-remote.alice-data-lab.workers.dev';
export const apiUrl = process.env.PP_E2E_API ?? 'http://172.30.1.51:1025';
export const connectionSettings = { host: new URL(apiUrl).hostname, port: Number(new URL(apiUrl).port || 80) };
export const settingsStorageKey = 'propresenter-remote:connection';

const corePaths = [
  '/v1/presentation/slide_index',
  '/v1/playlist/active',
  '/v1/status/slide',
  '/v1/status/layers',
  '/v1/playlists',
  '/v1/libraries',
];

type JsonObject = { [key: string]: unknown };
type ApiResponse = { path: string; status: number; body: unknown; observedAt: number };

export type ApiSnapshot = {
  observedAt: number;
  presentationId: string | null;
  presentationName: string | null;
  slideIndex: number | null;
  currentText: string;
  nextText: string;
  playlistId: string | null;
  playlistName: string | null;
  playlistItemId: string | null;
  playlistItemName: string | null;
  layers: JsonObject | null;
  responses: ApiResponse[];
};

export type UiSnapshot = {
  observedAt: number;
  controller: { presentationId: string | null; slideIndex: number | null; activeCardIndex: number | null; title: string | null; connectionStatus: string | null; connectionText: string | null };
  remote: { presentationId: string | null; slideIndex: number | null; currentText: string | null; connectionStatus: string | null; connectionText: string | null };
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function asString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function asNumber(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) ? value : null; }
function nested(value: unknown, key: string): JsonObject { return asObject(asObject(value)[key]); }
function identifier(value: unknown): string | null { return asString(asObject(value).uuid); }

async function getJson(request: APIRequestContext, path: string): Promise<ApiResponse> {
  const observedAt = Date.now();
  const response = await request.get(`${apiUrl}${path}`, { timeout: 6_000 });
  const body = response.status() === 204 ? null : await response.json();
  return { path, status: response.status(), body, observedAt };
}

export async function readApiSnapshot(request: APIRequestContext): Promise<ApiSnapshot> {
  const responses = await Promise.all([
    getJson(request, '/v1/presentation/slide_index?chunked=false'),
    getJson(request, '/v1/playlist/active?chunked=false'),
    getJson(request, '/v1/status/slide?chunked=false'),
    getJson(request, '/v1/status/layers?chunked=false'),
  ]);
  for (const response of responses) expect(response.status, `${response.path} returned HTTP ${response.status}`).toBeLessThan(400);
  const position = nested(responses[0].body, 'presentation_index');
  const positionId = nested(position, 'presentation_id');
  const active = nested(responses[1].body, 'presentation');
  const activePlaylist = nested(active, 'playlist');
  const activeItem = nested(active, 'item');
  const status = asObject(responses[2].body);
  const current = nested(status, 'current');
  const next = nested(status, 'next');
  return {
    observedAt: Math.max(...responses.map((response) => response.observedAt)),
    presentationId: identifier(positionId),
    presentationName: asString(positionId.name),
    slideIndex: asNumber(position.index),
    currentText: asString(current.text) ?? '',
    nextText: asString(next.text) ?? '',
    playlistId: identifier(activePlaylist),
    playlistName: asString(activePlaylist.name),
    playlistItemId: identifier(activeItem),
    playlistItemName: asString(activeItem.name),
    layers: asObject(responses[3].body),
    responses,
  };
}

export async function installConnectionSettings(page: Page): Promise<void> {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: settingsStorageKey, value: connectionSettings });
}

export async function readUiSnapshot(page: Page): Promise<UiSnapshot> {
  return page.evaluate(() => {
    const control = document.querySelector<HTMLElement>('.control-app');
    const presentationId = control?.dataset.presentationId ?? '';
    const currentBlock = presentationId
      ? control?.querySelector<HTMLElement>(`.presentation-block[data-presentation-id="${presentationId}"]`)
      : null;
    const controlCard = currentBlock?.querySelector<HTMLElement>('.slide-card.active') ?? null;
    const remote = document.querySelector<HTMLElement>('.remote-app');
    const remoteText = document.querySelector<HTMLElement>('.remote-app .remote-slide:first-of-type p');
    const controllerConnection = document.querySelector<HTMLElement>('.top-live-badge');
    const remoteConnection = document.querySelector<HTMLElement>('.remote-status');
    const number = (value: string | undefined): number | null => value && /^\d+$/.test(value) ? Number(value) : null;
    return {
      observedAt: Date.now(),
      controller: {
        presentationId: control?.dataset.presentationId ?? null,
        slideIndex: number(control?.dataset.slideIndex),
        activeCardIndex: number(controlCard?.dataset.slideIndex),
        title: currentBlock?.querySelector<HTMLElement>('.presentation-heading strong')?.textContent?.trim() ?? null,
        connectionStatus: control?.dataset.connectionStatus ?? null,
        connectionText: controllerConnection?.textContent?.trim() ?? null,
      },
      remote: {
        presentationId: remote?.dataset.presentationId ?? null,
        slideIndex: number(remote?.dataset.slideIndex),
        currentText: remoteText?.textContent?.trim() ?? null,
        connectionStatus: remote?.dataset.connectionStatus ?? null,
        connectionText: remoteConnection?.textContent?.trim() ?? null,
      },
    };
  });
}

export async function waitForCoherentUi(page: Page, request: APIRequestContext, timeout = 15_000): Promise<{ api: ApiSnapshot; ui: UiSnapshot; latencyMs: number }> {
  const deadline = Date.now() + timeout;
  let last: { api: ApiSnapshot; ui: UiSnapshot } | null = null;
  while (Date.now() < deadline) {
    const api = await readApiSnapshot(request);
    const ui = await readUiSnapshot(page);
    last = { api, ui };
    const sameController = api.presentationId === ui.controller.presentationId && api.slideIndex === ui.controller.slideIndex;
    const sameCard = api.slideIndex === null || api.slideIndex === ui.controller.activeCardIndex;
    if (sameController && sameCard) return { api, ui, latencyMs: Math.max(0, ui.observedAt - api.observedAt) };
    await page.waitForTimeout(200);
  }
  throw new Error(`Controller did not converge to API state: ${JSON.stringify(last)}`);
}

export async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' });
}

export function isCoreApiUrl(url: string): boolean {
  try { return corePaths.some((path) => new URL(url).pathname === path); } catch { return false; }
}

export function apiPath(url: string): string | null {
  try { return new URL(url).pathname; } catch { return null; }
}
