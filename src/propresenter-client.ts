import type { paths } from './generated/propresenter-api';

export type ConnectionSettings = { host: string; port: number };
export type PlaylistTreeResponse = paths['/v1/playlists']['get']['responses'][200]['content']['application/json'];
export type PlaylistResponse = paths['/v1/playlist/{playlist_id}']['get']['responses'][200]['content']['application/json'];
export type PlaylistActiveResponse = paths['/v1/playlist/active']['get']['responses'][200]['content']['application/json'];
export type PresentationPositionResponse = paths['/v1/presentation/slide_index']['get']['responses'][200]['content']['application/json'];
export type ActivePresentationResponse = paths['/v1/presentation/active']['get']['responses'][200]['content']['application/json'];
export type PresentationResponse = paths['/v1/presentation/{uuid}']['get']['responses'][200]['content']['application/json'];
export type SlideStatusResponse = paths['/v1/status/slide']['get']['responses'][200]['content']['application/json'];
export type LibrariesResponse = paths['/v1/libraries']['get']['responses'][200]['content']['application/json'];
export type LibraryResponse = paths['/v1/library/{library_id}']['get']['responses'][200]['content']['application/json'];

const REQUEST_TIMEOUT_MS = 2_500;

export class ProPresenterApiError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly status: number | null = null,
    readonly kind: 'network' | 'http' | 'decode' = 'network',
  ) {
    super(message);
    this.name = 'ProPresenterApiError';
  }
}

type JsonObject = { readonly [key: string]: unknown };
type FocusedItem = { readonly uuid: string; readonly name: string; readonly index: number };

