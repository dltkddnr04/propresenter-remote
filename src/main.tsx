import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrangementCueIndex, CanonicalState, LibraryPresentationContext, Playlist, PlaylistItem, PlaylistItemContext, PresentationContext, activeGroupKey, activePresentationContext, canTriggerPresentationCue, currentCueIndex, groupStarts, isCurrentContext, libraryPresentationContext, playlistItemContext, remoteDisplayMode, slideText } from './propresenter';
import { isNativeProxy } from './propresenter-client';
import { ProPresenterSessionProvider, activePlaylistThumbnailUrl, genericPresentationThumbnailUrl, useActivePresentationCues, useLibraries, useLibraryItems, usePlaylistItems, usePlaylists, usePresentationCues, useProPresenterSession } from './propresenter-session';
import './styles.css';

const settingsKey = 'propresenter-remote:connection';
export type Settings = { host: string; port: number }; type Source = 'library' | 'playlist'; type RemoteMode = 'text' | 'preview' | 'auto';

export function loadConnectionSettings(storage: Pick<Storage, 'getItem'>, native: boolean, fallback: Settings): Settings | null {
  if (native) return fallback;
  try {
    const value: unknown = JSON.parse(storage.getItem(settingsKey) || 'null');
    if (value && typeof value === 'object' && typeof (value as { host?: unknown }).host === 'string' && Number.isInteger((value as { port?: unknown }).port)) {
      const settings = value as Settings;
      if (settings.host.trim() && settings.port >= 1 && settings.port <= 65535) return settings;
    }
  } catch {
    // A malformed saved value should reopen connection setup, not abort the app bootstrap.
  }
  return null;
}

function Panel({ modal = false, title, children, onClose }: { modal?: boolean; title: string; children: React.ReactNode; onClose?: () => void }) { const content = <section className={modal ? 'settings-panel' : 'card'} role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} onClick={(event) => modal && event.stopPropagation()}><div className="settings-heading"><h2>{title}</h2>{onClose && <button className="icon-button" onClick={onClose}>×</button>}</div>{children}</section>; return modal ? <div className="settings-backdrop" onClick={onClose}>{content}</div> : <main className="shell">{content}</main>; }
function ConnectionForm({ initial, onConnect, onCancel }: { initial?: Settings | null; onConnect: (value: Settings) => void; onCancel?: () => void }) { const [host, setHost] = useState(initial?.host ?? ''); const [port, setPort] = useState(initial?.port ?? 1025); return <form onSubmit={(event) => { event.preventDefault(); onConnect({ host: host.trim(), port: Number(port) }); }}><label>PC IP 주소<input value={host} onChange={(event) => setHost(event.target.value)} required /></label><label>포트 번호<input type="number" value={port} min="1" max="65535" onChange={(event) => setPort(Number(event.target.value))} required /></label><div className="form-actions">{onCancel && <button className="secondary-button" type="button" onClick={onCancel}>취소</button>}<button>ProPresenter 연결</button></div></form>; }
function UnsupportedBrowser() { return <Panel title="지원되지 않는 브라우저"><p className="intro">이 웹앱은 ProPresenter PC의 로컬 네트워크 접근 권한이 필요합니다.</p><p>지원 브라우저 예시: Chrome · Edge · Opera · Firefox</p></Panel>; }

