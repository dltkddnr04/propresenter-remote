export type ApiObject = Record<string, any>;

export type ConnectionSettings = { host: string; port: number };

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

export type ActiveState = {
  playlistId: string | null;
  playlistItemId: string | null;
  presentationId: string | null;
  slideIndex: number;
  currentSlideUuid: string | null;
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
  groupColor: string | null;
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
  for (const key of ['data', 'items', 'playlist_items', 'contents', 'children', 'playlists', 'libraries', 'library', 'presentations']) {
    if (Array.isArray(object[key])) return object[key];
    if (object[key] && typeof object[key] === 'object') {
      const nested = listArray(object[key]);
      if (nested.length) return nested;
    }
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

export function activePlaylistPresentationId(active: ActiveState | undefined, items: ApiObject[]): string | null {
  if (!active) return null;
  const activeItem = items.find((item) => objectId(item) === active.playlistItemId);
  return presentationUuid(activeItem) || active.presentationId;
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

export function slideUuid(value?: ApiObject): string | null {
  if (!value) return null;
  return value.uuid || value.id?.uuid || value.slide?.uuid || value.slide?.id?.uuid || null;
}

export function currentSlideUuid(data: unknown): string | null {
  const value = unwrap(data) as ApiObject;
  const current = value?.current || value?.slide?.current || value?.data?.current;
  return slideUuid(current);
}

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
  const red = Number(color.red ?? color.r);
  const green = Number(color.green ?? color.g);
  const blue = Number(color.blue ?? color.b);
  if (![red, green, blue].every(Number.isFinite)) return null;
  const alpha = Number(color.alpha ?? color.a ?? 1);
  const scale = Math.max(red, green, blue) <= 1 ? 255 : 1;
  return `rgba(${Math.round(red * scale)}, ${Math.round(green * scale)}, ${Math.round(blue * scale)}, ${Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))})`;
}

export async function fetchActiveState(base: string, signal?: AbortSignal): Promise<ActiveState> {
  const [playlist, presentation, slide, status] = await Promise.all([
    api(base, '/v1/playlist/active?chunked=false', signal),
    api(base, '/v1/presentation/active?chunked=false', signal),
    api(base, '/v1/presentation/slide_index?chunked=false', signal),
    api(base, '/v1/status/slide?chunked=false', signal).catch(() => null),
  ]);
  return { ...activePlaylistContext(playlist), presentationId: activePresentationId(presentation), slideIndex: slideIndex(slide), currentSlideUuid: currentSlideUuid(status) };
}

export function flattenSlides(data: unknown): Slide[] {
  const presentation = (unwrap(data) as ApiObject)?.presentation || unwrap(data) as ApiObject;
  return (presentation?.groups || []).flatMap((group: ApiObject, groupIndex: number) =>
    (group.slides || []).map((slide: ApiObject) => ({
      ...slide,
      groupName: group.name || '',
      groupKey: group.uuid || group.id?.uuid || `group-${groupIndex}`,
      groupColor: normalizeGroupColor(group.groupColor || group.group_color || group.color),
      flatIndex: 0,
    })),
  ).map((slide: Slide, index: number) => ({ ...slide, flatIndex: index }));
}

export function slideText(slide?: Slide): string {
  return String(slide?.text || '').replace(/\s+/g, ' ').trim();
}

export function activeSlideIndex(active: ActiveState | undefined, slides: Slide[]): number {
  if (!active) return -1;
  if (active.currentSlideUuid) {
    const uuidIndex = slides.findIndex((slide) => slideUuid(slide) === active.currentSlideUuid);
    if (uuidIndex >= 0) return uuidIndex;
  }
  return active.slideIndex;
}

export function outputSlideIndex(active: ActiveState | undefined, presentationId: string | null, slides: Slide[]): number {
  if (!active) return -1;
  if (active.currentSlideUuid) return slides.findIndex((slide) => slideUuid(slide) === active.currentSlideUuid);
  return active.presentationId === presentationId ? active.slideIndex : -1;
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
