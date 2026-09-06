import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveState, activeSlideIndex, fetchActiveState, flattenSlides, groupStarts, isConfirmed, listArray, relativeTarget, remoteDisplayMode, slideUuid, unwrap } from './propresenter';

const active: ActiveState = { playlistId: 'playlist-a', playlistItemId: 'item-a', presentationId: 'presentation-a', slideIndex: 1, currentSlideUuid: 'slide-b' };
const slides = flattenSlides({ presentation: { groups: [{ uuid: 'verse', name: '1절', slides: [{ uuid: 'slide-a', text: '첫 줄' }, { uuid: 'slide-b', text: '둘째 줄' }] }, { uuid: 'chorus', name: '후렴', slides: [{ uuid: 'slide-c', text: '' }] }] } });

afterEach(() => vi.restoreAllMocks());

describe('active state snapshot', () => {
  it('combines active APIs and the actual output slide into one snapshot', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.includes('/playlist/active') ? { presentation: { playlist: { uuid: 'playlist-a' }, item: { uuid: 'item-a' } } } : path.includes('/presentation/active') ? { presentation: { item: { uuid: 'presentation-a' } } } : path.includes('/status/slide') ? { current: { uuid: 'slide-b' } } : { slide_index: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchActiveState('http://propresenter.local')).resolves.toEqual(active);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not confirm a stale or mixed state', () => {
    expect(isConfirmed({ presentationId: 'presentation-a', slideIndex: 2 }, active)).toBe(false);
    expect(isConfirmed({ presentationId: 'presentation-b', slideIndex: 1 }, active)).toBe(false);
    expect(isConfirmed({ presentationId: 'presentation-a', slideIndex: 1 }, active)).toBe(true);
    expect(isConfirmed({ presentationId: 'presentation-b', slideIndex: null }, { ...active, presentationId: 'presentation-b', slideIndex: 7 })).toBe(true);
  });
});

describe('remote transitions', () => {
  it('uses an optimistic target within a presentation', () => {
    expect(relativeTarget(active, slides, 1, 'presentation-b')).toEqual({ presentationId: 'presentation-a', slideIndex: 2, optimistic: true });
  });

  it('moves to the adjacent presentation at its boundary without optimism', () => {
    expect(relativeTarget({ ...active, slideIndex: 2 }, slides, 1, 'presentation-b', slides)).toEqual({ presentationId: 'presentation-b', slideIndex: 0, optimistic: false });
    expect(relativeTarget({ ...active, slideIndex: 0 }, slides, -1, 'presentation-before', slides)).toEqual({ presentationId: 'presentation-before', slideIndex: 2, optimistic: false });
  });

  it('waits for the actual final index when the previous presentation prefetch is late', () => {
    expect(relativeTarget({ ...active, slideIndex: 0 }, slides, -1, 'presentation-before')).toEqual({ presentationId: 'presentation-before', slideIndex: null, optimistic: false });
  });

  it('returns no target when an adjacent presentation is unavailable', () => {
    expect(relativeTarget({ ...active, slideIndex: 2 }, slides, 1, null)).toBeNull();
  });
});

describe('display and group rules', () => {
  it('prefers the actual output slide UUID over a stale index', () => {
    expect(slideUuid({ id: { uuid: 'slide-b' } })).toBe('slide-b');
    expect(activeSlideIndex({ ...active, slideIndex: 0 }, slides)).toBe(1);
  });
  it('uses text mode only when the current automatic slide has text', () => {
    expect(remoteDisplayMode('auto', slides[0])).toBe('text');
    expect(remoteDisplayMode('auto', slides[2])).toBe('preview');
    expect(remoteDisplayMode('text', slides[2])).toBe('text');
  });

  it('exposes only groups used by the current presentation', () => {
    expect(groupStarts(slides)).toEqual([{ key: 'verse', name: '1절', index: 0 }, { key: 'chorus', name: '후렴', index: 2 }]);
  });
});

describe('wrapped API responses', () => {
  it('reads library collections and entries from data-wrapped responses', () => {
    const response = { data: { libraries: [{ id: { uuid: 'library-a', name: '기본 라이브러리' } }] } };
    expect(listArray(unwrap(response))).toEqual(response.data.libraries);
    expect(listArray(unwrap({ data: { presentations: [{ id: { uuid: 'presentation-a' } }] } }))).toHaveLength(1);
    expect(listArray({ data: { library: { items: [{ id: { uuid: 'presentation-b' } }] } } })).toHaveLength(1);
  });
});