class RuntimeDecodeError extends Error {
  constructor(readonly wrapperKey: string | null = null) {
    super('Unsupported ProPresenter response shape');
    this.name = 'RuntimeDecodeError';
  }
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function rootShape(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function rootKeys(value: unknown): string {
  if (!isObject(value)) return 'none';
  const keys = Object.keys(value);
  return keys.length ? keys.join(', ') : 'none';
}

function rejectShape(wrapperKey?: string): never {
  throw new RuntimeDecodeError(wrapperKey ?? null);
}

function isIdentifier(value: unknown, allowNullUuid = false): value is { readonly uuid: string | null; readonly name: string; readonly index: number } {
  if (!isObject(value) || typeof value.name !== 'string' || !isFiniteNumber(value.index)) return false;
  return typeof value.uuid === 'string' || (allowNullUuid && value.uuid === null);
}

function isPlaylistNode(value: unknown): value is JsonObject {
  if (!isObject(value) || !isIdentifier(value.id) || (value.type !== 'playlist' && value.type !== 'group')) return false;
  if (has(value, 'playlists') && !Array.isArray(value.playlists)) return false;
  return value.type === 'playlist' || Array.isArray(value.playlists);
}

function isPlaylistTree(value: unknown): value is PlaylistTreeResponse {
  if (!Array.isArray(value)) return false;
  // Walk only the OpenAPI playlist-tree edge. This deliberately does not
  // search arbitrary nested arrays for something that happens to look like a
  // playlist.
  const pending: unknown[] = [...value];
  while (pending.length) {
    const node = pending.pop();
    if (!isPlaylistNode(node)) return false;
    if (Array.isArray(node.playlists)) pending.push(...node.playlists);
  }
  return true;
}

const runtimePlaylistFieldTypes: Readonly<Record<string, 'playlist' | 'group'>> = {
  playlist: 'playlist',
  group: 'group',
};

function normalizeRuntimePlaylistNode(value: unknown): JsonObject | null {
  if (!isObject(value) || !isIdentifier(value.id)) return null;
  const rawType = typeof value.type === 'string' ? value.type : typeof value.field_type === 'string' ? value.field_type : null;
  const normalizedType = rawType ? runtimePlaylistFieldTypes[rawType] : undefined;
  if (!normalizedType) return null;
  const hasPlaylists = has(value, 'playlists');
  const hasChildren = has(value, 'children');
  if (hasPlaylists && !Array.isArray(value.playlists)) return null;
  if (hasChildren && !Array.isArray(value.children)) return null;
  if (hasPlaylists && hasChildren) return null;
  const rawChildren = hasPlaylists ? value.playlists : hasChildren ? value.children : undefined;
  if (normalizedType === 'group' && !Array.isArray(rawChildren)) return null;
  const children = rawChildren === undefined ? undefined : (rawChildren as readonly unknown[]).map(normalizeRuntimePlaylistNode);
  if (children?.some((child): child is null => child === null)) return null;
  const normalized: Record<string, unknown> = { id: value.id, type: normalizedType };
  if (children) normalized.playlists = children;
  return normalized;
}

function normalizeRuntimePlaylistTree(value: unknown): PlaylistTreeResponse | null {
  if (!Array.isArray(value)) return null;
  const nodes = value.map(normalizeRuntimePlaylistNode);
  return nodes.every((node): node is JsonObject => node !== null) ? nodes as unknown as PlaylistTreeResponse : null;
}

const playlistItemTypes = new Set(['presentation', 'placeholder', 'header', 'media', 'audio', 'livevideo']);

function isPlaylistItem(value: unknown): boolean {
  if (!isObject(value) || !isIdentifier(value.id, true) || typeof value.type !== 'string' || !playlistItemTypes.has(value.type)) return false;
  if (has(value, 'is_hidden') && typeof value.is_hidden !== 'boolean') return false;
  if (has(value, 'is_pco') && typeof value.is_pco !== 'boolean') return false;
  if (!has(value, 'presentation_info') || value.presentation_info === null) return true;
  if (!isObject(value.presentation_info) || typeof value.presentation_info.presentation_uuid !== 'string') return false;
  return !has(value.presentation_info, 'arrangement_name') || typeof value.presentation_info.arrangement_name === 'string';
}

function isPlaylistResponse(value: unknown): value is PlaylistResponse {
  return isObject(value) && isIdentifier(value.id) && Array.isArray(value.items) && value.items.every(isPlaylistItem);
}

function normalizeLibraryItem(value: unknown): FocusedItem | null {
  if (isObject(value) && typeof value.uuid === 'string' && typeof value.name === 'string' && (!has(value, 'index') || isFiniteNumber(value.index))) {
    return { uuid: value.uuid, name: value.name, index: isFiniteNumber(value.index) ? value.index : 0 };
  }
  // Older ProPresenter builds used the shared item envelope for library
  // presentations. Convert that known shape to the official focused-item
  // payload before it reaches the generated/domain types.
  if (isObject(value)) {
    const identifier = value.id;
    if (isIdentifier(identifier, true) && typeof identifier.uuid === 'string') {
      return { uuid: identifier.uuid, name: identifier.name, index: identifier.index };
    }
  }
  return null;
}

function normalizedLibraryItems(value: unknown): FocusedItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(normalizeLibraryItem);
  return items.every((item): item is FocusedItem => item !== null) ? items : null;
}

function normalizeLibrariesResponse(value: unknown): LibrariesResponse | null {
  if (!Array.isArray(value)) return null;
  const libraries = value.map((item) => {
    if (!isObject(item)) return null;
    if (isIdentifier(item.id)) return { id: item.id };
    if (isIdentifier(item)) return { id: item };
    return null;
  });
  return libraries.every((library): library is { id: { uuid: string | null; name: string; index: number } } => library !== null)
    ? libraries as LibrariesResponse
    : null;
}

function canonicalLibraryResponse(value: JsonObject): LibraryResponse | null {
  const normalized = normalizedLibraryItems(value.items);
  if (!normalized) return null;
  if (has(value, 'updateType') && has(value, 'update_type') && value.updateType !== value.update_type) return null;
  const updateType = has(value, 'updateType') ? value.updateType : value.update_type;
  if (updateType !== undefined && updateType !== 'all' && updateType !== 'add' && updateType !== 'remove') return null;
  return { updateType: (updateType ?? 'all') as LibraryResponse['updateType'], items: normalized };
}

function isActiveLayer(value: unknown): boolean {
  if (!isObject(value) || !has(value, 'playlist') || !has(value, 'item')) return false;
  if (value.playlist !== null && !isIdentifier(value.playlist)) return false;
  return value.item === null || isIdentifier(value.item);
}

function isActivePlaylistResponse(value: unknown): value is PlaylistActiveResponse {
  if (!isObject(value)) return false;
  if (!Object.keys(value).every((key) => key === 'presentation' || key === 'announcements')) return false;
  if (!has(value, 'presentation') && !has(value, 'announcements')) return false;
  return (!has(value, 'presentation') || value.presentation === null || isActiveLayer(value.presentation))
    && (!has(value, 'announcements') || value.announcements === null || isActiveLayer(value.announcements));
}

function isPresentationIndex(value: unknown): boolean {
  if (!isObject(value) || !has(value, 'presentation_id') || !isFiniteNumber(value.index)) return false;
  return isIdentifier(value.presentation_id);
}

function isPresentationPosition(value: unknown): value is PresentationPositionResponse {
  if (!isObject(value) || !Object.keys(value).every((key) => key === 'presentation_index')) return false;
  return !has(value, 'presentation_index') || value.presentation_index === null || isPresentationIndex(value.presentation_index);
}

function isSlide(value: unknown): boolean {
  return isObject(value) && typeof value.uuid === 'string' && typeof value.text === 'string' && typeof value.notes === 'string';
}

function isSlideStatus(value: unknown): value is SlideStatusResponse {
  if (!isObject(value) || !Object.keys(value).every((key) => key === 'current' || key === 'next')) return false;
  return (!has(value, 'current') || value.current === null || isSlide(value.current))
    && (!has(value, 'next') || value.next === null || isSlide(value.next));
}

function isPresentation(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.groups)) return false;
  if (has(value, 'id') && value.id !== undefined && value.id !== null && !isIdentifier(value.id)) return false;
  if (has(value, 'has_timeline') && typeof value.has_timeline !== 'boolean') return false;
  if (has(value, 'destination') && value.destination !== 'presentation' && value.destination !== 'announcements') return false;
  return value.groups.every((group) => isObject(group) && typeof group.name === 'string' && Array.isArray(group.slides)
    && group.slides.every((slide) => isObject(slide) && typeof slide.text === 'string' && typeof slide.notes === 'string' && typeof slide.label === 'string'));
}

