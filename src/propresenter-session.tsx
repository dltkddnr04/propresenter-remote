import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBase, ProPresenterClient } from './propresenter-client';
import {
  ArrangementCueIndex, CanonicalState, ConnectionSettings, LibraryPresentationContext, PlaylistItemContext, PresentationContext,
  acceptCanonicalSnapshot, asArrangementCueIndex, currentCueIndex, enrichPlaylistContext, flattenSlides, isCurrentContext, normalizeCanonicalState,
  normalizeLibraries, normalizeLibraryItems, normalizePlaylistItems, normalizePlaylistTree,
} from './propresenter';

const POLLING_INTERVAL_MS = 400;
export type Connection = { status: 'connecting' | 'connected' | 'error'; error: string | null };
export type ProPresenterCommands = {
  pending: boolean; error: string | null; next: () => Promise<void>; previous: () => Promise<void>;
  triggerPresentationCue: (cueIndex: ArrangementCueIndex) => Promise<void>;
  triggerPlaylistItem: (context: PlaylistItemContext) => Promise<void>;
  triggerLibraryCue: (context: LibraryPresentationContext, cueIndex: number) => Promise<void>;
  triggerActiveGroup: (groupName: string) => Promise<void>; clearError: () => void;
};
export type ProPresenterSession = { base: string; client: ProPresenterClient; state: CanonicalState | null; connection: Connection; commands: ProPresenterCommands };
const SessionContext = createContext<ProPresenterSession | null>(null);
const sessionKey = (base: string) => ['propresenter-session', base] as const;
const HEALTH_GRACE_MS = 5_000;

export function connectionHealth(root: { isError: boolean; error: unknown }, state: CanonicalState | null, lastSuccessfulPollAt: number | null, now = Date.now(), diagnostic: unknown = null): Connection {
  if (!state && lastSuccessfulPollAt === null) return { status: 'connecting', error: null };
  const recentlyHealthy = lastSuccessfulPollAt !== null && now - lastSuccessfulPollAt < HEALTH_GRACE_MS;
  if (root.isError && !recentlyHealthy) return { status: 'error', error: root.error instanceof Error ? root.error.message : 'ProPresenter에 연결할 수 없습니다.' };
  if (state) return { status: 'connected', error: diagnostic instanceof Error ? diagnostic.message : null };
  return { status: 'connecting', error: null };
}

export async function readSnapshot(client: ProPresenterClient, revision: number, signal?: AbortSignal, onStatusDiagnostic?: (error: unknown | null) => void): Promise<CanonicalState> {
  // All required sources start together. A status failure is output-only, not a connection failure.
  const [position, activePlaylist, status] = await Promise.all([
    client.presentationPosition(signal), client.activePlaylist(signal), client.slideStatus(signal).then((value) => { onStatusDiagnostic?.(null); return value; }).catch((error) => { if (signal?.aborted) throw error; onStatusDiagnostic?.(error); return null; }),
  ]);
  return normalizeCanonicalState({ revision, position, activePlaylist, status });
}