function Thumb({ context, index, quality }: { context: PresentationContext; index: number | null; quality: string }) { const { base, state } = useProPresenterSession(); const activePlaylist = context.source === 'playlist' && isCurrentContext(state, context); const src = activePlaylist && index !== null ? activePlaylistThumbnailUrl(base, context, index, quality) : genericPresentationThumbnailUrl(base, context.presentationId, index, quality); return src ? <img loading="lazy" src={src} alt="" /> : null; }
function PresentationBlock({ context, mode, quality, onRendered, followTarget = false }: { context: PresentationContext; mode: 'preview' | 'text'; quality: string; onRendered?: () => void; followTarget?: boolean }) {
  const { state, commands } = useProPresenterSession();
  const query = usePresentationCues(context);
  const slides = query.data ?? [];
  const active = currentCueIndex(state, context);
  const canTriggerCue = canTriggerPresentationCue(state, context);
  const isInactiveArrangement = context.source === 'playlist' && Boolean(context.arrangementName) && !isCurrentContext(state, context);

  useEffect(() => {
    if (followTarget && slides.length) onRendered?.();
  }, [followTarget, slides.length, onRendered]);

  return (
    <section className="presentation-block" data-context-key={context.cacheKey} data-presentation-id={context.presentationId ?? ''}>
      <div className="presentation-heading">
        <strong>{context.name}</strong>
        <small>{query.isLoading ? '불러오는 중…' : `${slides.length} slides${isInactiveArrangement ? ' · 기본 cue 보기' : ''}`}</small>
      </div>
      {query.error && <p className="form-error">프레젠테이션을 불러올 수 없습니다.</p>}
      <div className="slide-grid">
        {slides.map((slide) => (
          <button
            key={`${context.cacheKey}-${slide.cueIndex}`}
            className={`slide-card ${active === slide.cueIndex ? 'active' : ''}`}
            data-context-key={context.cacheKey}
            data-slide-index={slide.cueIndex}
            disabled={!canTriggerCue}
            title={!canTriggerCue ? '비활성 재생목록 항목은 읽기 전용이며 개별 cue를 실행할 수 없습니다.' : undefined}
            onClick={() => {
              if (context.source === 'library') void commands.triggerLibraryCue(context, slide.cueIndex).catch(() => undefined);
              else void commands.triggerPresentationCue(slide.cueIndex as ArrangementCueIndex).catch(() => undefined);
            }}
          >
            <span className={`slide-preview ${mode === 'text' ? 'text-slide' : ''}`}>
              {mode === 'preview' ? <Thumb context={context} index={slide.cueIndex} quality={quality} /> : slideText(slide) || `${slide.cueIndex + 1}`}
            </span>
            <span className="slide-meta" style={slide.groupColor ? { backgroundColor: slide.groupColor } : undefined}>
              <span>{slide.cueIndex + 1}</span>
              {slide.groupName && <span>{slide.groupName}</span>}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
function playlistItemTypeLabel(type: PlaylistItem['type']): string {
  return ({ presentation: '프레젠테이션', placeholder: '자리 표시자', header: '헤더', media: '미디어', audio: '오디오', livevideo: '라이브 비디오' } as Record<PlaylistItem['type'], string>)[type];
}
function PlaylistItemBlock({ item, context }: { item: PlaylistItem; context: PlaylistItemContext | null }) {
  return <section className="playlist-item-block" data-context-key={context?.cacheKey ?? `playlist-item:${item.index}`}>
    <div className="presentation-heading"><strong>{item.name}</strong><small>{playlistItemTypeLabel(item.type)}</small></div>
  </section>;
}
function PlaylistWorkspace({ playlist, items, mode, quality, browseTarget, liveContext, following, workspace, onRendered }: { playlist: Playlist | null; items: PlaylistItem[]; mode: 'preview' | 'text'; quality: string; browseTarget: PlaylistItemContext | null; liveContext: PresentationContext | null; following: boolean; workspace: React.RefObject<HTMLElement | null>; onRendered: () => void }) {
  const entries = useMemo(() => items.map((item) => ({ item, context: playlist ? playlistItemContext(playlist, item) : null })), [items, playlist]);
  const liveKey = liveContext?.source === 'playlist' ? liveContext.cacheKey : null;
  const hasLiveBlock = liveKey !== null && entries.some((entry) => entry.context?.cacheKey === liveKey);
  const browseKey = browseTarget?.cacheKey ?? null;

  useEffect(() => {
    if (!browseKey || !workspace.current) return;
    const target = Array.from(workspace.current.querySelectorAll<HTMLElement>('.presentation-block')).find((element) => element.dataset.contextKey === browseKey);
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [browseKey, workspace]);

  return <div className="presentation-list" data-workspace-source="playlist">
    {entries.map(({ item, context }) => context?.presentationId ? <PresentationBlock key={context.cacheKey} context={context} mode={mode} quality={quality} followTarget={following && context.cacheKey === liveKey} onRendered={onRendered} /> : <PlaylistItemBlock key={context?.cacheKey ?? `playlist-item:${item.index}`} item={item} context={context} />)}
    {!hasLiveBlock && liveContext?.source === 'active' && <PresentationBlock key={liveContext.cacheKey} context={liveContext} mode={mode} quality={quality} followTarget={following} onRendered={onRendered} />}
    {!items.length && <p className="sidebar-child-empty">재생목록 항목이 없습니다.</p>}
  </div>;
}
function Sidebar({ source, setSource, selectedPlaylist, setSelectedPlaylist, selectedLibrary, setSelectedLibrary, initializeSelectedLibrary, setPresentation }: { source: Source; setSource: (source: Source) => void; selectedPlaylist: string | null; setSelectedPlaylist: (id: string) => void; selectedLibrary: string | null; setSelectedLibrary: (id: string) => void; initializeSelectedLibrary: (id: string) => void; setPresentation: (value: PresentationContext | null) => void }) {
  const playlists = usePlaylists(); const libraries = useLibraries(); const playlist = playlists.data?.find((entry) => entry.id === selectedPlaylist); const library = libraries.data?.find((entry) => entry.id === selectedLibrary); const playlistItems = usePlaylistItems(selectedPlaylist, source === 'playlist'); const libraryItems = useLibraryItems(selectedLibrary, source === 'library'); const { state } = useProPresenterSession();
  useEffect(() => { if (!selectedLibrary && libraries.data?.[0]) initializeSelectedLibrary(libraries.data[0].id); }, [initializeSelectedLibrary, libraries.data, selectedLibrary]);
  const items = source === 'playlist' ? playlistItems.data ?? [] : libraryItems.data ?? [];
  return <div className="sidebar-browser"><div className="sidebar-source-tabs"><button className={source === 'library' ? 'active sidebar-source-tab' : 'sidebar-source-tab'} onClick={() => setSource('library')}>라이브러리</button><button className={source === 'playlist' ? 'active sidebar-source-tab' : 'sidebar-source-tab'} onClick={() => setSource('playlist')}>재생목록</button></div><div className="sidebar-collection-list">{source === 'playlist' ? playlists.data?.map((entry) => <button key={entry.id} className={`sidebar-collection-item ${entry.id === selectedPlaylist ? 'active' : ''}`} style={{ paddingLeft: 10 + entry.depth * 15 }} onClick={() => setSelectedPlaylist(entry.id)}>{entry.name}</button>) : libraries.data?.map((entry) => <button key={entry.id} className={`sidebar-collection-item ${entry.id === selectedLibrary ? 'active' : ''}`} onClick={() => setSelectedLibrary(entry.id)}>{entry.name}</button>)}</div><section className="sidebar-selected-items"><div className="sidebar-selected-heading">{source === 'playlist' ? playlist?.name : library?.name}</div><div className="sidebar-item-list">{items.map((item) => { const context = source === 'playlist' ? playlist ? playlistItemContext(playlist, item as Parameters<typeof playlistItemContext>[1]) : null : library ? libraryPresentationContext(library.id, item as Parameters<typeof libraryPresentationContext>[1]) : null; if (!context?.presentationId) return null; const active = isCurrentContext(state, context); return <button key={context.cacheKey} className={`sidebar-item-button ${active ? 'active' : ''}`} onClick={() => setPresentation(context)}>{context.name}</button>; })}</div></section></div>;
}
function TopNav({ settings, title, following, follow, connection, appSettings }: { settings: Settings; title: string; following: boolean; follow: () => void; connection: () => void; appSettings: () => void }) { const { state, connection: stateConnection } = useProPresenterSession(); const label = stateConnection.status === 'connected' && state ? '연결됨' : stateConnection.status === 'error' ? '연결 오류' : '확인 중'; return <nav className="top-nav"><strong>ProPresenter Remote</strong><span className="top-playlist">{title}</span><div className="top-actions"><button className={`top-live-badge connection-${stateConnection.status}`} onClick={connection}><span className={`status-dot ${stateConnection.status}`} aria-hidden="true" />{settings.host}:{settings.port} · {label}</button><button className="top-follow-button" disabled={following} onClick={follow}>{following ? '현재 슬라이드 추적 중' : '현재 슬라이드 따라가기'}</button><button onClick={() => window.location.assign('/remote')}>리모컨</button><button onClick={appSettings}>앱 설정</button></div></nav>; }
function Controller({ settings, onConnection }: { settings: Settings; onConnection: () => void }) {
  const { state, connection, commands } = useProPresenterSession();
  const allPlaylists = usePlaylists();
  const [source, setSource] = useState<Source>('playlist');
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null);
  const [selectedLibrary, setSelectedLibrary] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<PresentationContext | null>(null);
  const [following, setFollowing] = useState(true);
  const [mode, setMode] = useState<'preview' | 'text'>(() => localStorage.getItem('propresenter-remote:slide-mode') === 'text' ? 'text' : 'preview');
  const [quality, setQuality] = useState(() => localStorage.getItem('propresenter-remote:thumbnail-quality') ?? '256');
  const [showSettings, setShowSettings] = useState(false);
  const [rendered, setRendered] = useState(0);
  const workspace = useRef<HTMLElement>(null);
  // Derive the initial workspace selection from the canonical active playlist
  // as soon as it is available. The state setter below keeps the selection
  // stable for later browsing, but the derived value prevents the first
  // render from leaving the playlist query disabled while the effect runs.
  const effectiveSelectedPlaylist = selectedPlaylist ?? (following && state ? state.playlistId ?? allPlaylists.data?.[0]?.id ?? null : null);
  const selectedPlaylistItems = usePlaylistItems(effectiveSelectedPlaylist, source === 'playlist');
  const playlist = allPlaylists.data?.find((item) => item.id === effectiveSelectedPlaylist) ?? null;

  useEffect(() => {
    if (!following || !state || !allPlaylists.data?.length) return;
    if (state.playlistId) {
      if (!allPlaylists.data.some((item) => item.id === state.playlistId)) return;
      if (selectedPlaylist !== state.playlistId) setSelectedPlaylist(state.playlistId);
      return;
    }
    if (!selectedPlaylist) setSelectedPlaylist(allPlaylists.data[0].id);
  }, [allPlaylists.data, following, selectedPlaylist, state?.playlistId]);
  useEffect(() => {
    if (following && state?.playlistId) {
      setSource('playlist');
      setSelectedPlaylist(state.playlistId);
      setPresentation(null);
    }
  }, [following, state?.playlistId]);
  // Only an enriched playlist item has a verified playlist identity. If the
  // focused item and slide_index disagree, keep the output presentation
  // unscoped instead of attaching the wrong arrangement to it.
  const activeContext = state?.presentationId && state.outputLayers?.slide !== false && !state.playlistItem ? activePresentationContext(state.presentationId, state.presentationName) : null;
  const liveContext = state?.playlistItem ?? activeContext;
  const selectedLibraryPresentation = presentation?.source === 'library' ? presentation : state?.playlistItem ?? activeContext;
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const next = ['ArrowRight', 'ArrowDown', ' '].includes(event.key) || event.code === 'Space';
      const previous = ['ArrowLeft', 'ArrowUp'].includes(event.key);
      if (!next && !previous) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.repeat || event.defaultPrevented || showSettings || document.querySelector('dialog,[role="dialog"]') || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),dialog,[role="dialog"]')) return;
      event.preventDefault();
      void (next ? commands.next() : commands.previous()).catch(() => undefined);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commands, showSettings]);
  useEffect(() => {
    const context = liveContext;
    const index = state?.slideIndex;
    if (!following || !workspace.current || !context || index === null) return;
    const target = Array.from(workspace.current.querySelectorAll<HTMLElement>('.slide-card')).find((card) => card.dataset.contextKey === context.cacheKey && Number(card.dataset.slideIndex) === index);
    if (target && typeof workspace.current.scrollTo === 'function') {
      const box = workspace.current.getBoundingClientRect();
      const slide = target.getBoundingClientRect();
      workspace.current.scrollTo({ top: Math.max(0, workspace.current.scrollTop + slide.top - box.top - (workspace.current.clientHeight / 3 - slide.height / 2)), behavior: 'smooth' });
    }
  }, [following, rendered, liveContext?.cacheKey, state?.slideIndex]);
  const playlistBrowseTarget = presentation?.source === 'playlist' && presentation.playlistId === effectiveSelectedPlaylist ? presentation : null;
  const title = state?.playlistId ? `${state.playlistName ?? '재생목록'} / ${state.playlistItem?.name ?? state.presentationName ?? '현재 프레젠테이션'}` : state?.presentationName ?? '재생목록';
  const handleRendered = useCallback(() => setRendered((value) => value + 1), []);
  return <><TopNav settings={settings} title={title} following={following} follow={() => { setFollowing(true); setPresentation((current) => current?.source === 'library' && isCurrentContext(state, current) ? current : null); setRendered((value) => value + 1); }} connection={onConnection} appSettings={() => setShowSettings(true)} /><main className="control-app" data-presentation-id={state?.presentationId ?? ''} data-slide-index={state?.slideIndex ?? ''} data-connection-status={connection.status}><aside className="sidebar"><Sidebar source={source} setSource={(next) => { setFollowing(false); setSource(next); setPresentation(null); }} selectedPlaylist={effectiveSelectedPlaylist} setSelectedPlaylist={(id) => { setFollowing(false); setSelectedPlaylist(id); setPresentation(null); }} selectedLibrary={selectedLibrary} setSelectedLibrary={(id) => { setFollowing(false); setSelectedLibrary(id); setPresentation(null); }} initializeSelectedLibrary={setSelectedLibrary} setPresentation={(value) => { setFollowing(false); setPresentation(value); }} /></aside><section className="workspace" ref={workspace} tabIndex={0} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)}>{source === 'playlist' ? <PlaylistWorkspace playlist={playlist} items={selectedPlaylistItems.data ?? []} mode={mode} quality={quality} browseTarget={playlistBrowseTarget} liveContext={liveContext} following={following} workspace={workspace} onRendered={handleRendered} /> : selectedLibraryPresentation ? <PresentationBlock context={selectedLibraryPresentation} mode={mode} quality={quality} followTarget={following && isCurrentContext(state, selectedLibraryPresentation)} onRendered={handleRendered} /> : <p className="sidebar-child-empty">프레젠테이션을 선택하세요.</p>}</section></main>{showSettings && <Panel modal title="앱 설정" onClose={() => setShowSettings(false)}><label>슬라이드 표시 방식<select value={mode} onChange={(event) => { const value = event.target.value as 'preview' | 'text'; localStorage.setItem('propresenter-remote:slide-mode', value); setMode(value); }}><option value="preview">미리보기</option><option value="text">텍스트</option></select></label><label>미리보기 해상도<select value={quality} onChange={(event) => { localStorage.setItem('propresenter-remote:thumbnail-quality', event.target.value); setQuality(event.target.value); }}>{['64', '128', '256', '512'].map((value) => <option key={value}>{value}</option>)}</select></label></Panel>}{commands.error && <p className="remote-command-error">{commands.error}</p>}</>;
}
function RemoteSlide({ label, text, preview }: { label: string; text: string; preview: string | null }) { return <section className={`remote-slide ${preview ? 'remote-preview' : 'remote-text'}`}><span className="remote-slide-label">{label}</span>{preview ? <img src={preview} alt={`${label} 슬라이드 미리보기`} /> : <p>{text || '표시할 슬라이드가 없습니다.'}</p>}</section>; }
function Remote() {
  const { base, state, connection, commands } = useProPresenterSession(); const [mode, setMode] = useState<RemoteMode>('auto');
  const activeCues = useActivePresentationCues(); const cues = activeCues.data ?? []; const context = state?.playlistItem ?? null;
  const current = state?.slideIndex ?? null; const display = remoteDisplayMode(mode, state?.currentCue ?? null); const slideOutput = state?.outputLayers?.slide !== false;
  const playlistPreview = context && isCurrentContext(state, context) && current !== null ? activePlaylistThumbnailUrl(base, context, current, '512') : null;
  const preview = display === 'preview' && slideOutput ? playlistPreview ?? genericPresentationThumbnailUrl(base, state?.presentationId ?? null, current, '512') : null;
  const groups = useMemo(() => groupStarts(cues), [cues]); const currentGroup = activeGroupKey(cues, current);
  const mixedOutput = slideOutput && Boolean(state?.outputLayers && (state.outputLayers.media || state.outputLayers.videoInput || state.outputLayers.props || state.outputLayers.announcements));
  const outputMessage = !slideOutput ? state?.outputLayers?.media || state?.outputLayers?.videoInput ? '슬라이드 레이어가 꺼져 있습니다. 미디어 또는 비디오 입력 출력 중입니다.' : '슬라이드 레이어가 꺼져 있습니다.' : '';
  const currentText = outputMessage || state?.currentCue?.text || '';
  return <main className="remote-app" data-presentation-id={state?.presentationId ?? ''} data-slide-index={state?.slideIndex ?? ''} data-connection-status={connection.status}><section className="remote-screen"><header className="remote-header"><button className="remote-back" onClick={() => window.location.assign('/')}>컨트롤러</button><div className="remote-mode-switch">{(['text', 'preview', 'auto'] as RemoteMode[]).map((entry) => <button key={entry} className={mode === entry ? 'active' : ''} onClick={() => setMode(entry)}>{entry === 'text' ? '텍스트' : entry === 'preview' ? '미리보기' : '자동'}</button>)}</div><span className={`remote-status connection-${connection.status}`}><span className={`status-dot ${connection.status}`} aria-hidden="true" />{connection.status === 'connected' ? '연결됨' : connection.status === 'error' ? '연결 오류' : '확인 중'}</span></header>{commands.error && <p className="remote-command-error" role="alert">{commands.error}</p>}<div className={`remote-slides ${display === 'preview' ? 'single' : ''}`}><RemoteSlide label={mixedOutput ? '현재 슬라이드 · 합성 출력' : '현재'} text={currentText} preview={preview} />{display === 'text' && <RemoteSlide label="다음" text={slideOutput ? state?.nextCue?.text ?? '' : ''} preview={null} />}</div></section><section className="remote-control-area"><section className="remote-controls"><button className="remote-control previous" onClick={() => void commands.previous().catch(() => undefined)}>‹<span>이전</span></button><button className="remote-control next" onClick={() => void commands.next().catch(() => undefined)}><span>다음</span>›</button></section><nav className="remote-group-strip">{groups.map((group) => <button key={group.key} className={group.key === currentGroup ? 'active' : ''} disabled={!slideOutput} onClick={() => void commands.triggerActiveGroup(group.index).catch(() => undefined)}>{group.name}</button>)}</nav></section></main>;
}
export function SessionApp({ settings, connection }: { settings: Settings; connection: () => void }) { const path = typeof location === 'undefined' ? '/' : location.pathname; return <ProPresenterSessionProvider settings={settings}>{path === '/remote' ? <Remote /> : <Controller settings={settings} onConnection={connection} />}</ProPresenterSessionProvider>; }
export function App() {
  const native = isNativeProxy();
  const fallback: Settings = { host: location.hostname || '127.0.0.1', port: 1025 };
  const [supported, setSupported] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings | null>(() => loadConnectionSettings(localStorage, native, fallback));
  const [modal, setModal] = useState(false);
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      if (native) return mounted && setSupported(true);
      // PermissionManager support is only a browser capability hint. A rejected
      // or pending permission query must not prevent a configured session from
      // attempting the actual ProPresenter request.
      if (!window.isSecureContext) return mounted && setSupported(false);
      if (mounted) setSupported(true);
      if (!navigator.permissions?.query) return;
      try {
        await navigator.permissions.query({ name: 'local-network' as PermissionName });
      } catch {
        // Local Network Access is established by the fetch itself. Keep the
        // session mounted so its connection state can report the real result.
      }
    };
    void check();
    return () => { mounted = false; };
  }, [native]);
  const connect = (value: Settings) => { if (!native) localStorage.setItem(settingsKey, JSON.stringify(value)); setSettings(value); setModal(false); };
  if (supported === null) return null;
  if (!supported) return <UnsupportedBrowser />;
  if (!settings) return <Panel title="연결 설정"><ConnectionForm onConnect={connect} /></Panel>;
  return <><SessionApp settings={settings} connection={() => setModal(true)} />{modal && <Panel modal title="연결 정보" onClose={() => setModal(false)}><ConnectionForm initial={settings} onConnect={connect} onCancel={() => setModal(false)} /></Panel>}</>;
}
