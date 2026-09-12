import type {
  ActivePresentationResponse,
  LibrariesResponse,
  LibraryResponse,
  PlaylistActiveResponse,
  PlaylistResponse,
  PlaylistTreeResponse,
  PresentationPositionResponse,
  PresentationResponse,
  LayerStatusResponse,
  SlideStatusResponse,
} from './propresenter-client';

export type ConnectionSettings = { host: string; port: number };
export type PresentationCueIndex = number & { readonly __index: 'presentation-cue' };
export type ArrangementCueIndex = number & { readonly __index: 'arrangement-cue' };
export type PlaylistItemIndex = number & { readonly __index: 'playlist-item' };
export type PresentationGroupIndex = number & { readonly __index: 'presentation-group' };

const nonNegativeIndex = (value: number | null | undefined): number | null => Number.isInteger(value) && value >= 0 ? value : null;
export const asPresentationCueIndex = (value: number) => nonNegativeIndex(value) as PresentationCueIndex | null;
export const asArrangementCueIndex = (value: number) => nonNegativeIndex(value) as ArrangementCueIndex | null;
export const asPlaylistItemIndex = (value: number) => nonNegativeIndex(value) as PlaylistItemIndex | null;

export type Cue = { uuid: string | null; text: string; notes: string };
/** The active audience layers as reported by /v1/status/layers. */
export type OutputLayers = { videoInput: boolean; media: boolean; slide: boolean; announcements: boolean; props: boolean; messages: boolean; audio: boolean };
export type PlaylistItemKind = 'presentation' | 'placeholder' | 'header' | 'media' | 'audio' | 'livevideo';
export type PlaylistItemContext = {
  source: 'playlist'; playlistId: string; playlistName: string; playlistItemId: string; playlistItemIndex: PlaylistItemIndex;
  presentationId: string | null; arrangementName: string | null; kind: PlaylistItemKind; name: string; cacheKey: string;
};
export type LibraryPresentationContext = { source: 'library'; libraryId: string; presentationId: string; name: string; cacheKey: string };
/** A presentation currently live outside a playlist context (for example a direct Library trigger). */
export type ActivePresentationContext = { source: 'active'; presentationId: string; name: string; cacheKey: string };
export type PresentationContext = PlaylistItemContext | LibraryPresentationContext | ActivePresentationContext;

export type CanonicalState = {
  revision: number; observedAt: number;
  playlistId: string | null; playlistName: string | null; playlistItemId: string | null; playlistItemIndex: PlaylistItemIndex | null;
  presentationId: string | null; presentationName: string | null; arrangementName: string | null;
  /** Pair is read only from /v1/presentation/slide_index. */ slideIndex: ArrangementCueIndex | null;
  currentCue: Cue | null; nextCue: Cue | null;
  /** Avoids presenting a stale slide as the whole audience output when the slide layer is clear. */ outputLayers: OutputLayers | null;
  /** Playlist-scoped identity, including arrangement name, when its detail has loaded. */ playlistItem: PlaylistItemContext | null;
};
export type Playlist = { id: string; name: string; depth: number };
export type Library = { id: string; name: string };
export type PlaylistItem = { id: string | null; index: PlaylistItemIndex; name: string; type: PlaylistItemKind; presentationId: string | null; arrangementName: string | null };
export type LibraryPresentation = { id: string; name: string };
export type Slide = { cueIndex: PresentationCueIndex | ArrangementCueIndex; text: string; notes: string; label: string; groupName: string; groupKey: string; groupColor: string | null; groupIndex: PresentationGroupIndex };

export function acceptCanonicalSnapshot(previous: CanonicalState | null, candidate: CanonicalState): CanonicalState {
  return previous && candidate.revision < previous.revision ? previous : candidate;
}

const nameOf = (id: { name: string } | undefined, fallback: string) => id?.name || fallback;
const identifier = (id: { uuid: string; name: string; index: number } | undefined | null) => id?.uuid || null;
const cue = (value: SlideStatusResponse['current'] | undefined): Cue | null => value ? { uuid: value.uuid || null, text: value.text.trim(), notes: value.notes.trim() } : null;
function outputLayers(value: LayerStatusResponse | null): OutputLayers | null {
  return value ? { videoInput: value.video_input, media: value.media, slide: value.slide, announcements: value.announcements, props: value.props, messages: value.messages ?? false, audio: value.audio } : null;
}

