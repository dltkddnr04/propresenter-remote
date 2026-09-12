import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBase, ProPresenterClient } from './propresenter-client';
import {
  ArrangementCueIndex, CanonicalState, ConnectionSettings, LibraryPresentationContext, PlaylistItemContext, PresentationContext,
  PresentationGroupIndex, acceptCanonicalSnapshot, asArrangementCueIndex, canReadArrangementCues, currentCueIndex, enrichPlaylistContext, flattenSlides, isCurrentContext, normalizeCanonicalState,
  normalizeLibraries, normalizeLibraryItems, normalizePlaylistItems, normalizePlaylistTree,
} from './propresenter';

const POLLING_INTERVAL_MS = 400;
export type Connection = { status: 'connecting' | 'connected' | 'error'; error: string | null };
export type ProPresenterCommands = {
  pending: boolean; error: string | null; next: () => Promise<void>; previous: () => Promise<void>;
  triggerPresentationCue: (cueIndex: ArrangementCueIndex) => Promise<void>;
  triggerPlaylistItem: (context: PlaylistItemContext) => Promise<void>;
  triggerLibraryCue: (context: LibraryPresentationContext, cueIndex: number) => Promise<void>;
  triggerActiveGroup: (groupIndex: PresentationGroupIndex) => Promise<void>; clearError: () => void;
};
export type ProPresenterSession = { base: string; client: ProPresenterClient; state: CanonicalState | null; connection: Connection; commands: ProPresenterCommands };
const SessionContext = createContext<ProPresenterSession | null>(null);
const sessionKey = (base: string) => ['propresenter-session', base] as const;
const HEALTH_GRACE_MS = 5_000;

export function connectionHealth(root: { isError: boolean; error: unknown }, state: CanonicalState | null, lastSuccessfulPollAt: number | null, now = Date.now(), diagnostic: unknown = null): Connection {
  if (!state && lastSuccessfulPollAt === null) {
    return root.isError ? { status: 'error', error: root.error instanceof Error ? root.error.message : 'ProPresenter에 연결할 수 없습니다.' } : { status: 'connecting', error: null };
  }
  const recentlyHealthy = lastSuccessfulPollAt !== null && now - lastSuccessfulPollAt < HEALTH_GRACE_MS;
  if (root.isError && !recentlyHealthy) return { status: 'error', error: root.error instanceof Error ? root.error.message : 'ProPresenter에 연결할 수 없습니다.' };
  if (state) return { status: 'connected', error: diagnostic instanceof Error ? diagnostic.message : null };
  return { status: 'connecting', error: null };
}

function samePosition(left: Awaited<ReturnType<ProPresenterClient['presentationPosition']>>, right: Awaited<ReturnType<ProPresenterClient['presentationPosition']>>): boolean {
  const a = left.presentation_index; const b = right.presentation_index;
  return a?.index === b?.index && a?.presentation_id?.uuid === b?.presentation_id?.uuid;
}