function isActivePresentationResponse(value: unknown): value is ActivePresentationResponse {
  if (!isObject(value) || !Object.keys(value).every((key) => key === 'presentation')) return false;
  return !has(value, 'presentation') || value.presentation === null || isPresentation(value.presentation);
}

function isPresentationResponse(value: unknown): value is PresentationResponse {
  return isPresentation(value);
}

function playlistIdFromPath(path: string): JsonObject | null {
  const resource = path.split('?')[0].split('/').pop();
  if (!resource) return null;
  try {
    const id = decodeURIComponent(resource);
    return { uuid: id, name: id, index: 0 };
  } catch {
    return null;
  }
}

function playlistResponseFromItems(items: unknown, id: unknown, path: string): PlaylistResponse | null {
  if (!Array.isArray(items) || !items.every(isPlaylistItem)) return null;
  const playlistId = isIdentifier(id) ? id : playlistIdFromPath(path);
  if (!playlistId) return null;
  return { id: playlistId, items } as PlaylistResponse;
}

function playlistResponseFromKnownContainer(value: JsonObject, path: string): PlaylistResponse | null {
  if (isPlaylistResponse(value)) return value;
  if (has(value, 'playlist')) {
    if (isPlaylistResponse(value.playlist)) return value.playlist;
    if (isObject(value.playlist)) {
      if (isPlaylistResponse(value.playlist)) return value.playlist;
      const nestedItems = has(value.playlist, 'items') ? value.playlist.items : value.playlist.playlist_items;
      const nested = playlistResponseFromItems(nestedItems, value.playlist.id ?? value.id, path);
      if (nested) return nested;
    }
  }
  if (has(value, 'playlist_items')) {
    if (isPlaylistResponse(value.playlist_items)) return value.playlist_items;
    const nested = playlistResponseFromItems(value.playlist_items, value.id, path);
    if (nested) return nested;
  }
  if (has(value, 'items')) return playlistResponseFromItems(value.items, value.id, path);
  return null;
}

