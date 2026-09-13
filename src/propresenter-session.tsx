import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBase, ProPresenterApiError, ProPresenterClient } from './propresenter-client';
import {
  CanonicalState, ConnectionSettings, LibraryPresentationContext, PlaylistItemContext, PresentationCueTarget, PresentationGroupIndex, ActivePresentationContext, PresentationContext, Slide,
  acceptCanonicalSnapshot, asArrangementCueIndex, cueContentKey, currentCueIndex, enrichPlaylistContext, flattenSlides, isActivePlaylistContext, isCurrentContext, normalizeCanonicalState, presentationIdOf,
  normalizeLibraries, normalizeLibraryItems, normalizePlaylistItems, normalizePlaylistTree,
} from './propresenter';

const POLLING_INTERVAL_MS = 400;
export type Connection = { status: 'connecting' | 'connected' | 'error'; error: string | null };
export type ProPresenterCommands = {
  pending: boolean; error: string | null; next: () => Promise<void>; previous: () => Promise<void>;
  triggerPresentationCue: (context: ActivePresentationContext, target: PresentationCueTarget) => Promise<void>;
  triggerPlaylistCue: (context: PlaylistItemContext, target: PresentationCueTarget) => Promise<void>;
  triggerPlaylistItem: (context: PlaylistItemContext) => Promise<void>;
  triggerLibraryCue: (context: LibraryPresentationContext, cueIndex: number) => Promise<void>;
  triggerActiveGroup: (groupIndex: PresentationGroupIndex) => Promise<void>; clearError: () => void;
};
export type ProPresenterSession = { base: string; client: ProPresenterClient; state: CanonicalState | null; connection: Connection; commands: ProPresenterCommands };
const SessionContext = createContext<ProPresenterSession | null>(null);
const sessionKey = (base: string) => ['propresenter-session', base] as const;
const HEALTH_GRACE_MS = 5_000;
const PLAYLIST_TRANSITION_TIMEOUT_MS = 5_000;
const ACTIVE_ARRANGEMENT_TIMEOUT_MS = 5_000;
const ACTIVE_ARRANGEMENT_BASELINE_TIMEOUT_MS = 1_000;

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

function commandFailure(message: string, path: string): ProPresenterApiError {
  return new ProPresenterApiError(message, path, null, 'command');
}

function canonicalPlaylistContextMatches(state: CanonicalState | null | undefined, context: PlaylistItemContext): boolean {
  return Boolean(state
    && state.playlistId === context.playlistId
    && state.playlistItemId === context.playlistItemId
    && state.playlistItemIndex === context.playlistItemIndex
    && state.presentationId === context.presentationId);
}

type CueResolution =
  | { status: 'matched'; cueIndex: number }
  | { status: 'not-found' }
  | { status: 'ambiguous' };

function neighborMatches(target: PresentationCueTarget, slide: Slide): boolean {
  let hasNeighbor = false;
  if (target.previousCueKey !== null) {
    hasNeighbor = true;
    if (slide.previousCueKey !== target.previousCueKey) return false;
  }
  if (target.nextCueKey !== null) {
    hasNeighbor = true;
    if (slide.nextCueKey !== target.nextCueKey) return false;
  }
  return hasNeighbor;
}

/**
 * A runtime may omit the active presentation UUID. In that case the payload
 * itself is only useful as transition evidence when it is stable and differs
 * from the arrangement observed before activating the playlist item.
 */
function arrangementFingerprint(slides: Slide[]): string {
  return JSON.stringify(slides.map((slide) => [
    slide.cueUuid,
    slide.groupName,
    slide.groupOccurrence,
    slide.slideOffset,
    cueContentKey(slide),
    slide.previousCueKey,
    slide.nextCueKey,
  ]));
}

