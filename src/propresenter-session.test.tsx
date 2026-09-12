/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProPresenterClient } from './propresenter-client';
import { ProPresenterSessionProvider, activePlaylistThumbnailUrl, readSnapshot, useProPresenterSession, type ProPresenterSession } from './propresenter-session';
import { asArrangementCueIndex, asPlaylistItemIndex } from './propresenter';

const id = (uuid: string, name = uuid, index = 0) => ({ uuid, name, index });
const active = { presentation: { playlist: id('playlist-a'), item: id('item-a', 'Item A', 1) }, announcements: { playlist: null, item: null } };
const emptyActive = { presentation: { playlist: null, item: null }, announcements: { playlist: null, item: null } };
const layers = { video_input: false, media: false, slide: true, announcements: false, props: false, messages: false, audio: false };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function snapshotClient(positions: unknown[]) {
  return new ProPresenterClient('', async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/v1/presentation/slide_index') return response(positions.shift());
    if (path === '/v1/playlist/active') return response(active);
    if (path === '/v1/status/slide') return response({ current: { uuid: 'current', text: 'Current', notes: '' }, next: { uuid: 'next', text: 'Next', notes: '' } });
    if (path === '/v1/status/layers') return response(layers);
    throw new Error(`unexpected ${path}`);
  });
}

describe('canonical snapshot transitions', () => {
  it('keeps status, layers, and playlist metadata when the position pair is stable', async () => {
    const position = { presentation_index: { presentation_id: id('presentation-a'), index: 1 } };
    const state = await readSnapshot(snapshotClient([position, position]), 1);
    expect(state).toMatchObject({ presentationId: 'presentation-a', slideIndex: 1, playlistId: 'playlist-a', currentCue: { text: 'Current' }, outputLayers: { slide: true } });
  });

  it('retries a changed sample so a normal transition gets a coherent snapshot', async () => {
    const first = { presentation_index: { presentation_id: id('presentation-a'), index: 3 } };
    const second = { presentation_index: { presentation_id: id('presentation-b'), index: 0 } };
    const state = await readSnapshot(snapshotClient([first, second, second, second]), 2);
    expect(state.presentationId).toBe('presentation-b');
    expect(state.slideIndex).toBe(0);
    expect(state.playlistId).toBe('playlist-a');
    expect(state.currentCue).toMatchObject({ text: 'Current' });
    expect(state.outputLayers).toMatchObject({ slide: true });
  });

  it('does not expose mixed metadata when both coherent sampling attempts are crossed by transitions', async () => {
    const first = { presentation_index: { presentation_id: id('presentation-a'), index: 3 } };
    const second = { presentation_index: { presentation_id: id('presentation-b'), index: 0 } };
    const third = { presentation_index: { presentation_id: id('presentation-c'), index: 0 } };
    const fourth = { presentation_index: { presentation_id: id('presentation-d'), index: 0 } };
    const state = await readSnapshot(snapshotClient([first, second, third, fourth]), 3);
    expect(state.presentationId).toBe('presentation-d');
    expect(state.playlistId).toBeNull();
    expect(state.currentCue).toBeNull();
    expect(state.outputLayers).toBeNull();
  });
});

describe('thumbnail endpoint selection', () => {
  it('uses the active playlist thumbnail endpoint for the current playlist item', () => {
    const context = { source: 'playlist' as const, playlistId: 'playlist-a', playlistName: 'Playlist A', playlistItemId: 'item-a', playlistItemIndex: asPlaylistItemIndex(7)!, presentationId: 'presentation-a', arrangementName: null, kind: 'presentation' as const, name: 'Item A', cacheKey: 'playlist-a:item-a:7:presentation:default' };
    expect(activePlaylistThumbnailUrl('http://host:1025', context, 0, '256')).toBe('http://host:1025/v1/playlist/active/presentation/7/thumbnail/0?quality=256');
  });
});

