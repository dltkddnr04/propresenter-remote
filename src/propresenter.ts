export type ApiObject = Record<string, any>;

export type ConnectionSettings = { host: string; port: number };

export type Cue = { uuid: string | null; text: string; notes: string };

export type PlaylistItemContext = {
  source: 'playlist';
  playlistId: string;
  playlistItemId: string;
  playlistItemIndex: number;
  presentationId: string | null;
  arrangementId: string | null;
  kind: string;
  name: string;
  cacheKey: string;
};

export type LibraryPresentationContext = {
  source: 'library';
  libraryId: string;
  presentationId: string;
  name: string;
  cacheKey: string;
};

export type PresentationContext = PlaylistItemContext | LibraryPresentationContext;

export type CanonicalState = {
  playlistId: string | null;
  playlistItemId: string | null;
  playlistItemIndex: number | null;
  presentationId: string | null;
  slideIndex: number;
  currentCue: Cue | null;
  nextCue: Cue | null;
  playlistItem: PlaylistItemContext | null;
};

export type Slide = ApiObject & { groupName: string; groupKey: string; groupColor: string | null; flatIndex: number };

const requestTimeoutMs = 2_500;

export function isNativeProxy(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => {
    const [name, ...value] = part.trim().split('=');
    return name === 'propresenter-native' && value.join('=') === '1';
  });
}

export function apiBase(settings: ConnectionSettings): string {
  return isNativeProxy() ? '' : `http://${settings.host}:${settings.port}`;
}