function libraryResponseFromItems(items: unknown): LibraryResponse | null {
  const normalized = normalizedLibraryItems(items);
  if (!normalized) return null;
  return { updateType: 'all', items: normalized } as LibraryResponse;
}

function libraryResponseFromKnownContainer(value: JsonObject): LibraryResponse | null {
  const direct = canonicalLibraryResponse(value);
  if (direct) return direct;
  if (has(value, 'library')) {
    if (isObject(value.library)) {
      const nested = libraryResponseFromKnownContainer(value.library);
      if (nested) return nested;
    }
  }
  if (has(value, 'presentations')) {
    const nested = libraryResponseFromItems(value.presentations);
    if (nested) return nested;
  }
  if (has(value, 'items')) return libraryResponseFromItems(value.items);
  return null;
}

function decodePlaylistTree(value: unknown): PlaylistTreeResponse {
  if (isPlaylistTree(value)) return value;
  const runtime = normalizeRuntimePlaylistTree(value);
  if (runtime) return runtime;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isPlaylistTree(value.data)) return value.data;
    const runtimeData = normalizeRuntimePlaylistTree(value.data);
    if (runtimeData) return runtimeData;
    if (isObject(value.data) && isPlaylistTree(value.data.playlists)) return value.data.playlists;
    if (isObject(value.data)) {
      const runtimePlaylists = normalizeRuntimePlaylistTree(value.data.playlists);
      if (runtimePlaylists) return runtimePlaylists;
    }
    rejectShape('data');
  }
  if (has(value, 'playlists') && isPlaylistTree(value.playlists)) return value.playlists;
  if (has(value, 'playlists')) {
    const runtimePlaylists = normalizeRuntimePlaylistTree(value.playlists);
    if (runtimePlaylists) return runtimePlaylists;
  }
  rejectShape(rootKeys(value));
}

function decodePlaylist(value: unknown, path: string): PlaylistResponse {
  if (isPlaylistResponse(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isPlaylistResponse(value.data)) return value.data;
    if (isObject(value.data)) {
      const nested = playlistResponseFromKnownContainer(value.data, path);
      if (nested) return nested;
    }
    rejectShape('data');
  }
  const known = playlistResponseFromKnownContainer(value, path);
  if (known) return known;
  rejectShape(rootKeys(value));
}

function decodeLibraries(value: unknown): LibrariesResponse {
  const normalized = normalizeLibrariesResponse(value);
  if (normalized) return normalized;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    const data = normalizeLibrariesResponse(value.data);
    if (data) return data;
    if (isObject(value.data)) {
      const nested = normalizeLibrariesResponse(value.data.libraries);
      if (nested) return nested;
    }
    rejectShape('data');
  }
  if (has(value, 'libraries')) {
    const libraries = normalizeLibrariesResponse(value.libraries);
    if (libraries) return libraries;
  }
  rejectShape(rootKeys(value));
}

function decodeLibrary(value: unknown): LibraryResponse {
  if (Array.isArray(value)) {
    const raw = libraryResponseFromItems(value);
    if (raw) return raw;
    rejectShape();
  }
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isObject(value.data)) {
      const nested = libraryResponseFromKnownContainer(value.data);
      if (nested) return nested;
    }
    rejectShape('data');
  }
  const known = libraryResponseFromKnownContainer(value);
  if (known) return known;
  rejectShape(rootKeys(value));
}

