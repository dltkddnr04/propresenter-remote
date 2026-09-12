/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './main';

const settings = { host: '172.30.1.51', port: 1025 };
const canonicalPaths = [
  '/v1/presentation/slide_index?chunked=false',
  '/v1/playlist/active?chunked=false',
  '/v1/status/slide?chunked=false',
  '/v1/status/layers?chunked=false',
];
const browsingPaths = ['/v1/playlists?chunked=false', '/v1/libraries?chunked=false'];
const apiOrigin = 'http://172.30.1.51:1025';
const canonicalUrls = canonicalPaths.map((path) => `${apiOrigin}${path}`);
const browsingUrls = browsingPaths.map((path) => `${apiOrigin}${path}`);

function responseFor(pathname: string): Response {
  if (pathname === '/v1/presentation/slide_index') {
    return new Response(JSON.stringify({ presentation_index: { index: 0, presentation_id: { uuid: 'presentation-a', name: 'A', index: 0 } } }), { status: 200 });
  }
  if (pathname === '/v1/playlist/active') {
    return new Response(JSON.stringify({ presentation: { playlist: null, item: null }, announcements: { playlist: null, item: null } }), { status: 200 });
  }
  if (pathname === '/v1/status/slide') {
    return new Response(JSON.stringify({ current: { uuid: 'current', text: 'Current', notes: '' }, next: null }), { status: 200 });
  }
  if (pathname === '/v1/status/layers') {
    return new Response(JSON.stringify({ video_input: false, media: false, slide: true, announcements: false, props: false, messages: false, audio: false }), { status: 200 });
  }
  if (pathname === '/v1/playlists' || pathname === '/v1/libraries') return new Response('[]', { status: 200 });
  return new Response('{}', { status: 200 });
}

describe('application bootstrap integration', () => {
  let appRoot: Root | null = null;
  let queryClient: QueryClient | null = null;
  let container: HTMLDivElement | null = null;
  const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    window.localStorage.setItem('propresenter-remote:connection', JSON.stringify(settings));
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  });

  afterEach(async () => {
    if (appRoot) {
      await act(async () => appRoot?.unmount());
      appRoot = null;
    }
    queryClient?.clear();
    queryClient = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    else Reflect.deleteProperty(window, 'isSecureContext');
    if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
    else Reflect.deleteProperty(navigator, 'permissions');
  });

  async function mountApp(permissionQuery: () => Promise<PermissionStatus>, responder = responseFor): Promise<string[]> {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const url = new URL(String(input));
      requests.push(String(input));
      return Promise.resolve(responder(url.pathname));
    }));
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(permissionQuery) },
    });

    container = document.createElement('div');
    document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 250, refetchOnWindowFocus: false } } });
    appRoot = createRoot(container);
    await act(async () => {
      appRoot?.render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    });
    await vi.waitFor(() => {
      expect(requests).toEqual(expect.arrayContaining([...canonicalUrls, ...browsingUrls]));
      expect(container?.textContent).toContain('연결됨');
    });
    return requests;
  }

  it('mounts App with a native fetch receiver and starts canonical and browsing requests', async () => {
    const requests = await mountApp(async () => ({ state: 'granted' } as PermissionStatus));
    expect(requests).toEqual(expect.arrayContaining([...canonicalUrls, ...browsingUrls]));
  });

  it('does not block the configured session when permission query rejects', async () => {
    const requests = await mountApp(async () => { throw new Error('permission query is unavailable'); });
    expect(requests).toEqual(expect.arrayContaining(canonicalUrls));
  });

  it('does not leave the configured session blank while permission query is pending', async () => {
    const requests = await mountApp(() => new Promise<PermissionStatus>(() => undefined));
    expect(requests).toEqual(expect.arrayContaining(canonicalUrls));
  });

  it('returns from manual browsing to the canonical active presentation when follow is restored', async () => {
    const item = (uuid: string, name: string, index: number, presentationUuid: string) => ({
      id: { uuid, name, index }, type: 'presentation', presentation_info: { presentation_uuid: presentationUuid }, is_hidden: false, is_pco: false,
    });
    const presentation = (name: string) => ({ presentation: { groups: [{ name: 'Group', color: null, slides: [{ text: name, notes: '', label: '' }] }] } });
    const responder = (pathname: string) => {
      if (pathname === '/v1/playlist/active') return new Response(JSON.stringify({ presentation: { playlist: { uuid: 'playlist-a', name: 'Playlist A', index: 0 }, item: { uuid: 'item-a', name: 'A', index: 0 } }, announcements: { playlist: null, item: null } }), { status: 200 });
      if (pathname === '/v1/playlists') return new Response(JSON.stringify([{ id: { uuid: 'playlist-a', name: 'Playlist A', index: 0 }, type: 'playlist' }]), { status: 200 });
      if (pathname === '/v1/playlist/playlist-a') return new Response(JSON.stringify({ id: { uuid: 'playlist-a', name: 'Playlist A', index: 0 }, items: [item('item-a', 'A', 0, 'presentation-a'), item('item-b', 'B', 1, 'presentation-b')] }), { status: 200 });
      if (pathname === '/v1/presentation/active') return new Response(JSON.stringify(presentation('A')), { status: 200 });
      if (pathname === '/v1/presentation/presentation-b') return new Response(JSON.stringify(presentation('B')), { status: 200 });
      return responseFor(pathname);
    };
    await mountApp(async () => ({ state: 'granted' } as PermissionStatus), responder);
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('A'));
    await act(async () => container?.querySelector<HTMLButtonElement>('.sidebar-item-button:nth-of-type(2)')?.click());
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('B'));
    await act(async () => container?.querySelector<HTMLButtonElement>('.top-follow-button')?.click());
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('A'));
  });
});
