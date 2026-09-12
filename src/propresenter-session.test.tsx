/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProPresenterClient } from './propresenter-client';
import { ProPresenterSessionProvider, readSnapshot, useProPresenterSession, type ProPresenterSession } from './propresenter-session';

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

  it('waits for a post-command canonical read before releasing the next command', async () => {
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
          return new Promise<Response>((resolve) => { releaseFirstRefresh = () => { serverIndex = 1; resolve(positionResponse()); }; });
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
    expect(nextCalls).toBe(1);
    releaseFirstRefresh!();
    await first;
    await vi.waitFor(() => expect(nextCalls).toBe(2));
    await second;
    await vi.waitFor(() => expect(session?.state?.slideIndex).toBe(2));
  });

  it('keeps a healthy session connected when only a command fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/trigger/next') return Promise.resolve(new Response(null, { status: 404 }));
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
    });
  });
});