export async function api(base: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = globalThis.setTimeout(abort, requestTimeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function unwrap(value: unknown): unknown { return (value as ApiObject)?.data ?? value; }

export function listArray(value: unknown): ApiObject[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const object = value as ApiObject;
  for (const key of ['data', 'items', 'playlist_items', 'contents', 'children', 'playlists', 'libraries', 'library', 'presentations']) {
    if (Array.isArray(object[key])) return object[key];
    if (object[key] && typeof object[key] === 'object') {
      const nested = listArray(object[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (!value || typeof value !== 'object') return null;
  const object = value as ApiObject;
  return identifier(object.uuid) || identifier(object.id) || null;
}

function indexValue(value: unknown): number | null {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function objectId(value?: ApiObject): string | null {
  if (!value) return null;
  return identifier(value.id) || identifier(value.uuid) || identifier(value.playlist_id) || identifier(value.presentation_info?.presentation_uuid) || null;
}

export function objectName(value?: ApiObject, fallback = '이름 없는 항목'): string {
  return value?.id?.name || value?.name || value?.title || value?.playlist_id?.name || value?.presentation_info?.name || fallback;
}

export function playlistItemId(item?: ApiObject): string | null {
  if (!item) return null;
  return identifier(item.id) || identifier(item.uuid) || identifier(item.playlist_item_id) || null;
}

export function presentationUuid(item?: ApiObject): string | null {
  if (!item) return null;
  return identifier(item.presentation_info?.presentation_uuid) || identifier(item.presentation_info?.presentation_id) || identifier(item.presentation?.id) || identifier(item.presentation_id) || null;
}

function arrangementUuid(item?: ApiObject): string | null {
  if (!item) return null;
  return identifier(item.presentation_info?.arrangement_uuid) || identifier(item.presentation_info?.arrangement_id) || identifier(item.presentation_info?.arrangement) || identifier(item.arrangement_uuid) || identifier(item.arrangement_id) || identifier(item.arrangement) || null;
}

export function playlistItems(data: unknown): ApiObject[] {
  const object = unwrap(data) as ApiObject;
  return object?.playlist?.items || listArray(object);
}

export function playlistItemContext(playlistId: string, item: ApiObject, fallbackIndex: number): PlaylistItemContext | null {
  const id = playlistItemId(item);
  if (!id) return null;
  const itemIndex = indexValue(item.index) ?? fallbackIndex;
  const presentationId = presentationUuid(item);
  const arrangementId = arrangementUuid(item);
  return {
    source: 'playlist', playlistId, playlistItemId: id, playlistItemIndex: itemIndex, presentationId, arrangementId,
    kind: String(item.type || item.presentation_info?.type || 'unknown'), name: objectName(item),
    cacheKey: [playlistId, id, arrangementId || 'default', presentationId || item.type || 'item'].join(':'),
  };
}

export function libraryPresentationContext(libraryId: string, item: ApiObject): LibraryPresentationContext | null {
  const presentationId = presentationUuid(item) || objectId(item);
  if (!presentationId) return null;
  return { source: 'library', libraryId, presentationId, name: objectName(item), cacheKey: [libraryId, presentationId].join(':') };
}

export function parsePlaylistActive(data: unknown): Pick<CanonicalState, 'playlistId' | 'playlistItemId' | 'playlistItemIndex'> {
  const value = unwrap(data) as ApiObject;
  const presentation = value?.presentation || value;
  const item = presentation?.item || value?.item;
  return {
    playlistId: identifier(presentation?.playlist?.uuid) || identifier(value?.playlist?.uuid) || identifier(value?.playlist),
    playlistItemId: identifier(item?.uuid) || identifier(item?.id) || null,
    playlistItemIndex: indexValue(item?.index),
  };
}

export function parsePresentationPosition(data: unknown): Pick<CanonicalState, 'presentationId' | 'slideIndex'> {
  const object = unwrap(data) as ApiObject;
  const position = object?.presentation_index || object?.slide_index || object;
  return {
    presentationId: identifier(position?.presentation_id) || identifier(position?.presentation?.id) || null,
    slideIndex: indexValue(position?.index ?? object?.index ?? object?.slide_index?.index) ?? -1,
  };
}

export function activePresentationId(data: unknown): string | null {
  const object = unwrap(data) as ApiObject;
  return identifier(object?.presentation?.id) || identifier(object?.presentation?.item) || identifier(object?.presentation?.uuid) || identifier(object?.id) || identifier(object?.uuid) || null;
}

function parseCue(value: unknown): Cue | null {
  if (!value || typeof value !== 'object') return null;
  const cue = value as ApiObject;
  return { uuid: identifier(cue.uuid) || identifier(cue.id) || null, text: String(cue.text || '').replace(/\s+/g, ' ').trim(), notes: String(cue.notes || '').trim() };
}

export function parseStatusCues(data: unknown): Pick<CanonicalState, 'currentCue' | 'nextCue'> {
  const value = unwrap(data) as ApiObject;
  const source = value?.slide || value?.data || value;
  return { currentCue: parseCue(source?.current), nextCue: parseCue(source?.next) };
}

export async function fetchCanonicalState(base: string, signal?: AbortSignal): Promise<CanonicalState> {
  const [positionData, playlistData, statusData] = await Promise.all([
    api(base, '/v1/presentation/slide_index?chunked=false', signal),
    api(base, '/v1/playlist/active?chunked=false', signal),
    api(base, '/v1/status/slide?chunked=false', signal).catch(() => null),
  ]);
  const position = parsePresentationPosition(positionData);
  const presentationId = position.presentationId || activePresentationId(await api(base, '/v1/presentation/active?chunked=false', signal));
  return { ...parsePlaylistActive(playlistData), presentationId, slideIndex: position.slideIndex, ...parseStatusCues(statusData), playlistItem: null };
}

export async function executeCommand<T>(send: () => Promise<void>, refresh: () => Promise<T>): Promise<T> {
  await send();
  return refresh();
}

export function withPlaylistItemContext(state: CanonicalState, items: ApiObject[]): CanonicalState {
  if (!state.playlistId || !state.playlistItemId) return state;
  const index = items.findIndex((item) => playlistItemId(item) === state.playlistItemId);
  return { ...state, playlistItem: index >= 0 ? playlistItemContext(state.playlistId, items[index], index) : null };
}

export function isCurrentContext(state: CanonicalState | null | undefined, context: PresentationContext | null | undefined): boolean {
  if (!state || !context || !context.presentationId || state.presentationId !== context.presentationId) return false;
  return context.source === 'library' || (state.playlistId === context.playlistId && state.playlistItemId === context.playlistItemId);
}

export function currentCueIndex(state: CanonicalState | null | undefined, context: PresentationContext | null | undefined): number {
  return isCurrentContext(state, context) ? state!.slideIndex : -1;
}

export function flattenSlides(data: unknown): Slide[] {
  const presentation = (unwrap(data) as ApiObject)?.presentation || unwrap(data) as ApiObject;
  return (presentation?.groups || []).flatMap((group: ApiObject, groupIndex: number) =>
    (group.slides || []).map((slide: ApiObject) => ({ ...slide, groupName: group.name || '', groupKey: identifier(group.uuid) || identifier(group.id) || `group-${groupIndex}`, groupColor: normalizeGroupColor(group.groupColor || group.group_color || group.color), flatIndex: 0 })),
  ).map((slide: Slide, index: number) => ({ ...slide, flatIndex: index }));
}

export function slideText(slide?: Slide): string { return String(slide?.text || '').replace(/\s+/g, ' ').trim(); }

export function normalizeGroupColor(value: unknown): string | null {
  if (typeof value === 'string') {
    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      const [red, green, blue] = parts;
      const alpha = Number.isFinite(parts[3]) ? parts[3] : 1;
      const scale = Math.max(red, green, blue) <= 1 ? 255 : 1;
      return `rgba(${Math.round(red * scale)}, ${Math.round(green * scale)}, ${Math.round(blue * scale)}, ${Math.max(0, Math.min(1, alpha))})`;
    }
    return value.trim() || null;
  }
  if (!value || typeof value !== 'object') return null;
  const color = value as ApiObject;
  const red = Number(color.red ?? color.r); const green = Number(color.green ?? color.g); const blue = Number(color.blue ?? color.b);
  if (![red, green, blue].every(Number.isFinite)) return null;
  const alpha = Number(color.alpha ?? color.a ?? 1); const scale = Math.max(red, green, blue) <= 1 ? 255 : 1;
  return `rgba(${Math.round(red * scale)}, ${Math.round(green * scale)}, ${Math.round(blue * scale)}, ${Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))})`;
}

export function groupStarts(slides: Slide[]): Array<{ key: string; name: string; index: number }> {
  return slides.reduce<Array<{ key: string; name: string; index: number }>>((all, slide, index) => all.some((group) => group.key === slide.groupKey) ? all : [...all, { key: slide.groupKey, name: slide.groupName || `그룹 ${all.length + 1}`, index }], []);
}

export function remoteDisplayMode(mode: 'text' | 'preview' | 'auto', cue: Cue | null): 'text' | 'preview' {
  return mode === 'auto' ? (cue?.text ? 'text' : 'preview') : mode;
}