function decodePresentationPosition(value: unknown): PresentationPositionResponse {
  if (isPresentationPosition(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isPresentationPosition(value.data)) return value.data;
    if (isObject(value.data) && has(value.data, 'slide_index') && isPresentationPosition(value.data.slide_index)) return value.data.slide_index;
    rejectShape('data');
  }
  if (has(value, 'slide_index') && isPresentationPosition(value.slide_index)) return value.slide_index;
  rejectShape(rootKeys(value));
}

function decodeActivePlaylist(value: unknown): PlaylistActiveResponse {
  if (isActivePlaylistResponse(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isActivePlaylistResponse(value.data)) return value.data;
    if (isObject(value.data)) {
      for (const key of ['active_playlist', 'playlist_active', 'playlist']) {
        if (has(value.data, key) && isActivePlaylistResponse(value.data[key])) return value.data[key];
      }
    }
    rejectShape('data');
  }
  for (const key of ['active_playlist', 'playlist_active', 'playlist']) {
    if (has(value, key) && isActivePlaylistResponse(value[key])) return value[key];
  }
  rejectShape(rootKeys(value));
}

function decodeSlideStatus(value: unknown): SlideStatusResponse {
  if (isSlideStatus(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isSlideStatus(value.data)) return value.data;
    if (isObject(value.data)) {
      for (const key of ['status', 'slide', 'status_slide', 'slide_status']) {
        if (has(value.data, key) && isSlideStatus(value.data[key])) return value.data[key];
      }
    }
    rejectShape('data');
  }
  for (const key of ['status', 'slide', 'status_slide', 'slide_status']) {
    if (has(value, key) && isSlideStatus(value[key])) return value[key];
  }
  rejectShape(rootKeys(value));
}

function decodeActivePresentation(value: unknown): ActivePresentationResponse {
  if (isActivePresentationResponse(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isActivePresentationResponse(value.data)) return value.data;
    if (isObject(value.data) && has(value.data, 'active_presentation') && isActivePresentationResponse(value.data.active_presentation)) return value.data.active_presentation;
    rejectShape('data');
  }
  if (has(value, 'active_presentation') && isActivePresentationResponse(value.active_presentation)) return value.active_presentation;
  rejectShape(rootKeys(value));
}

function decodePresentation(value: unknown): PresentationResponse {
  if (isPresentationResponse(value)) return value;
  if (!isObject(value)) rejectShape();
  if (has(value, 'data')) {
    if (isPresentationResponse(value.data)) return value.data;
    if (isObject(value.data) && has(value.data, 'presentation') && isPresentationResponse(value.data.presentation)) return value.data.presentation;
    rejectShape('data');
  }
  if (has(value, 'presentation') && isPresentationResponse(value.presentation)) return value.presentation;
  rejectShape(rootKeys(value));
}

export function isNativeProxy(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => part.trim() === 'propresenter-native=1');
}

export function apiBase(settings: ConnectionSettings): string {
  return isNativeProxy() ? '' : `http://${settings.host}:${settings.port}`;
}

