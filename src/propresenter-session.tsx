import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CanonicalState,
  ConnectionSettings,
  PlaylistItemContext,
  PresentationContext,
  api,
  apiBase,
  currentCueIndex,
  executeCommand,
  fetchCanonicalState,
  flattenSlides,
  isCurrentContext,
  playlistItems,
  withPlaylistItemContext,
} from './propresenter';

const pollingInterval = 400;

type Connection = { status: 'connecting' | 'connected' | 'error'; error: string | null };

export type ProPresenterCommands = {
  pending: boolean;
  error: string | null;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  triggerPresentationCue: (presentationId: string, cueIndex: number) => Promise<void>;
  triggerPlaylistCue: (context: PlaylistItemContext, cueIndex: number) => Promise<void>;
  triggerLibraryCue: (libraryId: string, presentationId: string, cueIndex: number) => Promise<void>;
  clearError: () => void;
};

export type ProPresenterSession = {
  base: string;
  state: CanonicalState | null;
  connection: Connection;
  commands: ProPresenterCommands;
};

const SessionContext = createContext<ProPresenterSession | null>(null);

function sessionKey(base: string) { return ['propresenter-session', base] as const; }

function useSessionState(base: string) {
  const stateQuery = useQuery({
    queryKey: sessionKey(base),
    queryFn: ({ signal }) => fetchCanonicalState(base, signal),
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    retry: 1,
    retryDelay: 250,
  });
  const playlistQuery = useQuery({
    queryKey: ['propresenter-session-playlist', base, stateQuery.data?.playlistId],
    queryFn: ({ signal }) => api(base, `/v1/playlist/${encodeURIComponent(stateQuery.data?.playlistId as string)}?chunked=false`, signal).then(playlistItems),
    enabled: Boolean(stateQuery.data?.playlistId),
    retry: 1,
    retryDelay: 250,
  });
  const state = useMemo(() => stateQuery.data ? withPlaylistItemContext(stateQuery.data, playlistQuery.data || []) : null, [playlistQuery.data, stateQuery.data]);
  const connection: Connection = stateQuery.isError
    ? { status: 'error', error: (stateQuery.error as Error).message || 'ProPresenter에 연결할 수 없습니다.' }
    : state ? { status: 'connected', error: null }
      : { status: 'connecting', error: null };
  return { state, connection };
}

function createCommands(base: string, queryClient: QueryClient, stateRef: React.MutableRefObject<CanonicalState | null>, pendingRef: React.MutableRefObject<boolean>, setPending: (value: boolean) => void, setError: (value: string | null) => void): ProPresenterCommands {
  const refresh = () => queryClient.refetchQueries({ queryKey: sessionKey(base), type: 'active' });
  const run = async (path: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await executeCommand(() => api(base, path).then(() => undefined), refresh);
    } catch (reason) {
      setError((reason as Error).message || 'ProPresenter 명령을 전달할 수 없습니다.');
      throw reason;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return {
    pending: pendingRef.current,
    error: null,
    next: () => run('/v1/trigger/next'),
    previous: () => run('/v1/trigger/previous'),
    triggerPresentationCue: (presentationId, cueIndex) => run(`/v1/presentation/${encodeURIComponent(presentationId)}/${cueIndex}/trigger`),
    triggerPlaylistCue: (context, cueIndex) => {
      const current = stateRef.current;
      const activeArrangement = isCurrentContext(current, context);
      return run(activeArrangement
        ? `/v1/presentation/active/${cueIndex}/trigger`
        : `/v1/presentation/${encodeURIComponent(context.presentationId || '')}/${cueIndex}/trigger`);
    },
    triggerLibraryCue: (libraryId, presentationId, cueIndex) => run(`/v1/library/${encodeURIComponent(libraryId)}/${encodeURIComponent(presentationId)}/${cueIndex}/trigger`),
    clearError: () => setError(null),
  };
}

export function ProPresenterSessionProvider({ settings, children }: { settings: ConnectionSettings; children: React.ReactNode }) {
  const base = apiBase(settings);
  const queryClient = useQueryClient();
  const { state, connection } = useSessionState(base);
  const stateRef = useRef<CanonicalState | null>(null);
  stateRef.current = state;
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const commands = useMemo(() => {
    const commandApi = createCommands(base, queryClient, stateRef, pendingRef, setPending, setCommandError);
    return { ...commandApi, pending, error: commandError };
  }, [base, commandError, pending, queryClient]);
  const value = useMemo(() => ({ base, state, connection: commandError ? { status: 'error' as const, error: commandError } : connection, commands }), [base, commandError, commands, connection, state]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useProPresenterSession(): ProPresenterSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('ProPresenterSessionProvider가 필요합니다.');
  return session;
}

export function usePresentationCues(context: PresentationContext | null | undefined, options: { enabled?: boolean } = {}) {
  const { base, state } = useProPresenterSession();
  const activeArrangement = isCurrentContext(state, context);
  return useQuery({
    queryKey: ['propresenter-presentation-cues', base, context?.cacheKey, activeArrangement],
    queryFn: ({ signal }) => api(base, activeArrangement ? '/v1/presentation/active?chunked=false' : `/v1/presentation/${encodeURIComponent(context?.presentationId || '')}?chunked=false`, signal).then(flattenSlides),
    enabled: Boolean(context?.presentationId) && options.enabled !== false,
    retry: 1,
  });
}

export function playlistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string {
  return `${base}/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`;
}

export function presentationThumbnailUrl(base: string, context: PresentationContext | null | undefined, cueIndex: number, quality: string): string | null {
  if (!context?.presentationId || cueIndex < 0) return null;
  if (context.source === 'playlist') return playlistThumbnailUrl(base, context, cueIndex, quality);
  return `${base}/v1/presentation/${encodeURIComponent(context.presentationId)}/thumbnail/${cueIndex}?quality=${quality}`;
}

export function genericPresentationThumbnailUrl(base: string, presentationId: string | null, cueIndex: number, quality: string): string | null {
  return presentationId && cueIndex >= 0 ? `${base}/v1/presentation/${encodeURIComponent(presentationId)}/thumbnail/${cueIndex}?quality=${quality}` : null;
}
