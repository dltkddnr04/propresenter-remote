import { describe, expect, it } from 'vitest';
import librariesFixture from '../tests/fixtures/propresenter-runtime/libraries.json';
import libraryDetailFixture from '../tests/fixtures/propresenter-runtime/library-detail.json';
import playlistActiveFixture from '../tests/fixtures/propresenter-runtime/playlist-active.json';
import playlistDetailFixture from '../tests/fixtures/propresenter-runtime/playlist-detail.json';
import playlistsFixture from '../tests/fixtures/propresenter-runtime/playlists.json';
import presentationActiveFixture from '../tests/fixtures/propresenter-runtime/presentation-active.json';
import presentationDetailFixture from '../tests/fixtures/propresenter-runtime/presentation-detail.json';
import presentationSlideIndexFixture from '../tests/fixtures/propresenter-runtime/presentation-slide-index.json';
import statusSlideFixture from '../tests/fixtures/propresenter-runtime/status-slide.json';
import { ProPresenterApiError, ProPresenterClient } from './propresenter-client';
import { acceptCanonicalSnapshot, activeGroupKey, asPlaylistItemIndex, canReadArrangementCues, canTriggerPresentationCue, enrichPlaylistContext, flattenSlides, isCurrentContext, libraryPresentationContext, normalizeCanonicalState, normalizeLibraries, normalizeLibraryItems, normalizePlaylistItems, normalizePlaylistTree, playlistItemContext, remoteDisplayMode } from './propresenter';

const id = (uuid: string, name = uuid, index = 0) => ({ uuid, name, index });
const position = { presentation_index: { presentation_id: id('presentation-a', 'Presentation A'), index: 2 } } as const;
const active = { presentation: { playlist: id('playlist-a', 'Playlist A'), item: id('item-a', 'Item A', 3) }, announcements: { playlist: null, item: null } } as const;
const status = { current: { uuid: 'output-uuid-not-detail', text: 'Current', notes: '' }, next: { uuid: 'next-uuid', text: 'Next', notes: '' } } as const;
const item = (uuid: string, arrangement_name: string) => ({ id: id(uuid, 'Item A', 3), type: 'presentation' as const, is_hidden: false, is_pco: false, presentation_info: { presentation_uuid: 'presentation-a', arrangement_name } });
const jsonClient = (body: unknown) => new ProPresenterClient('', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const fixtureClient = (body: unknown) => new ProPresenterClient('', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

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
  it('does not render a default presentation as an inactive named arrangement', () => { const state = enrichPlaylistContext(normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status }), { id: id('playlist-a'), items: [item('item-a', 'Full')] } as never); const inactive = playlistItemContext({ id: 'playlist-a', name: 'Playlist A' }, normalizePlaylistItems({ id: id('playlist-a'), items: [item('item-b', 'Chorus Only')] } as never)[0])!; expect(canReadArrangementCues(state, inactive)).toBe(false); expect(canReadArrangementCues(state, state.playlistItem)).toBe(true); });
  it('recognizes a library presentation as current only without an active playlist identity', () => { const library = libraryPresentationContext('library-a', { id: 'presentation-a', name: 'Presentation A' }); const direct = normalizeCanonicalState({ revision: 1, position, activePlaylist: { presentation: { playlist: null, item: null }, announcements: { playlist: null, item: null } }, status }); expect(isCurrentContext(direct, library)).toBe(true); expect(isCurrentContext(normalizeCanonicalState({ revision: 2, position, activePlaylist: active, status }), library)).toBe(false); });
  it('drops playlist detail context when its presentation does not match the position pair', () => { const mismatched = enrichPlaylistContext(normalizeCanonicalState({ revision: 1, position: { presentation_index: { presentation_id: id('presentation-b'), index: 0 } }, activePlaylist: active, status }), { id: id('playlist-a'), items: [item('item-a', 'Full')] } as never); expect(mismatched.playlistItem).toBeNull(); expect(mismatched.arrangementName).toBeNull(); });
  it('identifies duplicate group names by the current cue rather than the name', () => { const slide = (text: string) => ({ enabled: true, text, notes: '', label: '', color: {} }); const slides = flattenSlides({ groups: [{ name: 'Chorus', color: {}, slides: [slide('A')] }, { name: 'Chorus', color: {}, slides: [slide('B')] }], has_timeline: false, destination: 'presentation' as const }, 'active-arrangement'); expect(activeGroupKey(slides, 1 as never)).toBe('1:Chorus'); });
  it('retains explicit layer state so a cleared slide layer is not rendered as an audience slide', () => { const state = normalizeCanonicalState({ revision: 1, position, activePlaylist: active, status, layers: { video_input: true, media: true, slide: false, announcements: false, props: false, messages: false, audio: false } }); expect(state.outputLayers).toMatchObject({ slide: false, media: true, videoInput: true }); });
  it('decodes the observed runtime status/layers payload', async () => { const runtimeLayers = { video_input: true, media: true, slide: true, announcements: false, props: true, messages: false, audio: false }; await expect(jsonClient(runtimeLayers).layerStatus()).resolves.toEqual(runtimeLayers); });
});

