import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalState,
  currentCueIndex,
  executeCommand,
  fetchCanonicalState,
  flattenSlides,
  groupStarts,
  isCurrentContext,
  parsePresentationPosition,
  parseStatusCues,
  playlistItemContext,
  remoteDisplayMode,
  withPlaylistItemContext,
} from './propresenter';

const state = (overrides: Partial<CanonicalState> = {}): CanonicalState => ({
  playlistId: 'playlist-a', playlistItemId: 'item-a', playlistItemIndex: 0, presentationId: 'presentation-a', slideIndex: 1,
  currentCue: { uuid: 'output-slide', text: '현재 출력', notes: '' }, nextCue: { uuid: 'next-output', text: '다음 출력', notes: '' }, playlistItem: null,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('canonical ProPresenter state', () => {
  it('parses presentation ID and index as one coherent slide-index pair', () => {
    expect(parsePresentationPosition({ presentation_index: { presentation_id: { uuid: 'presentation-live' }, index: 12 } })).toEqual({ presentationId: 'presentation-live', slideIndex: 12 });
  });

  it('uses the slide-index presentation ID instead of combining a separate active presentation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.includes('/presentation/slide_index') ? { presentation_index: { presentation_id: { uuid: 'presentation-from-index' }, index: 3 } }
        : path.includes('/playlist/active') ? { presentation: { playlist: { uuid: 'playlist-a' }, item: { uuid: 'item-a', index: 4 } } }
          : { current: { uuid: 'output-slide', text: '현재 출력' }, next: { uuid: 'next-output', text: '다음 출력' } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCanonicalState('http://propresenter.local')).resolves.toMatchObject({ presentationId: 'presentation-from-index', slideIndex: 3, playlistItemId: 'item-a' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses active presentation only as a fallback when slide-index lacks its presentation ID', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.includes('/presentation/slide_index') ? { presentation_index: { index: 2 } }
        : path.includes('/presentation/active') ? { presentation: { id: { uuid: 'fallback-presentation' } } }
          : path.includes('/playlist/active') ? { presentation: { playlist: { uuid: 'playlist-a' }, item: { uuid: 'item-a' } } }
            : { current: { text: '현재' }, next: { text: '다음' } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCanonicalState('http://propresenter.local')).resolves.toMatchObject({ presentationId: 'fallback-presentation', slideIndex: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('continues without status slide data and keeps the position pair authoritative', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/status/slide')) return new Response('missing', { status: 404 });
      const body = path.includes('/presentation/slide_index') ? { presentation_index: { presentation_id: { uuid: 'presentation-a' }, index: 1 } }
        : { presentation: { playlist: { uuid: 'playlist-a' }, item: { uuid: 'item-a' } } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCanonicalState('http://propresenter.local')).resolves.toMatchObject({ presentationId: 'presentation-a', slideIndex: 1, currentCue: null, nextCue: null });
  });

  it('treats status cues as output data even when presentation detail has no slide UUID', () => {
    const detail = flattenSlides({ presentation: { groups: [{ slides: [{ text: '첫 슬라이드' }, { text: '둘째 슬라이드' }] }] } });
    const output = parseStatusCues({ current: { uuid: 'output-only', text: '실제 출력' }, next: { uuid: 'next-only', text: '실제 다음' } });
    expect(detail[1].uuid).toBeUndefined();
    expect(output.currentCue?.uuid).toBe('output-only');
    expect(currentCueIndex(state({ ...output, slideIndex: 1 }), { source: 'library', libraryId: 'library-a', presentationId: 'presentation-a', name: '테스트', cacheKey: 'library-a:presentation-a' })).toBe(1);
  });
});

describe('playlist identity and arrangement', () => {
  const repeatedPresentation = [
    { id: { uuid: 'item-a', name: '첫 번째 편곡' }, type: 'presentation', index: 0, presentation_info: { presentation_uuid: 'presentation-shared', arrangement_uuid: 'arrangement-a' } },
    { type: 'media', id: { uuid: 'media-between', name: '영상' }, index: 1 },
    { id: { uuid: 'item-b', name: '두 번째 편곡' }, type: 'presentation', index: 2, presentation_info: { presentation_uuid: 'presentation-shared', arrangement_uuid: 'arrangement-b' } },
  ];

  it('keeps identical presentation UUIDs distinct by playlist item and arrangement', () => {
    const first = playlistItemContext('playlist-a', repeatedPresentation[0], 0)!;
    const second = playlistItemContext('playlist-a', repeatedPresentation[2], 2)!;
    expect(first.presentationId).toBe(second.presentationId);
    expect(first.cacheKey).not.toBe(second.cacheKey);
    const resolved = withPlaylistItemContext(state({ playlistItemId: 'item-b', presentationId: 'presentation-shared', slideIndex: 4 }), repeatedPresentation);
    expect(resolved.playlistItem?.arrangementId).toBe('arrangement-b');
    expect(isCurrentContext(resolved, first)).toBe(false);
    expect(isCurrentContext(resolved, second)).toBe(true);
    expect(isCurrentContext(resolved, { ...second, playlistId: 'another-playlist' })).toBe(false);
  });

  it('accepts externally changed canonical state without deriving a next presentation through media items', () => {
    const media = playlistItemContext('playlist-a', repeatedPresentation[1], 1)!;
    const externallyChanged = withPlaylistItemContext(state({ playlistItemId: 'media-between', presentationId: null, slideIndex: -1 }), repeatedPresentation);
    expect(externallyChanged.playlistItem?.playlistItemId).toBe(media.playlistItemId);
    expect(externallyChanged.presentationId).toBeNull();
  });
});

describe('shared display rules', () => {
  it('gives controller and remote the same current presentation and cue from canonical state', () => {
    const context = playlistItemContext('playlist-a', { id: { uuid: 'item-a' }, type: 'presentation', presentation_info: { presentation_uuid: 'presentation-a' } }, 0)!;
    const current = withPlaylistItemContext(state(), [{ id: { uuid: 'item-a' }, type: 'presentation', presentation_info: { presentation_uuid: 'presentation-a' } }]);
    expect(currentCueIndex(current, context)).toBe(1);
    expect(current.currentCue?.text).toBe('현재 출력');
  });

  it('uses the current status cue for automatic remote mode and keeps next cue output-based', () => {
    expect(remoteDisplayMode('auto', { uuid: null, text: '현재 출력', notes: '' })).toBe('text');
    expect(remoteDisplayMode('auto', { uuid: null, text: '', notes: '' })).toBe('preview');
    expect(groupStarts(flattenSlides({ presentation: { groups: [{ name: '1절', slides: [{ text: 'a' }] }, { name: '후렴', slides: [{ text: 'b' }] }] } }))).toEqual([{ key: 'group-0', name: '1절', index: 0 }, { key: 'group-1', name: '후렴', index: 1 }]);
  });

  it('accepts the refreshed actual state after a successful command without index prediction', async () => {
    const actual = state({ presentationId: null, playlistItemId: 'media-between', slideIndex: -1 });
    const send = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => actual);
    await expect(executeCommand(send, refresh)).resolves.toBe(actual);
    expect(send).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
