import { describe, expect, it } from 'vitest';
import { ProPresenterApiError, ProPresenterClient } from './propresenter-client';
import { acceptCanonicalSnapshot, asPlaylistItemIndex, canTriggerPresentationCue, enrichPlaylistContext, flattenSlides, isCurrentContext, normalizeCanonicalState, normalizeLibraries, normalizeLibraryItems, normalizePlaylistItems, normalizePlaylistTree, playlistItemContext, remoteDisplayMode } from './propresenter';

const id = (uuid: string, name = uuid, index = 0) => ({ uuid, name, index });
const position = { presentation_index: { presentation_id: id('presentation-a', 'Presentation A'), index: 2 } } as const;
const active = { presentation: { playlist: id('playlist-a', 'Playlist A'), item: id('item-a', 'Item A', 3) }, announcements: { playlist: null, item: null } } as const;
const status = { current: { uuid: 'output-uuid-not-detail', text: 'Current', notes: '' }, next: { uuid: 'next-uuid', text: 'Next', notes: '' } } as const;
const item = (uuid: string, arrangement_name: string) => ({ id: id(uuid, 'Item A', 3), type: 'presentation' as const, is_hidden: false, is_pco: false, presentation_info: { presentation_uuid: 'presentation-a', arrangement_name } });
const jsonClient = (body: unknown) => new ProPresenterClient('', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

describe('official OpenAPI adapter', () => {
  it('keeps presentation id and cue index as one slide_index pair', () => { const state = normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status }); expect(state.presentationId).toBe('presentation-a'); expect(state.slideIndex).toBe(2); });
  it('allows an absent status/slide response without changing canonical position', () => { const state = normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status: null }); expect(state.currentCue).toBeNull(); expect(state.presentationId).toBe('presentation-a'); });
  it('treats status UUID as output metadata, not a required detail UUID', () => { const state = normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status }); const slides = flattenSlides({ id: id('presentation-a'), groups: [{ name: 'Verse', color: { red: 1, green: 0, blue: 0, alpha: 1 }, slides: [{ enabled: true, text: 'Current', notes: '', label: '', color: { red: 0, green: 0, blue: 0, alpha: 1 } }] }], has_timeline: false, destination: 'presentation' }, 'presentation'); expect(state.currentCue?.uuid).toBe('output-uuid-not-detail'); expect(slides).toHaveLength(1); });
  it('uses arrangement_name and playlist item identity in cache identity', () => { const playlist = { id: 'playlist-a', name: 'Playlist A' }; const full = playlistItemContext(playlist, normalizePlaylistItems({ id: id('playlist-a'), items: [item('item-a', 'Full')] } as never)[0]); const chorus = playlistItemContext(playlist, normalizePlaylistItems({ id: id('playlist-a'), items: [item('item-b', 'Chorus Only')] } as never)[0]); expect(full?.presentationId).toBe(chorus?.presentationId); expect(full?.cacheKey).not.toBe(chorus?.cacheKey); });
  it('does not identify a media item as the next presentation', () => { const media = normalizePlaylistItems({ id: id('playlist-a'), items: [{ id: id('media-a', 'Video', 4), type: 'media', is_hidden: false, is_pco: false }] } as never)[0]; expect(media.presentationId).toBeNull(); });
  it('only treats the exact active playlist item as current', () => { const state = enrichPlaylistContext(normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status }), { id: id('playlist-a', 'Playlist A'), items: [item('item-a', 'Full')] } as never); const duplicate = playlistItemContext({ id: 'playlist-a', name: 'Playlist A' }, normalizePlaylistItems({ id: id('playlist-a'), items: [item('item-b', 'Chorus')] } as never)[0])!; expect(isCurrentContext(state, state.playlistItem)).toBe(true); expect(isCurrentContext(state, duplicate)).toBe(false); });
  it('does not predict next state; output state is accepted from the next snapshot', () => { const nextState = normalizeCanonicalState({ revision: 2, position: { presentation_index: { presentation_id: id('presentation-b'), index: 0 } }, activePlaylist: { ...active, presentation: { playlist: active.presentation.playlist, item: id('media-a', 'Media', 4) } }, status }); expect(nextState.presentationId).toBe('presentation-b'); expect(nextState.playlistItemId).toBe('media-a'); });
  it('keeps command failures separate from connection failures', () => { const error = new ProPresenterApiError('404 command', '/v1/trigger/next', 404, 'http'); expect(error.kind).toBe('http'); expect(error.path).toContain('trigger'); });
  it('uses authoritative current cue for auto mode', () => { expect(remoteDisplayMode('auto', { uuid: null, text: 'Text', notes: '' })).toBe('text'); expect(remoteDisplayMode('auto', { uuid: null, text: '', notes: '' })).toBe('preview'); });
  it('branded playlist indices reject invalid values', () => { expect(asPlaylistItemIndex(-1)).toBeNull(); expect(asPlaylistItemIndex(3)).toBe(3); });
  it('never lets an older completed poll replace a newer canonical snapshot', () => { const newer = normalizeCanonicalState({ revision: 2, position, activePlaylist: active, status }); const older = normalizeCanonicalState({ revision: 1, position: { presentation_index: { presentation_id: id('old'), index: 0 } }, activePlaylist: active, status }); expect(acceptCanonicalSnapshot(newer, older)).toBe(newer); });
  it('blocks inactive playlist arrangement cues instead of falling back to a generic trigger', () => { const state = enrichPlaylistContext(normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status }), { id: id('playlist-a'), items: [item('item-a', 'Full')] } as never); const inactive = playlistItemContext({ id: 'playlist-a', name: 'Playlist A' }, normalizePlaylistItems({ id: id('playlist-a'), items: [item('item-b', 'Chorus Only')] } as never)[0])!; expect(canTriggerPresentationCue(state, inactive)).toBe(false); });
});