export function ProPresenterSessionProvider({ settings, children }: { settings: ConnectionSettings; children: React.ReactNode }) {
  const base = apiBase(settings); const client = useMemo(() => new ProPresenterClient(base), [base]); const queryClient = useQueryClient();
  const revision = useRef(0);
  const accepted = useRef<{ base: string; state: CanonicalState | null }>({ base, state: null });
  const lastSuccessfulPollAt = useRef<number | null>(null);
  const statusDiagnostic = useRef<unknown | null>(null);
  const [, setHealthTick] = useState(0);
  const root = useQuery({
    queryKey: sessionKey(base),
    queryFn: async ({ signal }) => {
      if (accepted.current.base !== base) {
        accepted.current = { base, state: null };
        lastSuccessfulPollAt.current = null;
        statusDiagnostic.current = null;
      }
      const candidate = await readSnapshot(client, ++revision.current, signal, (error) => { statusDiagnostic.current = error; });
      const state = acceptCanonicalSnapshot(accepted.current.state, candidate);
      accepted.current.state = state;
      lastSuccessfulPollAt.current = Date.now();
      return state;
    },
    refetchInterval: POLLING_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
    retryDelay: 250,
  });
  useEffect(() => {
    if (!root.isError || lastSuccessfulPollAt.current === null) return undefined;
    const remaining = 5_000 - (Date.now() - lastSuccessfulPollAt.current);
    if (remaining <= 0) return undefined;
    const timer = globalThis.setTimeout(() => setHealthTick((value) => value + 1), remaining + 10);
    return () => globalThis.clearTimeout(timer);
  }, [root.isError, root.data?.revision]);
  const playlist = useQuery({ queryKey: ['propresenter-session-active-playlist', base, root.data?.playlistId], queryFn: ({ signal }) => client.playlist(root.data!.playlistId!, signal), enabled: Boolean(root.data?.playlistId), retry: 1, retryDelay: 250 });
  const canonical = root.data ?? (accepted.current.base === base ? accepted.current.state : null);
  const state = useMemo(() => canonical ? enrichPlaylistContext(canonical, playlist.data ?? null) : null, [canonical, playlist.data]);
  const connection = connectionHealth(root, state, lastSuccessfulPollAt.current, Date.now(), statusDiagnostic.current);
  const pendingRef = useRef(false); const [pending, setPending] = useState(false); const [commandError, setCommandError] = useState<string | null>(null);
  const commands = useMemo<ProPresenterCommands>(() => {
    const run = async (command: () => Promise<void>) => {
      if (pendingRef.current) return;
      pendingRef.current = true; setPending(true); setCommandError(null);
      try {
        await command();
      }
      catch (error) { setCommandError(error instanceof Error ? error.message : 'ProPresenter 명령을 전달할 수 없습니다.'); throw error; }
      finally { pendingRef.current = false; setPending(false); }
      void queryClient.refetchQueries({ queryKey: sessionKey(base), type: 'active' }).catch(() => undefined);
    };
    return {
      pending, error: commandError, next: () => run(() => client.next()), previous: () => run(() => client.previous()),
      // This endpoint is expressly arrangement-aware, but only for the current active presentation.
      triggerPresentationCue: (cueIndex) => run(() => client.triggerActiveArrangementCue(cueIndex)),
      triggerPlaylistItem: (context) => run(() => client.triggerPlaylistItem(context.playlistId, context.playlistItemIndex)),
      triggerLibraryCue: (context, cueIndex) => run(() => client.triggerLibraryCue(context.libraryId, context.presentationId, cueIndex)),
      triggerActiveGroup: (groupName) => run(() => client.triggerActivePresentationGroup(groupName)), clearError: () => setCommandError(null),
    };
  }, [base, client, commandError, pending, queryClient]);
  const value = useMemo(() => ({ base, client, state, connection, commands }), [base, client, state, connection, commands]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useProPresenterSession(): ProPresenterSession { const session = useContext(SessionContext); if (!session) throw new Error('ProPresenterSessionProvider가 필요합니다.'); return session; }

export function usePlaylists() { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-playlists', base], queryFn: ({ signal }) => client.playlists(signal).then(normalizePlaylistTree), retry: 1 }); }
export function usePlaylistItems(playlistId: string | null, enabled = true) { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-playlist-items', base, playlistId], queryFn: ({ signal }) => client.playlist(playlistId!, signal).then(normalizePlaylistItems), enabled: enabled && Boolean(playlistId), retry: 1 }); }
export function useLibraries() { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-libraries', base], queryFn: ({ signal }) => client.libraries(signal).then(normalizeLibraries), retry: 1 }); }
export function useLibraryItems(libraryId: string | null, enabled = true) { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-library-items', base, libraryId], queryFn: ({ signal }) => client.library(libraryId!, signal).then(normalizeLibraryItems), enabled: enabled && Boolean(libraryId), retry: 1 }); }

export function usePresentationCues(context: PresentationContext | null | undefined, options: { enabled?: boolean } = {}) {
  const { base, client, state } = useProPresenterSession(); const activeArrangement = isCurrentContext(state, context);
  return useQuery({ queryKey: ['propresenter-presentation-cues', base, context?.cacheKey, activeArrangement ? 'active-arrangement' : 'presentation'], queryFn: ({ signal }) => activeArrangement ? client.activePresentation(signal).then((response) => flattenSlides(response, 'active-arrangement')) : client.presentation(context!.presentationId!, signal).then((response) => flattenSlides(response, 'presentation')), enabled: Boolean(context?.presentationId) && options.enabled !== false, retry: 1 });
}
export function playlistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string { return `${base}/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`; }
export function presentationThumbnailUrl(base: string, context: PresentationContext | null | undefined, cueIndex: number | null, quality: string): string | null { if (!context?.presentationId || cueIndex === null || cueIndex < 0) return null; return context.source === 'playlist' ? playlistThumbnailUrl(base, context, cueIndex, quality) : `${base}/v1/presentation/${encodeURIComponent(context.presentationId)}/thumbnail/${cueIndex}?quality=${quality}`; }
export function genericPresentationThumbnailUrl(base: string, presentationId: string | null, cueIndex: number | null, quality: string): string | null { return presentationId && cueIndex !== null && cueIndex >= 0 ? `${base}/v1/presentation/${encodeURIComponent(presentationId)}/thumbnail/${cueIndex}?quality=${quality}` : null; }
export { currentCueIndex, asArrangementCueIndex };