/** Transport-only client. Domain normalization belongs in propresenter.ts. */
export class ProPresenterClient {
  constructor(readonly base: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = globalThis.setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher.call(globalThis, `${this.base}${path}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new ProPresenterApiError(`${response.status} ${path}`, path, response.status, 'http');
      return response;
    } catch (error) {
      if (error instanceof ProPresenterApiError) throw error;
      // React Query uses the propagated AbortError to discard a superseded
      // poll. Wrapping it as a network failure would briefly mark the session
      // disconnected during normal query cancellation.
      if (controller.signal.aborted || signal?.aborted) throw error;
      throw new ProPresenterApiError(`ProPresenter 요청 실패: ${path}`, path, null, 'network');
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, signal);
    let value: unknown;
    try { value = await response.json(); }
    catch (error) { if (signal?.aborted) throw error; throw new ProPresenterApiError(`ProPresenter 응답을 읽을 수 없습니다: ${path}`, path, response.status, 'decode'); }
    try {
      return (this.decoderFor(path)(value, path) as T);
    } catch (error) {
      if (signal?.aborted) throw error;
      const wrapperKey = error instanceof RuntimeDecodeError ? error.wrapperKey : null;
      const detectedWrapperKey = wrapperKey || rootKeys(value);
      throw new ProPresenterApiError(
        `ProPresenter 응답을 디코딩할 수 없습니다: ${path} (root shape: ${rootShape(value)}; detected wrapper key: ${detectedWrapperKey})`,
        path,
        response.status,
        'decode',
      );
    }
  }

  private decoderFor(path: string): (value: unknown, path: string) => unknown {
    if (path.startsWith('/v1/presentation/slide_index')) return decodePresentationPosition;
    if (path.startsWith('/v1/playlist/active')) return decodeActivePlaylist;
    if (path.startsWith('/v1/status/slide')) return decodeSlideStatus;
    if (path.startsWith('/v1/presentation/active')) return decodeActivePresentation;
    if (path === '/v1/playlists?chunked=false') return (value) => decodePlaylistTree(value);
    if (path.startsWith('/v1/playlist/')) return decodePlaylist;
    if (path === '/v1/libraries?chunked=false') return (value) => decodeLibraries(value);
    if (path.startsWith('/v1/library/')) return (value) => decodeLibrary(value);
    if (path.startsWith('/v1/presentation/')) return (value) => decodePresentation(value);
    return (value) => value;
  }

  private async command(path: string, signal?: AbortSignal): Promise<void> {
    await this.request(path, signal);
  }

  presentationPosition(signal?: AbortSignal) { return this.getJson<PresentationPositionResponse>('/v1/presentation/slide_index?chunked=false', signal); }
  activePlaylist(signal?: AbortSignal) { return this.getJson<PlaylistActiveResponse>('/v1/playlist/active?chunked=false', signal); }
  slideStatus(signal?: AbortSignal) { return this.getJson<SlideStatusResponse>('/v1/status/slide?chunked=false', signal); }
  activePresentation(signal?: AbortSignal) { return this.getJson<ActivePresentationResponse>('/v1/presentation/active?chunked=false', signal); }
  playlists(signal?: AbortSignal) { return this.getJson<PlaylistTreeResponse>('/v1/playlists?chunked=false', signal); }
  playlist(playlistId: string, signal?: AbortSignal) { return this.getJson<PlaylistResponse>(`/v1/playlist/${encodeURIComponent(playlistId)}?chunked=false`, signal); }
  libraries(signal?: AbortSignal) { return this.getJson<LibrariesResponse>('/v1/libraries?chunked=false', signal); }
  library(libraryId: string, signal?: AbortSignal) { return this.getJson<LibraryResponse>(`/v1/library/${encodeURIComponent(libraryId)}?chunked=false`, signal); }
  presentation(presentationId: string, signal?: AbortSignal) { return this.getJson<PresentationResponse>(`/v1/presentation/${encodeURIComponent(presentationId)}?chunked=false`, signal); }

  next(signal?: AbortSignal) { return this.command('/v1/trigger/next', signal); }
  previous(signal?: AbortSignal) { return this.command('/v1/trigger/previous', signal); }
  triggerActiveArrangementCue(index: number, signal?: AbortSignal) { return this.command(`/v1/presentation/active/${index}/trigger`, signal); }
  triggerActivePresentationGroup(group: string, signal?: AbortSignal) { return this.command(`/v1/presentation/active/group/${encodeURIComponent(group)}/trigger`, signal); }
  triggerPlaylistItem(playlistId: string, itemIndex: number, signal?: AbortSignal) { return this.command(`/v1/playlist/${encodeURIComponent(playlistId)}/${itemIndex}/trigger`, signal); }
  triggerLibraryCue(libraryId: string, presentationId: string, index: number, signal?: AbortSignal) { return this.command(`/v1/library/${encodeURIComponent(libraryId)}/${encodeURIComponent(presentationId)}/${index}/trigger`, signal); }
}