describe('transport command deadlines', () => {
  it('rejects an unresponsive command even when its fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
      const client = new ProPresenterClient('', fetcher);
      const command = client.next();
      const rejected = expect(command).rejects.toMatchObject({ kind: 'network', path: '/v1/trigger/next' });

      await vi.advanceTimersByTimeAsync(2_500);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shared command service', () => {
  let root: Root | null = null;
  let queryClient: QueryClient | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    queryClient?.clear(); queryClient = null;
    container?.remove(); container = null;
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it('serializes rapid next commands instead of silently dropping the second input', async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname; calls.push(path);
      if (path === '/v1/trigger/next') return new Promise<Response>((resolve) => releases.push(() => resolve(new Response(null, { status: 204 }))));
      if (path === '/v1/presentation/active/group/1/trigger') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response(emptyActive));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));
    const first = session!.commands.next(); const second = session!.commands.next();
    await vi.waitFor(() => expect(calls.filter((path) => path === '/v1/trigger/next')).toHaveLength(1));
    releases.shift()!(); await first;
    await vi.waitFor(() => expect(calls.filter((path) => path === '/v1/trigger/next')).toHaveLength(2));
    releases.shift()!(); await second;
    await session!.commands.triggerActiveGroup(1 as never);
    expect(calls).toContain('/v1/presentation/active/group/1/trigger');
  });

  it('keeps FIFO command HTTP order without waiting for canonical reconciliation', async () => {
    let serverIndex = 0;
    let nextCalls = 0;
    let releaseFirstRefresh: (() => void) | null = null;
    const positionResponse = () => response({ presentation_index: { presentation_id: id('presentation-a'), index: serverIndex } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/trigger/next') {
        nextCalls += 1;
        if (nextCalls === 2) serverIndex = 2;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === '/v1/presentation/slide_index') {
        if (serverIndex === 0 && nextCalls === 1 && !releaseFirstRefresh) {
          return new Promise<Response>((resolve) => { releaseFirstRefresh = () => resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 1 } })); });
        }
        return Promise.resolve(positionResponse());
      }
      if (path === '/v1/playlist/active') return Promise.resolve(response(emptyActive));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));
    const first = session!.commands.next();
    await vi.waitFor(() => expect(nextCalls).toBe(1));
    await vi.waitFor(() => expect(releaseFirstRefresh).not.toBeNull());
    const second = session!.commands.next();
    await Promise.resolve();
    await vi.waitFor(() => expect(nextCalls).toBe(2));
    releaseFirstRefresh!();
    await first;
    await second;
    await vi.waitFor(() => expect(session?.state?.slideIndex).toBe(2));
  });

  it('keeps a healthy session connected when only a command fails', async () => {
    let commandCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/trigger/next') {
        commandCount += 1;
        return Promise.resolve(new Response(null, { status: commandCount === 1 ? 404 : 204 }));
      }
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response(emptyActive));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));
    await expect(session!.commands.next()).rejects.toMatchObject({ kind: 'http', path: '/v1/trigger/next' });
    await vi.waitFor(() => {
      expect(session?.connection.status).toBe('connected');
      expect(session?.commands.error).toContain('404');
      expect(session?.commands.pending).toBe(false);
    });
    await expect(session!.commands.next()).resolves.toBeUndefined();
    expect(commandCount).toBe(2);
    expect(session?.commands.pending).toBe(false);
  });

  it('settles an active presentation cue command without leaving pending set', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v1/presentation/active/0/trigger') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response(active));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));

    const currentContext = { source: 'active' as const, presentationId: 'presentation-a', name: 'Presentation A', cacheKey: 'active:presentation-a' };
    await expect(session!.commands.triggerPresentationCue(currentContext, { cueIndex: asArrangementCueIndex(0)!, text: '', notes: '', label: '', groupName: '', groupKey: '' })).resolves.toBeUndefined();
    expect(calls).toContain('/v1/presentation/active/0/trigger');
    expect(session?.commands.pending).toBe(false);
  });

  it('keeps the command queue usable when post-command reconciliation fails', async () => {
    let positionReads = 0;
    let commandCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/trigger/next') {
        commandCount += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === '/v1/presentation/slide_index') {
        positionReads += 1;
        return Promise.resolve(positionReads > 2 ? new Response(null, { status: 503 }) : response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      }
      if (path === '/v1/playlist/active') return Promise.resolve(response(emptyActive));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));

    await expect(session!.commands.next()).resolves.toBeUndefined();
    await expect(session!.commands.next()).resolves.toBeUndefined();
    expect(commandCount).toBe(2);
    expect(session?.commands.pending).toBe(false);
  });

  it('activates an inactive playlist item before triggering its authoritative arrangement cue', async () => {
    const calls: string[] = [];
    let live = { playlist: id('playlist-a'), item: id('item-a', 'Item A', 1) };
    let livePresentation = 'presentation-a';
    let liveIndex = 0;
    let failCueOnce = false;
    // The playlist's visible/default order is intentionally different from
    // the arrangement returned after item activation.
    const bSlides = [{ text: 'B slide 2', notes: '', label: '2' }, { text: 'B slide 1', notes: '', label: '1' }];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v1/playlist/playlist-a/2/trigger') {
        live = { playlist: id('playlist-a'), item: id('item-b', 'Item B', 2) }; livePresentation = 'presentation-b'; liveIndex = 0;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === '/v1/playlist/active/presentation/0/trigger') { if (failCueOnce) { failCueOnce = false; return Promise.resolve(new Response(null, { status: 503 })); } liveIndex = 0; return Promise.resolve(new Response(null, { status: 204 })); }
      if (path === '/v1/playlist/active/presentation/1/trigger') { if (failCueOnce) { failCueOnce = false; return Promise.resolve(new Response(null, { status: 503 })); } liveIndex = 1; return Promise.resolve(new Response(null, { status: 204 })); }
      if (path === '/v1/presentation/active/1/trigger') throw new Error('generic active cue endpoint must not be used');
      if (path === '/v1/trigger/next') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id(livePresentation), index: liveIndex } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response({ presentation: { playlist: live.playlist, item: live.item }, announcements: { playlist: null, item: null } }));
      if (path === '/v1/playlist/playlist-a') return Promise.resolve(response({ id: id('playlist-a', 'Playlist A'), items: [
        { id: id('item-a', 'Item A', 1), type: 'presentation', presentation_info: { presentation_uuid: 'presentation-a' }, is_hidden: false, is_pco: false },
        { id: id('item-b', 'Item B', 2), type: 'presentation', presentation_info: { presentation_uuid: 'presentation-b', arrangement_name: 'Full' }, is_hidden: false, is_pco: false },
      ] }));
      if (path === '/v1/presentation/active') return Promise.resolve(response({ presentation: { groups: [{ name: 'Group', color: null, slides: livePresentation === 'presentation-b' ? bSlides : [{ text: 'A slide', notes: '', label: '1' }] }] } }));
      if (path === '/v1/presentation/presentation-b') return Promise.resolve(response({ groups: [{ name: 'Group', color: null, slides: bSlides }] }));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));

    const inactiveContext = { source: 'playlist' as const, playlistId: 'playlist-a', playlistName: 'Playlist A', playlistItemId: 'item-b', playlistItemIndex: asPlaylistItemIndex(2)!, presentationId: 'presentation-b', arrangementName: 'Full', kind: 'presentation' as const, name: 'Presentation B', cacheKey: 'playlist-a:item-b:2:presentation-b:Full' };
    await expect(session!.commands.triggerPlaylistCue(inactiveContext, { cueIndex: asArrangementCueIndex(1)!, text: 'B slide 2', notes: '', label: '2', groupName: 'Group', groupKey: '0:Group' })).resolves.toBeUndefined();
    expect(calls).toContain('/v1/playlist/playlist-a/2/trigger');
    expect(calls).toContain('/v1/playlist/active/presentation/0/trigger');
    expect(calls).not.toContain('/v1/presentation/active/1/trigger');
    expect(session?.commands.pending).toBe(false);

    await vi.waitFor(() => expect(session?.state?.playlistItemId).toBe('item-b'));
    const beforeActiveClick = calls.length;
    failCueOnce = true;
    await expect(session!.commands.triggerPlaylistCue(inactiveContext, { cueIndex: asArrangementCueIndex(0)!, text: 'B slide 1', notes: '', label: '1', groupName: 'Group', groupKey: '0:Group' })).rejects.toMatchObject({ kind: 'http', path: '/v1/playlist/active/presentation/1/trigger' });
    await vi.waitFor(() => expect(session?.commands.pending).toBe(false));
    await expect(session!.commands.triggerPlaylistCue(inactiveContext, { cueIndex: asArrangementCueIndex(0)!, text: 'B slide 1', notes: '', label: '1', groupName: 'Group', groupKey: '0:Group' })).resolves.toBeUndefined();
    expect(calls.slice(beforeActiveClick)).not.toContain('/v1/playlist/playlist-a/2/trigger');
    expect(calls).toContain('/v1/playlist/active/presentation/1/trigger');
    expect(session?.commands.pending).toBe(false);

    const rapidFirst = session!.commands.triggerPlaylistCue(inactiveContext, { cueIndex: asArrangementCueIndex(1)!, text: 'B slide 2', notes: '', label: '2', groupName: 'Group', groupKey: '0:Group' });
    const rapidSecond = session!.commands.triggerPlaylistCue(inactiveContext, { cueIndex: asArrangementCueIndex(0)!, text: 'B slide 1', notes: '', label: '1', groupName: 'Group', groupKey: '0:Group' });
    await Promise.all([rapidFirst, rapidSecond]);
    expect(calls.filter((path) => path.startsWith('/v1/playlist/active/presentation/') && path.endsWith('/trigger')).slice(-2)).toEqual(['/v1/playlist/active/presentation/0/trigger', '/v1/playlist/active/presentation/1/trigger']);

    await expect(session!.commands.next()).resolves.toBeUndefined();
    expect(calls).toContain('/v1/trigger/next');
    expect(session?.commands.pending).toBe(false);
  });

  it('releases pending after inactive playlist activation fails and accepts the next command', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v1/playlist/playlist-a/2/trigger') return Promise.resolve(new Response(null, { status: 503 }));
      if (path === '/v1/trigger/next') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response(active));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));

    const context = { source: 'playlist' as const, playlistId: 'playlist-a', playlistName: 'Playlist A', playlistItemId: 'item-b', playlistItemIndex: asPlaylistItemIndex(2)!, presentationId: 'presentation-b', arrangementName: 'Full', kind: 'presentation' as const, name: 'Presentation B', cacheKey: 'playlist-a:item-b:2:presentation-b:Full' };
    const target = { cueIndex: asArrangementCueIndex(0)!, text: 'B slide', notes: '', label: '1', groupName: 'Group', groupKey: '0:Group' };
    await expect(session!.commands.triggerPlaylistCue(context, target)).rejects.toMatchObject({ kind: 'http', path: '/v1/playlist/playlist-a/2/trigger' });
    await vi.waitFor(() => expect(session?.commands.pending).toBe(false));
    await vi.waitFor(() => expect(session?.commands.error).toContain('503'));
    await expect(session!.commands.next()).resolves.toBeUndefined();
    expect(calls).toContain('/v1/trigger/next');
    expect(session?.commands.pending).toBe(false);
  });

  it('bounds playlist activation confirmation and leaves the queue usable', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/v1/playlist/playlist-a/2/trigger') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/trigger/next') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/v1/presentation/slide_index') return Promise.resolve(response({ presentation_index: { presentation_id: id('presentation-a'), index: 0 } }));
      if (path === '/v1/playlist/active') return Promise.resolve(response(active));
      if (path === '/v1/status/slide') return Promise.resolve(response({ current: null, next: null }));
      if (path === '/v1/status/layers') return Promise.resolve(response(layers));
      if (path === '/v1/playlist/playlist-a') return Promise.resolve(response({ id: id('playlist-a'), items: [{ id: id('item-b', 'Item B', 2), type: 'presentation', presentation_info: { presentation_uuid: 'presentation-b', arrangement_name: 'Full' }, is_hidden: false, is_pco: false }] }));
      throw new Error(`unexpected ${path}`);
    }));
    let session: ProPresenterSession | null = null;
    function Probe() { session = useProPresenterSession(); return <span>{session.connection.status}</span>; }
    container = document.createElement('div'); document.body.append(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    root = createRoot(container);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><ProPresenterSessionProvider settings={{ host: '172.30.1.51', port: 1025 }}><Probe /></ProPresenterSessionProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(session?.connection.status).toBe('connected'));

    const context = { source: 'playlist' as const, playlistId: 'playlist-a', playlistName: 'Playlist A', playlistItemId: 'item-b', playlistItemIndex: asPlaylistItemIndex(2)!, presentationId: 'presentation-b', arrangementName: 'Full', kind: 'presentation' as const, name: 'Presentation B', cacheKey: 'playlist-a:item-b:2:presentation-b:Full' };
    const target = { cueIndex: asArrangementCueIndex(0)!, text: 'B slide', notes: '', label: '1', groupName: 'Group', groupKey: '0:Group' };
    await expect(session!.commands.triggerPlaylistCue(context, target)).rejects.toMatchObject({ kind: 'command' });
    await vi.waitFor(() => expect(session?.commands.pending).toBe(false));
    expect(calls).not.toContain('/v1/playlist/active/presentation/0/trigger');
    await expect(session!.commands.next()).resolves.toBeUndefined();
    expect(session?.commands.pending).toBe(false);
  }, 10_000);
});
