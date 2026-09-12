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

  async function mountApp(permissionQuery: () => Promise<PermissionStatus>, responder: (pathname: string) => Response | Promise<Response> = responseFor): Promise<string[]> {
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
    expect(container?.querySelector('.top-live-badge')?.className).toContain('connection-connected');
    expect(container?.querySelector('.top-live-badge .status-dot')?.className).toContain('connected');
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

  it('adopts a late active playlist while following instead of staying on the first playlist', async () => {
    const playlists = [
      { id: { uuid: 'playlist-other', name: 'Other Playlist', index: 0 }, type: 'playlist' },
      { id: { uuid: 'playlist-active', name: 'Active Playlist', index: 1 }, type: 'playlist' },
    ];
    const item = { id: { uuid: 'item-active', name: 'Active Item', index: 0 }, type: 'presentation', presentation_info: { presentation_uuid: 'presentation-active' }, is_hidden: false, is_pco: false };
    const presentation = { presentation: { groups: [{ name: 'Group', color: null, slides: [{ text: 'Active slide', notes: '', label: '' }] }] } };
    const responder = async (pathname: string) => {
      if (pathname === '/v1/playlists') return new Response(JSON.stringify(playlists), { status: 200 });
      if (pathname === '/v1/playlist/active') {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ presentation: { playlist: playlists[1].id, item: item.id }, announcements: { playlist: null, item: null } }), { status: 200 });
      }
      if (pathname === '/v1/presentation/slide_index') return new Response(JSON.stringify({ presentation_index: { index: 0, presentation_id: { uuid: 'presentation-active', name: 'Active Presentation', index: 0 } } }), { status: 200 });
      if (pathname === '/v1/playlist/playlist-active') return new Response(JSON.stringify({ id: playlists[1].id, items: [item] }), { status: 200 });
      if (pathname === '/v1/presentation/active') return new Response(JSON.stringify(presentation), { status: 200 });
      return responseFor(pathname);
    };
    await mountApp(async () => ({ state: 'granted' } as PermissionStatus), responder);
    await vi.waitFor(() => expect(container?.querySelector('.sidebar-collection-item.active')?.textContent).toBe('Active Playlist'));
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Active Item'));
  });

  it('does not merge a focused playlist item with a different currently output presentation', async () => {
    const playlist = { uuid: 'playlist-active', name: 'Active Playlist', index: 0 };
    const focusedItem = { uuid: 'item-focused', name: 'Focused Item', index: 0 };
    const responder = (pathname: string) => {
      if (pathname === '/v1/playlists') return new Response(JSON.stringify([{ id: playlist, type: 'playlist' }]), { status: 200 });
      if (pathname === '/v1/playlist/active') return new Response(JSON.stringify({ presentation: { playlist, item: focusedItem }, announcements: { playlist: null, item: null } }), { status: 200 });
      if (pathname === '/v1/presentation/slide_index') return new Response(JSON.stringify({ presentation_index: { index: 0, presentation_id: { uuid: 'presentation-live', name: 'Live Presentation', index: 0 } } }), { status: 200 });
      if (pathname === '/v1/playlist/playlist-active') return new Response(JSON.stringify({ id: playlist, items: [{ id: focusedItem, type: 'presentation', presentation_info: { presentation_uuid: 'presentation-focused' }, is_hidden: false, is_pco: false }] }), { status: 200 });
      if (pathname === '/v1/presentation/active') return new Response(JSON.stringify({ presentation: { groups: [{ name: 'Live Group', color: null, slides: [{ text: 'Live output', notes: '', label: '' }] }] } }), { status: 200 });
      return responseFor(pathname);
    };
    await mountApp(async () => ({ state: 'granted' } as PermissionStatus), responder);
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Live Presentation'));
    await vi.waitFor(() => expect(container?.querySelector('.slide-card.active')).not.toBeNull());
    expect(container?.querySelector('.slide-card')?.getAttribute('data-context-key')).toBe('active:presentation-live');
    expect(container?.querySelector(`[data-context-key*="${focusedItem.uuid}"]`)).toBeNull();
  });

  it('keeps inactive playlist presentations browsable without marking them live', async () => {
    const playlistId = { uuid: 'playlist-a', name: 'Playlist A', index: 0 };
    const item = (uuid: string, name: string, index: number, presentationUuid: string, arrangement_name?: string) => ({
      id: { uuid, name, index }, type: 'presentation', presentation_info: { presentation_uuid: presentationUuid, ...(arrangement_name ? { arrangement_name } : {}) }, is_hidden: false, is_pco: false,
    });
    const presentation = (name: string) => ({ groups: [{ name: 'Group', color: null, slides: [{ text: `${name} slide 1`, notes: '', label: '1' }, { text: `${name} slide 2`, notes: '', label: '2' }] }], has_timeline: false, destination: 'presentation' });
    const responder = (pathname: string) => {
      if (pathname === '/v1/presentation/slide_index') return new Response(JSON.stringify({ presentation_index: { index: 0, presentation_id: { uuid: 'presentation-a', name: 'Presentation A', index: 0 } } }), { status: 200 });
      if (pathname === '/v1/playlist/active') return new Response(JSON.stringify({ presentation: { playlist: playlistId, item: { uuid: 'item-a', name: 'Presentation A', index: 0 } }, announcements: { playlist: null, item: null } }), { status: 200 });
      if (pathname === '/v1/playlists') return new Response(JSON.stringify([{ id: playlistId, type: 'playlist', playlists: [] }]), { status: 200 });
      if (pathname === '/v1/playlist/playlist-a') return new Response(JSON.stringify({ id: playlistId, items: [item('item-a', 'Presentation A', 0, 'presentation-a'), item('item-b', 'Presentation B', 1, 'presentation-shared', 'Full'), item('item-c', 'Presentation C', 2, 'presentation-shared', 'Chorus Only')] }), { status: 200 });
      if (pathname === '/v1/presentation/active') return new Response(JSON.stringify({ presentation: presentation('Presentation A') }), { status: 200 });
      if (pathname === '/v1/presentation/presentation-shared') return new Response(JSON.stringify(presentation('Shared Presentation')), { status: 200 });
      return responseFor(pathname);
    };
    await mountApp(async () => ({ state: 'granted' } as PermissionStatus), responder);
    await vi.waitFor(() => expect(container?.querySelectorAll('.sidebar-item-button')).toHaveLength(3));
    const items = container?.querySelectorAll<HTMLButtonElement>('.sidebar-item-button');
    await act(async () => items?.[1].click());
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Presentation B'));
    expect(container?.textContent).not.toContain('활성화 필요');
    await vi.waitFor(() => expect(container?.querySelectorAll('.slide-card')).toHaveLength(2));
    expect(container?.querySelector('.presentation-heading small')?.textContent).toContain('기본 cue 보기');
    expect(container?.querySelector('.slide-card.active')).toBeNull();
    expect(container?.querySelector<HTMLButtonElement>('.slide-card')?.disabled).toBe(true);
    expect(container?.querySelector<HTMLImageElement>('.slide-card img')?.src).toContain('/v1/presentation/presentation-shared/thumbnail/0');
    expect(container?.querySelector('.slide-card')?.getAttribute('data-context-key')).toContain('item-b:1:presentation-shared:Full');

    await act(async () => container?.querySelectorAll<HTMLButtonElement>('.sidebar-item-button')[2].click());
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Presentation C'));
    await vi.waitFor(() => expect(container?.querySelectorAll('.slide-card')).toHaveLength(2));
    expect(container?.querySelector('.slide-card.active')).toBeNull();
    expect(container?.querySelector('.slide-card')?.getAttribute('data-context-key')).toContain('item-c:2:presentation-shared:Chorus Only');
    await act(async () => container?.querySelector<HTMLButtonElement>('.top-follow-button')?.click());
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Presentation A'));
  });

  it('handles Controller keyboard shortcuts without focus and ignores interactive targets', async () => {
    const requests = await mountApp(async () => ({ state: 'granted' } as PermissionStatus));
    const commandCount = () => requests.filter((url) => url.endsWith('/v1/trigger/next') || url.endsWith('/v1/trigger/previous')).length;
    const nextEvent = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const previousEvent = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    nextEvent();
    await vi.waitFor(() => expect(commandCount()).toBe(1));
    previousEvent();
    await vi.waitFor(() => expect(commandCount()).toBe(2));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(commandCount()).toBe(3));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commandCount()).toBe(3);
    const input = document.createElement('input'); document.body.append(input);
    const select = document.createElement('select'); document.body.append(select);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(commandCount()).toBe(3);
    input.remove(); select.remove();

    await act(async () => container?.querySelector<HTMLButtonElement>('.top-nav button:last-of-type')?.click());
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(commandCount()).toBe(3);
    await act(async () => container?.querySelector<HTMLButtonElement>('[role="dialog"] .icon-button')?.click());

    container?.querySelector<HTMLButtonElement>('.sidebar-collection-item')?.focus();
    nextEvent();
    await vi.waitFor(() => expect(commandCount()).toBe(4));
  });

  it('does not install Controller global shortcuts on Remote', async () => {
    const requests = await mountApp(async () => ({ state: 'granted' } as PermissionStatus));
    const originalPathname = window.location.pathname;
    window.history.pushState({}, '', '/remote');
    try {
      await act(async () => appRoot?.render(<QueryClientProvider client={queryClient!}><App /></QueryClientProvider>));
      await vi.waitFor(() => expect(container?.querySelector('.remote-app')).not.toBeNull());
      const triggerRequestsBefore = requests.filter((url) => url.endsWith('/v1/trigger/next') || url.endsWith('/v1/trigger/previous')).length;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests.filter((url) => url.endsWith('/v1/trigger/next') || url.endsWith('/v1/trigger/previous')).length).toBe(triggerRequestsBefore);
    } finally {
      window.history.replaceState({}, '', originalPathname);
    }
  });

  it('renders a directly triggered Library presentation in Controller and Remote without playlist identity', async () => {
    const responder = (pathname: string) => {
      if (pathname === '/v1/presentation/slide_index') return new Response(JSON.stringify({ presentation_index: { index: 0, presentation_id: { uuid: 'presentation-a', name: 'Library A', index: 0 } } }), { status: 200 });
      if (pathname === '/v1/presentation/active') return new Response(JSON.stringify({ presentation: { groups: [{ name: 'Group A', color: null, slides: [{ text: 'Live Library cue', notes: '', label: '' }] }] } }), { status: 200 });
      return responseFor(pathname);
    };
    await mountApp(async () => ({ state: 'granted' } as PermissionStatus), responder);
    await vi.waitFor(() => expect(container?.querySelector('.presentation-heading strong')?.textContent).toBe('Library A'));
    await vi.waitFor(() => expect(container?.querySelector('.slide-card.active')?.textContent).toContain('1'));
    const originalPathname = window.location.pathname;
    window.history.pushState({}, '', '/remote');
    try {
      await act(async () => appRoot?.render(<QueryClientProvider client={queryClient!}><App /></QueryClientProvider>));
      await vi.waitFor(() => expect(container?.querySelector('.remote-status')?.textContent).toContain('연결됨'));
      expect(container?.querySelector('.remote-status')?.className).toContain('connection-connected');
      await vi.waitFor(() => expect(container?.querySelector('.remote-slide')?.textContent).toContain('Current'));
      await vi.waitFor(() => expect(container?.querySelector('.remote-group-strip button')?.textContent).toBe('Group A'));
    } finally {
      window.history.replaceState({}, '', originalPathname);
    }
  });
});