describe('runtime compatibility adapter', () => {
  const playlistTree = [{ id: id('playlist-a', 'Playlist A'), type: 'playlist' as const, playlists: [] }];
  const libraries = [{ id: id('library-a', 'Library A') }];
  const runtimePlaylistTree = [
    { id: { uuid: '4EEDCE13-DD0F-4BE2-ADE2-6FBC5022C110', name: '26.07.16. 수련회', index: 0 }, field_type: 'playlist', children: [] },
    { id: { uuid: '9DBD9C5C-2A37-4624-8C8F-6F8780497B70', name: '주일예배', index: 1 }, field_type: 'playlist', children: [] },
  ];
  const runtimeLibraries = [
    { uuid: '37069776-3F1E-48D6-9758-D9008D9430E5', name: '기본', index: 0 },
    { uuid: '061BEB96-EDF3-46CF-9344-211CBD6DAD48', name: '설교', index: 1 },
  ];

  it('normalizes raw and data-wrapped playlist trees identically', async () => {
    const raw = normalizePlaylistTree(await jsonClient(playlistTree).playlists());
    const wrapped = normalizePlaylistTree(await jsonClient({ data: { playlists: playlistTree } }).playlists());
    expect(wrapped).toEqual(raw);
  });

  it('normalizes the confirmed field_type/children playlist payload', async () => {
    expect(normalizePlaylistTree(await jsonClient(runtimePlaylistTree).playlists())).toEqual([
      { id: '4EEDCE13-DD0F-4BE2-ADE2-6FBC5022C110', name: '26.07.16. 수련회', depth: 0 },
      { id: '9DBD9C5C-2A37-4624-8C8F-6F8780497B70', name: '주일예배', depth: 0 },
    ]);
  });

  it('normalizes raw and data-wrapped libraries', async () => {
    const raw = normalizeLibraries(await jsonClient(libraries).libraries());
    const wrapped = normalizeLibraries(await jsonClient({ data: { libraries } }).libraries());
    expect(wrapped).toEqual(raw);
  });

  it('normalizes direct uuid/name/index library entries to the official library shape', async () => {
    expect(normalizeLibraries(await jsonClient(runtimeLibraries).libraries())).toEqual([
      { id: '37069776-3F1E-48D6-9758-D9008D9430E5', name: '기본' },
      { id: '061BEB96-EDF3-46CF-9344-211CBD6DAD48', name: '설교' },
    ]);
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

  it('decodes every collected golden runtime fixture into domain-compatible DTOs', async () => {
    const playlists = await fixtureClient(playlistsFixture).playlists();
    const libraries = await fixtureClient(librariesFixture).libraries();
    const position = await fixtureClient(presentationSlideIndexFixture).presentationPosition();
    const activePlaylist = await fixtureClient(playlistActiveFixture).activePlaylist();
    const slideStatus = await fixtureClient(statusSlideFixture).slideStatus();
    const activePresentation = await fixtureClient(presentationActiveFixture).activePresentation();
    const playlist = await fixtureClient(playlistDetailFixture).playlist('4EEDCE13-DD0F-4BE2-ADE2-6FBC5022C110');
    const library = await fixtureClient(libraryDetailFixture).library('37069776-3F1E-48D6-9758-D9008D9430E5');
    const presentation = await fixtureClient(presentationDetailFixture).presentation('AACC10B2-F202-4832-9C25-7164D823402D');

    expect(normalizePlaylistTree(playlists)).toHaveLength(4);
    expect(normalizeLibraries(libraries)[0]).toEqual({ id: '37069776-3F1E-48D6-9758-D9008D9430E5', name: '기본' });
    expect(position.presentation_index?.index).toBe(0);
    expect(activePlaylist.presentation?.playlist).toBeNull();
    expect(slideStatus.current?.text).toBe('할렐루야 살아계신 주');
    expect(flattenSlides(activePresentation, 'active-arrangement')).toHaveLength(7);
    expect(normalizePlaylistItems(playlist)).toHaveLength(13);
    expect(library.updateType).toBe('all');
    expect(normalizeLibraryItems(library)).toHaveLength(2);
    expect(flattenSlides(presentation, 'presentation')).toHaveLength(2);
    expect(normalizeCanonicalState({ revision: 1, position, activePlaylist, status: slideStatus }).presentationId)
      .toBe('A748F826-7A09-49CA-ACA1-A09DEC4403CE');
  });

  it('fails with a decode diagnostic for an unknown wrapper', async () => {
    await expect(jsonClient({ data: { unknown: [] } }).libraries()).rejects.toMatchObject({ kind: 'decode', path: '/v1/libraries?chunked=false' });
    await expect(jsonClient({ data: { unknown: [] } }).libraries()).rejects.toThrow(/root shape: object.*detected wrapper key: data/);
  });
});