async function readActiveArrangementBaseline(client: ProPresenterClient): Promise<string> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), ACTIVE_ARRANGEMENT_BASELINE_TIMEOUT_MS);
  try {
    const response = await client.activePresentation(controller.signal);
    return arrangementFingerprint(flattenSlides(response, 'active-arrangement'));
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

/**
 * Re-identifies a cue in the selected active arrangement without assuming
 * that the generic presentation order and arrangement order are identical.
 * A numeric source index is only a final, content-validated fallback for an
 * item with no explicit arrangement. Duplicate content remains ambiguous
 * unless its structure or optional runtime UUID disambiguates it.
 */
export function resolveActiveCueIndex(context: PlaylistItemContext, target: PresentationCueTarget, slides: Slide[]): CueResolution {
  if (target.cueUuid) {
    const uuidMatches = slides.filter((slide) => slide.cueUuid === target.cueUuid);
    if (uuidMatches.length === 1) return { status: 'matched', cueIndex: uuidMatches[0].cueIndex };
    if (uuidMatches.length > 1) return { status: 'ambiguous' };
    // If the active response carries cue UUIDs, a different UUID is stronger
    // evidence than a coincidentally equal text/label.
    if (slides.some((slide) => slide.cueUuid !== null)) return { status: 'not-found' };
  }

  const targetContent = cueContentKey(target);
  const sameGroup = slides.filter((slide) => slide.groupName === target.groupName && slide.groupOccurrence === target.groupOccurrence);
  const structuralContent = sameGroup.filter((slide) => cueContentKey(slide) === targetContent);
  if (structuralContent.length === 1) return { status: 'matched', cueIndex: structuralContent[0].cueIndex };
  if (structuralContent.length > 1) {
    const byNeighbors = structuralContent.filter((slide) => neighborMatches(target, slide));
    if (byNeighbors.length === 1) return { status: 'matched', cueIndex: byNeighbors[0].cueIndex };
    const byOffset = structuralContent.filter((slide) => slide.slideOffset === target.slideOffset);
    if (byOffset.length === 1) return { status: 'matched', cueIndex: byOffset[0].cueIndex };
    return { status: 'ambiguous' };
  }

  // A repeated group name's occurrence can change when same-named groups are
  // reordered by an arrangement. If the cue content is unique among that
  // group name, it remains a safe group-scoped match without trusting the
  // numeric group index or the old occurrence.
  const sameGroupNameContent = slides.filter((slide) => slide.groupName === target.groupName && cueContentKey(slide) === targetContent);
  if (sameGroupNameContent.length === 1) return { status: 'matched', cueIndex: sameGroupNameContent[0].cueIndex };
  if (sameGroupNameContent.length > 1) {
    const byNeighbors = sameGroupNameContent.filter((slide) => neighborMatches(target, slide));
    if (byNeighbors.length === 1) return { status: 'matched', cueIndex: byNeighbors[0].cueIndex };
    const byOffset = sameGroupNameContent.filter((slide) => slide.slideOffset === target.slideOffset);
    if (byOffset.length === 1) return { status: 'matched', cueIndex: byOffset[0].cueIndex };
    return { status: 'ambiguous' };
  }

  // If the group moved or was renamed, a unique global content match remains
  // safe. Duplicate global content is deliberately not resolved by first
  // match, especially when a same-named group was present in the source.
  const contentMatches = slides.filter((slide) => cueContentKey(slide) === targetContent);
  if (contentMatches.length === 1) return { status: 'matched', cueIndex: contentMatches[0].cueIndex };
  if (contentMatches.length > 1 && sameGroupNameContent.length === 0 && sameGroup.length === 0) {
    const byNeighbors = contentMatches.filter((slide) => neighborMatches(target, slide));
    if (byNeighbors.length === 1) return { status: 'matched', cueIndex: byNeighbors[0].cueIndex };
    return { status: 'ambiguous' };
  }

  // An item without a named arrangement uses the ordinary presentation order.
  // Still require exact content at that position; never trust the number alone.
  if (context.arrangementName === null) {
    const positional = slides.find((slide) => Number(slide.cueIndex) === Number(target.cueIndex));
    if (positional && cueContentKey(positional) === targetContent) return { status: 'matched', cueIndex: positional.cueIndex };
  }
  return { status: 'not-found' };
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
  const latestState = useRef<CanonicalState | null>(null);
  latestState.current = state;
  const commandTail = useRef<Promise<void>>(Promise.resolve()); const commandReconciliation = useRef<Promise<void> | null>(null); const reconciliationQueued = useRef(false); const queuedCommands = useRef(0); const [pending, setPending] = useState(false); const [commandError, setCommandError] = useState<string | null>(null);
  const commands = useMemo<ProPresenterCommands>(() => {
    const scheduleReconciliation = () => {
      if (commandReconciliation.current) {
        // A read already in flight may observe an intermediate device state.
        // Remember the later command so a final read is started when it ends.
        reconciliationQueued.current = true;
        return;
      }
      const task = queryClient.refetchQueries({ queryKey: sessionKey(base), type: 'active' }).catch(() => undefined);
      const tracked = task.finally(() => {
        if (commandReconciliation.current !== tracked) return;
        commandReconciliation.current = null;
        if (reconciliationQueued.current) {
          reconciliationQueued.current = false;
          scheduleReconciliation();
        }
      });
      commandReconciliation.current = tracked;
    };
    const run = async (command: () => Promise<void>) => {
      queuedCommands.current += 1; setPending(true);
      const execute = async () => {
        setCommandError(null);
        try {
          await command();
          // Keep the HTTP command queue FIFO, but do not make the next input
          // wait for the complete canonical read. ProPresenter remains the
          // source of truth; this coalesced read reconciles the UI in the
          // background without inventing a target state.
          scheduleReconciliation();
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
    const waitForPlaylistContext = (context: PlaylistItemContext): Promise<CanonicalState> => {
      const current = queryClient.getQueryData<CanonicalState>(sessionKey(base)) ?? latestState.current;
      if (canonicalPlaylistContextMatches(current, context)) return Promise.resolve(current!);
      return new Promise<CanonicalState>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (timeout) globalThis.clearTimeout(timeout);
          unsubscribe();
          callback();
        };
        const unsubscribe = queryClient.getQueryCache().subscribe(() => {
          const candidate = queryClient.getQueryData<CanonicalState>(sessionKey(base));
          if (canonicalPlaylistContextMatches(candidate, context)) finish(() => resolve(candidate!));
        });
        timeout = globalThis.setTimeout(() => finish(() => reject(commandFailure(
          '재생목록 항목 전환을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
          `/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/trigger`,
        ))), PLAYLIST_TRANSITION_TIMEOUT_MS);
        // Trigger one immediate canonical read. The normal 400ms poll remains
        // the fallback, while the cache subscription above accepts whichever
        // authoritative snapshot arrives first.
        void queryClient.refetchQueries({ queryKey: sessionKey(base), type: 'active' }).catch(() => undefined);
        const candidate = queryClient.getQueryData<CanonicalState>(sessionKey(base));
        if (canonicalPlaylistContextMatches(candidate, context)) finish(() => resolve(candidate!));
      });
    };
    const triggerPlaylistCue = async (context: PlaylistItemContext, target: PresentationCueTarget) => {
      if (!context.presentationId) throw commandFailure('프레젠테이션이 아닌 재생목록 항목은 cue를 실행할 수 없습니다.', `/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/trigger`);
      const cachedState = queryClient.getQueryData<CanonicalState>(sessionKey(base));
      const alreadyActive = isActivePlaylistContext(latestState.current, context) || canonicalPlaylistContextMatches(cachedState, context);
      let baselineFingerprint: string | null = null;
      if (!alreadyActive) {
        // Capture the arrangement before the playlist transition. This is the
        // only safe way to reject a UUID-less stale payload that happens to
        // contain the same text as the requested cue.
        try {
          baselineFingerprint = await readActiveArrangementBaseline(client);
        } catch {
          // A missing baseline is deliberately conservative: an ID-less
          // payload after activation will not be trusted without it.
        }
        await client.triggerPlaylistItem(context.playlistId, context.playlistItemIndex);
        await waitForPlaylistContext(context);
      }
      const deadline = Date.now() + ACTIVE_ARRANGEMENT_TIMEOUT_MS;
      let cueIndex: number | null = null;
      let unknownFingerprint: string | null = null;
      let unknownStableReads = 0;
      while (Date.now() < deadline && cueIndex === null) {
        const remaining = Math.max(1, deadline - Date.now());
        const abortController = new AbortController();
        const timeout = globalThis.setTimeout(() => abortController.abort(), remaining);
        try {
          const activePresentation = await client.activePresentation(abortController.signal);
          const activeSlides = flattenSlides(activePresentation, 'active-arrangement');
          const activeId = presentationIdOf(activePresentation);
          if (activeId && activeId !== context.presentationId) {
            // The playlist item transition has been observed, but the active
            // presentation endpoint is still one state behind. Do not resolve
            // a cue against the old presentation.
            unknownFingerprint = null;
            unknownStableReads = 0;
          } else if (activeId === null && !alreadyActive) {
            if (baselineFingerprint === null) {
              // Without a pre-transition baseline there is no evidence that
              // this ID-less payload is the newly activated item. Never turn
              // a coincidental cue match into a live trigger.
              unknownFingerprint = null;
              unknownStableReads = 0;
            } else {
              const fingerprint = arrangementFingerprint(activeSlides);
              if (fingerprint === baselineFingerprint) {
                // This is still the pre-transition arrangement. Even a unique
                // cue match is unsafe until the active payload changes.
                unknownFingerprint = null;
                unknownStableReads = 0;
              } else {
                if (unknownFingerprint === fingerprint) unknownStableReads += 1;
                else {
                  unknownFingerprint = fingerprint;
                  unknownStableReads = 1;
                }
                // Require two consecutive post-transition payloads. A single
                // changed response can still be an in-flight transition.
                if (unknownStableReads >= 2) {
                  const resolution = resolveActiveCueIndex(context, target, activeSlides);
                  if (resolution.status === 'matched') cueIndex = resolution.cueIndex;
                  else if (resolution.status === 'ambiguous') {
                    throw commandFailure('활성 arrangement에서 선택한 cue를 하나로 식별할 수 없습니다.', '/v1/presentation/active/{index}/trigger');
                  } else {
                    throw commandFailure('선택한 cue를 현재 활성 arrangement에서 안전하게 식별할 수 없습니다.', '/v1/presentation/active/{index}/trigger');
                  }
                }
              }
            }
          } else {
            const resolution = resolveActiveCueIndex(context, target, activeSlides);
            if (resolution.status === 'matched') cueIndex = resolution.cueIndex;
            else if (resolution.status === 'ambiguous') {
              throw commandFailure('활성 arrangement에서 선택한 cue를 하나로 식별할 수 없습니다.', '/v1/presentation/active/{index}/trigger');
            } else if (activeId === context.presentationId || activeId === null) {
              throw commandFailure('선택한 cue를 현재 활성 arrangement에서 안전하게 식별할 수 없습니다.', '/v1/presentation/active/{index}/trigger');
            }
          }
        } catch (error) {
          if (Date.now() >= deadline) break;
          throw error;
        } finally {
          globalThis.clearTimeout(timeout);
        }
        if (cueIndex === null && Date.now() < deadline) await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(100, deadline - Date.now())));
      }
      if (cueIndex === null) throw commandFailure('선택한 cue를 현재 활성 arrangement에서 안전하게 식별할 수 없습니다.', '/v1/presentation/active/{index}/trigger');
      // This endpoint takes an arrangement cue index. The playlist-scoped
      // endpoint takes a playlist item index and must not be used here.
      await client.triggerActiveArrangementCue(cueIndex);
    };
    return {
      pending, error: commandError, next: () => run(() => client.next()), previous: () => run(() => client.previous()),
      triggerPresentationCue: (context, target) => run(async () => {
        if (!isCurrentContext(latestState.current, context)) throw commandFailure('현재 출력과 다른 presentation의 cue는 실행할 수 없습니다.', `/v1/presentation/active/${target.cueIndex}/trigger`);
        await client.triggerActiveArrangementCue(target.cueIndex);
      }),
      triggerPlaylistCue: (context, target) => run(() => triggerPlaylistCue(context, target)),
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
  const { base, client, state } = useProPresenterSession(); const activeArrangement = isCurrentContext(state, context);
  return useQuery({ queryKey: ['propresenter-presentation-cues', base, context?.cacheKey, activeArrangement ? 'active-arrangement' : 'presentation'], queryFn: ({ signal }) => activeArrangement ? client.activePresentation(signal).then((response) => flattenSlides(response, 'active-arrangement')) : client.presentation(context!.presentationId!, signal).then((response) => flattenSlides(response, 'presentation')), enabled: Boolean(context?.presentationId) && options.enabled !== false, placeholderData: (previousData) => previousData, retry: 1, refetchInterval: activeArrangement ? 1_500 : 5_000 });
}
export function useActivePresentationCues() {
  const { base, client, state } = useProPresenterSession(); const enabled = Boolean(state?.presentationId) && state?.outputLayers?.slide !== false;
  return useQuery({ queryKey: ['propresenter-active-presentation-cues', base, state?.presentationId, state?.playlistItem?.cacheKey ?? 'unscoped'], queryFn: ({ signal }) => client.activePresentation(signal).then((response) => flattenSlides(response, 'active-arrangement')), enabled, placeholderData: (previousData) => previousData, retry: 1, refetchInterval: 1_500 });
}
export function playlistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string { return `${base}/v1/playlist/${encodeURIComponent(context.playlistId)}/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`; }
export function activePlaylistThumbnailUrl(base: string, context: PlaylistItemContext, cueIndex: number, quality: string): string { return `${base}/v1/playlist/active/presentation/${context.playlistItemIndex}/thumbnail/${cueIndex}?quality=${quality}`; }
export function presentationThumbnailUrl(base: string, context: PresentationContext | null | undefined, cueIndex: number | null, quality: string): string | null { if (!context?.presentationId || cueIndex === null || cueIndex < 0) return null; return context.source === 'playlist' ? playlistThumbnailUrl(base, context, cueIndex, quality) : `${base}/v1/presentation/${encodeURIComponent(context.presentationId)}/thumbnail/${cueIndex}?quality=${quality}`; }
export function genericPresentationThumbnailUrl(base: string, presentationId: string | null, cueIndex: number | null, quality: string): string | null { return presentationId && cueIndex !== null && cueIndex >= 0 ? `${base}/v1/presentation/${encodeURIComponent(presentationId)}/thumbnail/${cueIndex}?quality=${quality}` : null; }
export { currentCueIndex, asArrangementCueIndex };
