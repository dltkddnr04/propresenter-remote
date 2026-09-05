export type ApiObject = Record<string, any>;

export type ActiveState = {
  playlistId: string | null;
  playlistItemId: string | null;
  presentationId: string | null;
  slideIndex: number;
};

export type ActiveExpectation = {
  presentationId: string | null;
  // The previous presentation is fetched eagerly, but allow its server-selected
  // final index to confirm a boundary command while that prefetch is still pending.
  slideIndex: number | null;
};

export type Slide = ApiObject & {
  groupName: string;
  groupKey: string;
  flatIndex: number;
};

const requestTimeoutMs = 2_500;

export async function api(base: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = globalThis.setTimeout(abort, requestTimeoutMs);

  try {
    const response = await fetch(`${base}${path}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${path}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function unwrap(value: unknown): unknown {
  return (value as ApiObject)?.data ?? value;
}

export function listArray(value: unknown): ApiObject[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const object = value as ApiObject;
  for (const key of ['items', 'playlist_items', 'contents', 'children', 'playlists', 'libraries', 'library', 'presentations']) {
    if (Array.isArray(object[key])) return object[key];
  }
  return [];
}

export function objectId(value?: ApiObject): string | null {
  if (!value) return null;
  return value.id?.uuid || value.uuid || value.playlist_id?.uuid || value.presentation_info?.presentation_uuid || value.id || null;
}

export function objectName(value?: ApiObject, fallback = '이름 없는 항목'): string {
  return value?.id?.name || value?.name || value?.title || value?.playlist_id?.name || value?.presentation_info?.name || fallback;
}

export function presentationUuid(item?: ApiObject): string | null {
  return item?.presentation_info?.presentation_uuid || null;
}

export function playlistItems(data: unknown): ApiObject[] {
  const object = unwrap(data) as ApiObject;
  return object?.playlist?.items || listArray(object);
}

export function activePlaylistContext(data: unknown): Pick<ActiveState, 'playlistId' | 'playlistItemId'> {
  const value = unwrap(data) as ApiObject;
  return {
    playlistId: value?.presentation?.playlist?.uuid || value?.playlist?.uuid || objectId(value?.playlist || value),
    playlistItemId: value?.presentation?.item?.uuid || value?.item?.uuid || null,
  };
}

export function activePresentationId(data: unknown): string | null {
  const object = unwrap(data) as ApiObject;
  return object?.presentation?.item?.uuid || object?.presentation?.id?.uuid || object?.presentation?.uuid || object?.id?.uuid || object?.uuid || null;
}

export function slideIndex(data: unknown): number {
  const object = unwrap(data) as ApiObject;
  for (const value of [object?.presentation_index?.index, object?.presentation_index, object?.index, object?.slide_index?.index, object?.slide_index]) {
    const index = Number(value);
    if (Number.isInteger(index)) return index;
  }
  return -1;
}

export async function fetchActiveState(base: string, signal?: AbortSignal): Promise<ActiveState> {
  const [playlist, presentation, slide] = await Promise.all([
    api(base, '/v1/playlist/active?chunked=false', signal),
    api(base, '/v1/presentation/active?chunked=false', signal),
    api(base, '/v1/presentation/slide_index?chunked=false', signal),
  ]);
  return { ...activePlaylistContext(playlist), presentationId: activePresentationId(presentation), slideIndex: slideIndex(slide) };
}

export function flattenSlides(data: unknown): Slide[] {
  const presentation = (unwrap(data) as ApiObject)?.presentation || unwrap(data) as ApiObject;
  return (presentation?.groups || []).flatMap((group: ApiObject, groupIndex: number) =>
    (group.slides || []).map((slide: ApiObject) => ({
      ...slide,
      groupName: group.name || '',
      groupKey: group.uuid || group.id?.uuid || `group-${groupIndex}`,
      flatIndex: 0,
    })),
  ).map((slide: Slide, index: number) => ({ ...slide, flatIndex: index }));
}

export function slideText(slide?: Slide): string {
  return String(slide?.text || '').replace(/\s+/g, ' ').trim();
}

export function isConfirmed(expected: ActiveExpectation, actual: ActiveState): boolean {
  return expected.presentationId === actual.presentationId && (expected.slideIndex === null || expected.slideIndex === actual.slideIndex);
}

export function remoteDisplayMode(mode: 'text' | 'preview' | 'auto', slide?: Slide): 'text' | 'preview' {
  return mode === 'auto' ? (slideText(slide) ? 'text' : 'preview') : mode;
}

export function groupStarts(slides: Slide[]): Array<{ key: string; name: string; index: number }> {
  return slides.reduce<Array<{ key: string; name: string; index: number }>>((all, slide, index) =>
    all.some((group) => group.key === slide.groupKey) ? all : [...all, { key: slide.groupKey, name: slide.groupName || `그룹 ${all.length + 1}`, index }], []);
}

export function relativeTarget(active: ActiveState, slides: Slide[], direction: 1 | -1, adjacentId: string | null, adjacentSlides?: Slide[]): { presentationId: string; slideIndex: number | null; optimistic: boolean } | null {
  const targetIndex = active.slideIndex + direction;
  if (targetIndex >= 0 && targetIndex < slides.length && active.presentationId) return { presentationId: active.presentationId, slideIndex: targetIndex, optimistic: true };
  if (!adjacentId) return null;
  return { presentationId: adjacentId, slideIndex: direction > 0 ? 0 : adjacentSlides?.length ? adjacentSlides.length - 1 : null, optimistic: false };
}