/** The position pair is transport-authoritative; no active-presentation ID is merged into it. */
export function normalizeCanonicalState(input: { revision: number; position: PresentationPositionResponse; activePlaylist: PlaylistActiveResponse; status: SlideStatusResponse | null; layers?: LayerStatusResponse | null }): CanonicalState {
  const position = input.position.presentation_index ?? null;
  const active = input.activePlaylist.presentation;
  return {
    revision: input.revision, observedAt: Date.now(), playlistId: identifier(active?.playlist), playlistName: active?.playlist?.name ?? null,
    playlistItemId: identifier(active?.item), playlistItemIndex: asPlaylistItemIndex(active?.item?.index ?? -1),
    presentationId: position?.presentation_id?.uuid ?? null, presentationName: position?.presentation_id?.name ?? null,
    arrangementName: null, slideIndex: position ? asArrangementCueIndex(position.index) : null,
    currentCue: cue(input.status?.current), nextCue: cue(input.status?.next), outputLayers: outputLayers(input.layers ?? null), playlistItem: null,
  };
}

export function normalizePlaylistTree(response: PlaylistTreeResponse): Playlist[] {
  const result: Playlist[] = [];
  const walk = (nodes: PlaylistTreeResponse, depth: number) => nodes.forEach((node) => {
    const id = identifier(node.id); if (node.type === 'playlist' && id) result.push({ id, name: nameOf(node.id, '이름 없는 재생목록'), depth });
    if ('playlists' in node && node.playlists) walk(node.playlists, depth + 1);
  });
  walk(response, 0); return result;
}
export function normalizePlaylistItems(response: PlaylistResponse): PlaylistItem[] {
  return response.items.map((item) => ({ id: identifier(item.id), index: asPlaylistItemIndex(item.id.index)!, name: nameOf(item.id, '이름 없는 항목'), type: item.type, presentationId: item.presentation_info?.presentation_uuid ?? null, arrangementName: item.presentation_info?.arrangement_name ?? null }));
}
export function playlistItemContext(playlist: Pick<Playlist, 'id' | 'name'>, item: PlaylistItem): PlaylistItemContext | null {
  if (!item.id) return null;
  return { source: 'playlist', playlistId: playlist.id, playlistName: playlist.name, playlistItemId: item.id, playlistItemIndex: item.index, presentationId: item.presentationId, arrangementName: item.arrangementName, kind: item.type, name: item.name, cacheKey: `${playlist.id}:${item.id}:${item.index}:${item.presentationId ?? item.type}:${item.arrangementName ?? 'default'}` };
}
export function normalizeLibraries(response: LibrariesResponse): Library[] { return response.map((item) => ({ id: item.id.uuid, name: item.id.name })); }
export function normalizeLibraryItems(response: LibraryResponse): LibraryPresentation[] { return response.items.map((item) => ({ id: item.uuid, name: item.name })); }
export function libraryPresentationContext(libraryId: string, item: LibraryPresentation): LibraryPresentationContext { return { source: 'library', libraryId, presentationId: item.id, name: item.name, cacheKey: `${libraryId}:${item.id}` }; }
export function activePresentationContext(presentationId: string, name: string | null): ActivePresentationContext { return { source: 'active', presentationId, name: name || '현재 프레젠테이션', cacheKey: `active:${presentationId}` }; }
/** Keeps the active playlist presentation visible while its detail query is loading. */
export function activePlaylistPresentationContext(state: CanonicalState): PlaylistItemContext | null {
  if (state.outputLayers?.slide === false || !state.playlistId || !state.playlistItemId || state.playlistItemIndex === null || !state.presentationId) return null;
  const name = state.presentationName || '현재 프레젠테이션';
  return {
    source: 'playlist', playlistId: state.playlistId, playlistName: state.playlistName || '재생목록', playlistItemId: state.playlistItemId,
    playlistItemIndex: state.playlistItemIndex, presentationId: state.presentationId, arrangementName: state.arrangementName, kind: 'presentation', name,
    cacheKey: `${state.playlistId}:${state.playlistItemId}:${state.playlistItemIndex}:${state.presentationId}:${state.arrangementName || 'default'}`,
  };
}