describe('runtime compatibility adapter', () => {
  const playlistTree = [{ id: id('playlist-a', 'Playlist A'), type: 'playlist' as const, playlists: [] }];
  const libraries = [{ id: id('library-a', 'Library A') }];

  it('normalizes raw and data-wrapped playlist trees identically', async () => {
    const raw = normalizePlaylistTree(await jsonClient(playlistTree).playlists());
    const wrapped = normalizePlaylistTree(await jsonClient({ data: { playlists: playlistTree } }).playlists());
    expect(wrapped).toEqual(raw);
  });

  it('normalizes raw and data-wrapped libraries', async () => {
    const raw = normalizeLibraries(await jsonClient(libraries).libraries());
    const wrapped = normalizeLibraries(await jsonClient({ data: { libraries } }).libraries());
    expect(wrapped).toEqual(raw);
  });

  it('normalizes raw and legacy wrapped library details', async () => {
    const raw = normalizeLibraryItems(await jsonClient({ updateType: 'all', items: [{ uuid: 'presentation-a', name: 'A', index: 0 }] }).library('library-a'));
    const presentations = normalizeLibraryItems(await jsonClient({ data: { presentations: [{ id: { uuid: 'presentation-a', name: 'A', index: 0 } }] } }).library('library-a'));
    const nested = normalizeLibraryItems(await jsonClient({ data: { library: { items: [{ id: { uuid: 'presentation-a', name: 'A', index: 0 } }] } } }).library('library-a'));
    expect(presentations).toEqual(raw);
    expect(nested).toEqual(raw);
  });

  it('unwraps canonical session endpoint payloads before normalization', async () => {
    const wrappedPosition = await jsonClient({ data: { presentation_index: position.presentation_index } }).presentationPosition();
    const wrappedActive = await jsonClient({ data: active }).activePlaylist();
    const wrappedStatus = await jsonClient({ data: status }).slideStatus();
    const presentation = { groups: [{ name: 'Verse', color: {}, slides: [{ enabled: true, text: 'Current', notes: '', label: '1', color: {} }] }], has_timeline: false, destination: 'presentation' as const };
    const wrappedActivePresentation = await jsonClient({ data: { presentation } }).activePresentation();
    const wrappedPresentation = await jsonClient({ data: { presentation } }).presentation('presentation-a');
    expect(wrappedPosition).toEqual(position);
    expect(wrappedActive).toEqual(active);
    expect(wrappedStatus).toEqual(status);
    expect(wrappedActivePresentation).toEqual({ presentation });
    expect(wrappedPresentation).toEqual(presentation);
  });

  it('fails with a decode diagnostic for an unknown wrapper', async () => {
    await expect(jsonClient({ data: { unknown: [] } }).libraries()).rejects.toMatchObject({ kind: 'decode', path: '/v1/libraries?chunked=false' });
    await expect(jsonClient({ data: { unknown: [] } }).libraries()).rejects.toThrow(/root shape: object.*detected wrapper key: data/);
  });
});