export async function readSnapshot(client: ProPresenterClient, revision: number, signal?: AbortSignal, onStatusDiagnostic?: (error: unknown | null) => void): Promise<CanonicalState> {
  // Position and playlist identity are required. Slide/layer status improves output
  // fidelity but must not make a healthy control session appear disconnected.
  const diagnostic = (error: unknown) => { if (signal?.aborted) throw error; onStatusDiagnostic?.(error); return null; };
  // One immediate retry resolves the common boundary case without composing
  // fields from different moments. If both samples move, report only the
  // final authoritative position; the next poll fills in its paired metadata.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const position = await client.presentationPosition(signal);
    const [activePlaylist, status, layers] = await Promise.all([
      client.activePlaylist(signal),
      client.slideStatus(signal).then((value) => { onStatusDiagnostic?.(null); return value; }).catch(diagnostic),
      client.layerStatus(signal).catch(diagnostic),
    ]);
    const verifiedPosition = await client.presentationPosition(signal);
    if (samePosition(position, verifiedPosition)) return normalizeCanonicalState({ revision, position, activePlaylist, status, layers });
    if (attempt === 1) {
      return normalizeCanonicalState({ revision, position: verifiedPosition, activePlaylist: { presentation: null, announcements: null } as typeof activePlaylist, status: null, layers: null });
    }
  }
  throw new Error('Unreachable canonical snapshot state');
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
  const playlist = useQuery({ queryKey: ['propresenter-session-active-playlist', base, root.data?.playlistId], queryFn: ({ signal }) => client.playlist(root.data!.playlistId!, signal), enabled: Boolean(root.data?.playlistId), retry: 1, retryDelay: 250, refetchInterval: 2_000 });
  const canonical = root.data ?? (accepted.current.base === base ? accepted.current.state : null);
  const state = useMemo(() => canonical ? enrichPlaylistContext(canonical, playlist.data ?? null) : null, [canonical, playlist.data]);
  const connection = connectionHealth(root, state, lastSuccessfulPollAt.current, Date.now(), statusDiagnostic.current);
  const commandTail = useRef<Promise<void>>(Promise.resolve()); const queuedCommands = useRef(0); const [pending, setPending] = useState(false); const [commandError, setCommandError] = useState<string | null>(null);
  const commands = useMemo<ProPresenterCommands>(() => {
    const run = async (command: () => Promise<void>) => {
      queuedCommands.current += 1; setPending(true);
      const execute = async () => {
        setCommandError(null);
        try {
          await command();
          // Wait for one post-command canonical read before releasing the next
          // queued command. This does not predict or confirm a target state;
          // ProPresenter still decides the resulting cue/item.
          await queryClient.refetchQueries({ queryKey: sessionKey(base), type: 'active' }).catch(() => undefined);
        } catch (error) {
          setCommandError(error instanceof Error ? error.message : 'ProPresenter 명령을 전달할 수 없습니다.');
          throw error;
        } finally {
          queuedCommands.current -= 1;
          setPending(queuedCommands.current > 0);
        }
      };
      const result = commandTail.current.then(execute, execute);
      commandTail.current = result.catch(() => undefined);
      return result;
    };
    return {
      pending, error: commandError, next: () => run(() => client.next()), previous: () => run(() => client.previous()),
      // This endpoint is expressly arrangement-aware, but only for the current active presentation.
      triggerPresentationCue: (cueIndex) => run(() => client.triggerActiveArrangementCue(cueIndex)),
      triggerPlaylistItem: (context) => run(() => client.triggerPlaylistItem(context.playlistId, context.playlistItemIndex)),
      triggerLibraryCue: (context, cueIndex) => run(() => client.triggerLibraryCue(context.libraryId, context.presentationId, cueIndex)),
      triggerActiveGroup: (groupIndex) => run(() => client.triggerActivePresentationGroup(String(groupIndex))), clearError: () => setCommandError(null),
    };
  }, [base, client, commandError, pending, queryClient]);
  const value = useMemo(() => ({ base, client, state, connection, commands }), [base, client, state, connection, commands]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useProPresenterSession(): ProPresenterSession { const session = useContext(SessionContext); if (!session) throw new Error('ProPresenterSessionProvider가 필요합니다.'); return session; }

export function usePlaylists() { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-playlists', base], queryFn: ({ signal }) => client.playlists(signal).then(normalizePlaylistTree), retry: 1, refetchInterval: 5_000 }); }
export function usePlaylistItems(playlistId: string | null, enabled = true) { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-playlist-items', base, playlistId], queryFn: ({ signal }) => client.playlist(playlistId!, signal).then(normalizePlaylistItems), enabled: enabled && Boolean(playlistId), retry: 1, refetchInterval: enabled ? 5_000 : false }); }
export function useLibraries() { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-libraries', base], queryFn: ({ signal }) => client.libraries(signal).then(normalizeLibraries), retry: 1, refetchInterval: 5_000 }); }
export function useLibraryItems(libraryId: string | null, enabled = true) { const { base, client } = useProPresenterSession(); return useQuery({ queryKey: ['propresenter-library-items', base, libraryId], queryFn: ({ signal }) => client.library(libraryId!, signal).then(normalizeLibraryItems), enabled: enabled && Boolean(libraryId), retry: 1, refetchInterval: enabled ? 5_000 : false }); }

export function usePresentationCues(context: PresentationContext | null | undefined, options: { enabled?: boolean } = {}) {
  const { base, client, state } = useProPresenterSession(); const activeArrangement = isCurrentContext(state, context); const readable = canReadArrangementCues(state, context);
  return useQuery({ queryKey: ['propresenter-presentation-cues', base, context?.cacheKey, activeArrangement ? 'active-arrangement' : readable ? 'presentation' : 'unavailable-arrangement'], queryFn: ({ signal }) => activeArrangement ? client.activePresentation(signal).then((response) => flattenSlides(response, 'active-arrangement')) : client.presentation(context!.presentationId!, signal).then((response) => flattenSlides(response, 'presentation')), enabled: Boolean(context?.presentationId) && readable && options.enabled !== false, retry: 1, refetchInterval: activeArrangement ? 1_500 : 5_000 });
}
export function useActivePresentationCues() {
  const { base, client, state } = useProPresenterSession(); const enabled = Boolean(state?.presentationId) && state?.outputLayers?.slide !== false;
  return useQuery({ queryKey: ['propresenter-active-presentation-cues', base, state?.presentationId, state?.playlistItem?.cacheKey ?? 'unscoped'], queryFn: ({ signal }) => client.activePresentation(signal).then((response) => flattenSlides(response, 'active-arrangement')), enabled, retry: 1, refetchInterval: 1_500 });
}
export function playlistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string { return `${base}/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`; }
export function activePlaylistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string { return `${base}/v1/playlist/active/presentation/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`; }
export function presentationThumbnailUrl(base: string, context: PresentationContext | null | undefined, cueIndex: number | null, quality: string): string | null { if (!context?.presentationId || cueIndex === null || cueIndex < 0) return null; return context.source === 'playlist' ? playlistThumbnailUrl(base, context, cueIndex, quality) : `${base}/v1/presentation/${encodeURIComponent(context.presentationId)}/thumbnail/${cueIndex}?quality=${quality}`; }
export function genericPresentationThumbnailUrl(base: string, presentationId: string | null, cueIndex: number | null, quality: string): string | null { return presentationId && cueIndex !== null && cueIndex >= 0 ? `${base}/v1/presentation/${encodeURIComponent(presentationId)}/thumbnail/${cueIndex}?quality=${quality}` : null; }
export { currentCueIndex, asArrangementCueIndex };
