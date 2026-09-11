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
      const response = await this.fetcher(`${this.base}${path}`, {
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
    try { return await response.json() as T; }
    catch (error) { if (signal?.aborted) throw error; throw new ProPresenterApiError(`ProPresenter 응답을 읽을 수 없습니다: ${path}`, path, response.status, 'decode'); }
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