export function enrichPlaylistContext(state: CanonicalState, response: PlaylistResponse | null): CanonicalState {
  if (!response || !state.playlistId || response.id.uuid !== state.playlistId || !state.playlistItemId) return state;
  const item = normalizePlaylistItems(response).find((candidate) => candidate.id === state.playlistItemId && candidate.index === state.playlistItemIndex);
  const context = item ? playlistItemContext({ id: response.id.uuid, name: response.id.name }, item) : null;
  // The active playlist endpoint and slide_index are separate wire reads. Do
  // not combine an item from one transition with a presentation from another.
  const coherent = context?.kind === 'presentation' && context.presentationId === state.presentationId ? context : null;
  return { ...state, arrangementName: coherent?.arrangementName ?? null, playlistItem: coherent };
}
export function isCurrentContext(state: CanonicalState | null | undefined, context: PresentationContext | null | undefined): boolean {
  if (!state || !context) return false;
  if (context.source === 'active') return state.presentationId === context.presentationId;
  if (context.source !== 'playlist') return state.playlistId === null && state.playlistItemId === null && state.presentationId === context.presentationId;
  return state.playlistId === context.playlistId && state.playlistItemId === context.playlistItemId && state.playlistItemIndex === context.playlistItemIndex && state.presentationId === context.presentationId;
}
export function currentCueIndex(state: CanonicalState | null | undefined, context: PresentationContext | null | undefined): ArrangementCueIndex | null { return isCurrentContext(state, context) ? state!.slideIndex : null; }
export function canTriggerPresentationCue(state: CanonicalState | null | undefined, context: PresentationContext): boolean { return context.source !== 'playlist' || isCurrentContext(state, context); }
export function activeGroupKey(slides: Slide[], cueIndex: ArrangementCueIndex | null): string | null {
  return cueIndex === null ? null : slides.find((slide) => slide.cueIndex === cueIndex)?.groupKey ?? null;
}

export function flattenSlides(response: PresentationResponse | ActivePresentationResponse, scope: 'presentation' | 'active-arrangement'): Slide[] {
  const candidate: unknown = response && typeof response === 'object' && 'presentation' in response ? response.presentation : response;
  if (!candidate || typeof candidate !== 'object' || !('groups' in candidate) || !Array.isArray(candidate.groups)) return [];
  const presentation = candidate as { groups: ReadonlyArray<{ name: string; color: unknown; slides: ReadonlyArray<{ text: string; notes: string; label: string }> }> };
  let cueIndex = 0;
  return presentation.groups.flatMap((group, groupNumber) => group.slides.map((slide) => ({ cueIndex: (scope === 'active-arrangement' ? asArrangementCueIndex : asPresentationCueIndex)(cueIndex++)!, text: slide.text, notes: slide.notes, label: slide.label, groupName: group.name, groupKey: `${groupNumber}:${group.name}`, groupColor: normalizeGroupColor(group.color), groupIndex: groupNumber as PresentationGroupIndex })));
}
export function slideText(slide?: Slide): string { return slide?.text.replace(/\s+/g, ' ').trim() ?? ''; }
export function groupStarts(slides: Slide[]): Array<{ key: string; name: string; index: PresentationGroupIndex; cueIndex: ArrangementCueIndex }> { return slides.reduce<Array<{ key: string; name: string; index: PresentationGroupIndex; cueIndex: ArrangementCueIndex }>>((all, slide) => all.some((group) => group.key === slide.groupKey) ? all : [...all, { key: slide.groupKey, name: slide.groupName || `그룹 ${all.length + 1}`, index: slide.groupIndex, cueIndex: slide.cueIndex as ArrangementCueIndex }], []); }
export function normalizeGroupColor(value: unknown): string | null { if (!value || typeof value !== 'object') return null; const color = value as { red?: number; green?: number; blue?: number; alpha?: number }; if (![color.red, color.green, color.blue].every((component) => typeof component === 'number')) return null; const scale = Math.max(color.red!, color.green!, color.blue!) <= 1 ? 255 : 1; return `rgba(${Math.round(color.red! * scale)}, ${Math.round(color.green! * scale)}, ${Math.round(color.blue! * scale)}, ${Math.max(0, Math.min(1, color.alpha ?? 1))})`; }
export function remoteDisplayMode(mode: 'text' | 'preview' | 'auto', current: Cue | null): 'text' | 'preview' { return mode === 'auto' ? (current?.text ? 'text' : 'preview') : mode; }
