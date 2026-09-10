import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  ApiObject,
  CanonicalState,
  PlaylistItemContext,
  PresentationContext,
  api,
  currentCueIndex,
  groupStarts,
  isNativeProxy,
  libraryPresentationContext,
  listArray,
  objectId,
  objectName,
  playlistItemContext,
  playlistItemId,
  playlistItems,
  remoteDisplayMode,
  slideText,
  unwrap,
} from './propresenter';
import {
  ProPresenterSessionProvider,
  genericPresentationThumbnailUrl,
  presentationThumbnailUrl,
  usePresentationCues,
  useProPresenterSession,
} from './propresenter-session';
import './styles.css';

const settingsKey = 'propresenter-remote:connection';
type Settings = { host: string; port: number };
type Playlist = ApiObject & { id: string; name: string; depth: number };
type Library = ApiObject & { id: string; name: string };
type RemoteMode = 'text' | 'preview' | 'auto';

function flattenPlaylists(data: unknown): Playlist[] {
  const result: Playlist[] = [];
  const walk = (value: unknown, depth = 0) => listArray(value).forEach((item) => {
    const id = objectId(item);
    if (id) result.push({ ...item, id, name: objectName(item), depth });
    ['children', 'playlists'].forEach((key) => { if (Array.isArray(item[key])) walk(item[key], depth + 1); });
  });
  walk(data);
  return result;
}

function flattenLibraries(data: unknown): Library[] {
  return listArray(unwrap(data)).flatMap((item) => {
    const id = objectId(item);
    return id ? [{ ...item, id, name: objectName(item, '이름 없는 라이브러리') }] : [];
  });
}

function ConnectionForm({ initial, onConnect, onCancel }: { initial?: Settings | null; onConnect: (settings: Settings) => void; onCancel?: () => void }) {
  const [host, setHost] = useState(initial?.host || '');
  const [port, setPort] = useState<number | string>(initial?.port || 1025);
  const [error, setError] = useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validHost = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host.trim());
    const numericPort = Number(port);
    if (!validHost) return setError('올바른 IPv4 주소를 입력하세요.');
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return setError('포트 번호는 1에서 65535 사이의 정수여야 합니다.');
    setError(''); onConnect({ host: host.trim(), port: numericPort });
  };
  return <form onSubmit={submit}><label>PC IP 주소<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="예: 192.168.0.10" autoComplete="off" required /></label><span className="hint">같은 네트워크에 있는 ProPresenter PC의 IPv4 주소</span><label>포트 번호<input type="number" value={port} onChange={(event) => setPort(event.target.value)} min="1" max="65535" required /></label>{error && <p className="form-error">{error}</p>}<div className="form-actions">{onCancel && <button type="button" className="secondary-button" onClick={onCancel}>취소</button>}<button type="submit">ProPresenter 연결</button></div></form>;
}

function AppPanel({ mode, eyebrow, title, titleId, onClose, children }: { mode: 'page' | 'modal'; eyebrow: string; title: string; titleId: string; onClose?: () => void; children: React.ReactNode }) {
  if (mode === 'modal') return <div className="settings-backdrop" role="presentation" onClick={onClose}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}><div className="settings-heading"><div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label={`${title} 닫기`}>×</button></div>{children}</section></div>;
  return <main className="shell"><section className="card"><span className="eyebrow">{eyebrow}</span><h1 id={titleId}>{title}</h1>{children}</section></main>;
}

function Setup({ onConnect }: { onConnect: (settings: Settings) => void }) { const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null') as Settings | null; return <AppPanel mode="page" eyebrow="PROPRESENTER REMOTE" title="연결 설정" titleId="connection-setup-title"><p className="intro">조작할 ProPresenter가 설치된 PC의 네트워크 정보를 입력하세요.</p><ConnectionForm initial={saved} onConnect={onConnect} /></AppPanel>; }
function ConnectionSettingsPanel({ settings, onConnect, onClose }: { settings: Settings; onConnect: (settings: Settings) => void; onClose: () => void }) { return <AppPanel mode="modal" eyebrow="CONNECTION" title="연결 정보" titleId="connection-settings-title" onClose={onClose}><ConnectionForm initial={settings} onConnect={onConnect} onCancel={onClose} /></AppPanel>; }
function BrowserSupportNotice() { return <AppPanel mode="page" eyebrow="BROWSER CHECK" title="지원되지 않는 브라우저" titleId="browser-support-title"><p className="intro">이 웹앱은 ProPresenter가 설치된 PC의 로컬 네트워크에 접근할 수 있어야 작동합니다.</p><p>Local Network Access를 지원하는 최신 브라우저에서 다시 열어주세요.</p><p className="browser-examples"><strong>지원 브라우저 예시</strong><span>Chrome · Edge · Opera · Firefox</span></p></AppPanel>; }

function useNearViewport() {
  const ref = useRef<HTMLElement>(null); const [near, setNear] = useState(false);
  useEffect(() => { const node = ref.current; if (!node || !('IntersectionObserver' in window)) return setNear(true); const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setNear(true); observer.disconnect(); } }, { rootMargin: '900px 0px' }); observer.observe(node); return () => observer.disconnect(); }, []);
  return { ref, near };
}

function SlideThumbnail({ context, index, quality }: { context: PresentationContext; index: number; quality: string }) {
  const { base } = useProPresenterSession();
  const primary = presentationThumbnailUrl(base, context, index, quality);
  const fallback = genericPresentationThumbnailUrl(base, context.presentationId, index, quality);
  return primary ? <img loading="lazy" src={primary} alt="" onError={(event) => { if (fallback && event.currentTarget.src !== fallback) event.currentTarget.src = fallback; }} /> : null;
}

function PresentationBlock({ context, slideMode, thumbnailQuality, onReady }: { context: PresentationContext; slideMode: 'preview' | 'text'; thumbnailQuality: string; onReady: () => void }) {
  const { state, commands } = useProPresenterSession();
  const { ref, near } = useNearViewport();
  const query = usePresentationCues(context, { enabled: near || currentCueIndex(state, context) >= 0 });
  const slides = query.data || [];
  useEffect(() => { if (slides.length) onReady(); }, [onReady, slides.length]);
  const activeIndex = currentCueIndex(state, context);
  const trigger = (index: number) => {
    const command = context.source === 'playlist'
      ? commands.triggerPlaylistCue(context, index)
      : commands.triggerLibraryCue(context.libraryId, context.presentationId, index);
    void command.catch(() => undefined);
  };
  return <section ref={ref} className="presentation-block"><div className="presentation-heading"><strong>{context.name}</strong><small>{query.isLoading ? '불러오는 중…' : `${slides.length} slides`}</small></div>{query.isLoading && <p className="sidebar-status">슬라이드 조회 중…</p>}{query.error && <p className="form-error">프레젠테이션을 불러올 수 없습니다.</p>}{!query.isLoading && <div className="slide-grid">{slides.map((slide, index) => <button className={`slide-card ${activeIndex === index ? 'active' : ''}`} data-context-key={context.cacheKey} data-slide-index={index} key={`${context.cacheKey}-${index}`} onClick={() => trigger(index)} disabled={commands.pending}>{slideMode === 'preview' ? <span className="slide-preview"><SlideThumbnail context={context} index={index} quality={thumbnailQuality} /></span> : <span className="slide-preview text-slide">{slideText(slide) || `${index + 1}`}</span>}<span className="slide-meta" style={slide.groupColor ? { backgroundColor: slide.groupColor } : undefined}><span>{index + 1}</span>{slide.groupName && <span>{slide.groupName}</span>}</span></button>)}</div>}</section>;
}

function TopNav({ settings, state, title, following, onFollow, onSettings, onConnection }: { settings: Settings; state: CanonicalState | null; title: string; following: boolean; onFollow: () => void; onSettings: () => void; onConnection: () => void }) { const { connection } = useProPresenterSession(); return <nav className="top-nav"><strong>ProPresenter Remote</strong><span className="top-playlist">{title}</span><div className="top-actions"><button className="top-live-badge" onClick={onConnection} aria-label="연결 정보 수정" title="연결 정보 수정"><span className="status-dot" />{settings.host}:{settings.port} · {connection.status === 'connected' && state ? '연결됨' : connection.status === 'error' ? '연결 오류' : '연결 확인 중'}</button><button className="top-follow-button" disabled={following} onClick={onFollow}>{following ? '현재 슬라이드 추적 중' : '현재 슬라이드 따라가기'}</button><button onClick={() => window.location.assign('/remote')}>리모컨</button><button onClick={onSettings}>앱 설정</button></div></nav>; }

function SidebarBrowser({ base, source, state, playlists, selectedPlaylist, playlistItemsData, playlistLoading, playlistError, onSourceChange, onPlaylistSelect, onLibraryPresentation, onPresentationSelect }: { base: string; source: 'playlist' | 'library'; state: CanonicalState | null; playlists: Playlist[]; selectedPlaylist: Playlist | undefined; playlistItemsData: ApiObject[]; playlistLoading: boolean; playlistError: Error | null; onSourceChange: (source: 'playlist' | 'library') => void; onPlaylistSelect: (playlistId: string) => void; onLibraryPresentation: (context: PresentationContext) => void; onPresentationSelect: (context: PlaylistItemContext) => void }) {
  const librariesQuery = useQuery({ queryKey: ['libraries', base], queryFn: ({ signal }) => api(base, '/v1/libraries?chunked=false', signal).then(flattenLibraries), retry: 1 });
  const libraries = librariesQuery.data || [];
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const selectedLibrary = libraries.find((library) => library.id === selectedLibraryId);
  const libraryItemsQuery = useQuery({ queryKey: ['library', base, selectedLibraryId], queryFn: ({ signal }) => api(base, `/v1/library/${encodeURIComponent(selectedLibraryId as string)}?chunked=false`, signal).then((data) => listArray(unwrap(data))), enabled: source === 'library' && Boolean(selectedLibraryId), retry: 1 });
  useEffect(() => { if (!selectedLibraryId && libraries.length) setSelectedLibraryId(libraries[0].id); }, [libraries, selectedLibraryId]);
  const selectedName = source === 'library' ? selectedLibrary?.name : selectedPlaylist?.name;
  const selectedItems = source === 'library' ? libraryItemsQuery.data || [] : playlistItemsData;
  const selectedLoading = source === 'library' ? libraryItemsQuery.isLoading : playlistLoading;
  const selectedError = source === 'library' ? libraryItemsQuery.error as Error | null : playlistError;
  return <div className="sidebar-browser"><div className="sidebar-source-tabs" role="tablist" aria-label="콘텐츠 종류"><button className={`sidebar-source-tab ${source === 'library' ? 'active' : ''}`} role="tab" aria-selected={source === 'library'} onClick={() => onSourceChange('library')}>라이브러리</button><button className={`sidebar-source-tab ${source === 'playlist' ? 'active' : ''}`} role="tab" aria-selected={source === 'playlist'} onClick={() => onSourceChange('playlist')}>재생목록</button></div><div className="sidebar-collection-list">{source === 'library' && <>{librariesQuery.isLoading && <p className="sidebar-status">라이브러리 조회 중…</p>}{librariesQuery.error && <p className="form-error">연결 실패: {(librariesQuery.error as Error).message}</p>}{libraries.map((library) => <button key={library.id} className={`sidebar-collection-item ${library.id === selectedLibraryId ? 'active' : ''}`} onClick={() => { setSelectedLibraryId(library.id); onSourceChange('library'); }}>{library.name}</button>)}</>}{source === 'playlist' && <>{playlistLoading && !playlists.length && <p className="sidebar-status">재생목록 조회 중…</p>}{playlistError && <p className="form-error">연결 실패: {playlistError.message}</p>}{playlists.map((playlist) => <button key={playlist.id} className={`sidebar-collection-item ${playlist.id === selectedPlaylist?.id ? 'active' : ''}`} style={{ paddingLeft: 10 + playlist.depth * 15 }} onClick={() => { onPlaylistSelect(playlist.id); onSourceChange('playlist'); }}>{playlist.name}</button>)}</>}</div><section className="sidebar-selected-items" aria-label={selectedName ? `${selectedName} 항목` : '선택한 항목'}><div className="sidebar-selected-heading">{selectedName || '항목을 선택하세요'}</div>{selectedLoading && <p className="sidebar-status">항목 불러오는 중…</p>}{selectedError && <p className="form-error">항목을 불러올 수 없습니다.</p>}{!selectedLoading && !selectedItems.length && selectedName && <p className="sidebar-child-empty">항목 없음</p>}<div className="sidebar-item-list">{selectedItems.map((item, index) => { if (item.type === 'header') return <span className="sidebar-item-heading" key={`sidebar-header-${index}`}>{objectName(item, '구분')}</span>; const context = source === 'playlist' ? selectedPlaylist ? playlistItemContext(selectedPlaylist.id, item, index) : null : selectedLibrary ? libraryPresentationContext(selectedLibrary.id, item) : null; if (!context?.presentationId) return null; const current = context.source === 'playlist' && state?.playlistItemId === context.playlistItemId; return <button className={`sidebar-item-button ${current ? 'active' : ''}`} aria-current={current ? 'true' : undefined} key={context.cacheKey} onClick={() => context.source === 'playlist' ? onPresentationSelect(context) : onLibraryPresentation(context)}>{context.name}</button>; })}</div></section></div>;
}

function Controller({ settings, onConnection }: { settings: Settings; onConnection: () => void }) {
  const { base, state, commands } = useProPresenterSession();
  const [source, setSource] = useState<'playlist' | 'library'>('playlist'); const [selected, setSelected] = useState<string | null>(null); const [selectedLibrary, setSelectedLibrary] = useState<PresentationContext | null>(null); const [following, setFollowing] = useState(true); const [showSettings, setShowSettings] = useState(false); const [slideMode, setSlideMode] = useState<'preview' | 'text'>(() => localStorage.getItem('propresenter-remote:slide-mode') === 'text' ? 'text' : 'preview'); const [thumbnailQuality, setThumbnailQuality] = useState(() => localStorage.getItem('propresenter-remote:thumbnail-quality') || '256'); const [renderVersion, setRenderVersion] = useState(0); const [followRequest, setFollowRequest] = useState(0); const workspaceRef = useRef<HTMLElement>(null);
  const markRendered = useCallback(() => setRenderVersion((value) => value + 1), []); const disableFollowing = () => setFollowing(false);
  const playlistsQuery = useQuery({ queryKey: ['playlists', base], queryFn: ({ signal }) => api(base, '/v1/playlists?chunked=false', signal).then(flattenPlaylists), retry: 1 }); const playlists = playlistsQuery.data || [];
  useEffect(() => { if (!selected && playlists.length) setSelected(state?.playlistId && playlists.some((item) => item.id === state.playlistId) ? state.playlistId : playlists[0].id); }, [playlists, selected, state?.playlistId]);
  useEffect(() => { if (following && state?.playlistId && playlists.some((item) => item.id === state.playlistId)) { setSource('playlist'); setSelectedLibrary(null); setSelected(state.playlistId); } }, [following, playlists, state?.playlistId]);
  const selectedPlaylist = playlists.find((item) => item.id === selected);
  const itemsQuery = useQuery({ queryKey: ['playlist', base, selected], queryFn: ({ signal }) => api(base, `/v1/playlist/${encodeURIComponent(selected as string)}?chunked=false`, signal).then(playlistItems), enabled: source === 'playlist' && Boolean(selected), retry: 1 });
  useEffect(() => { const handleKeyDown = (event: KeyboardEvent) => { if (event.repeat || commands.pending) return; const target = event.target as HTMLElement | null; const textEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable; if (textEntry || target?.closest('[role="dialog"]')) return; const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' '; const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp'; if (!next && !previous) return; if (event.key === ' ' && target?.closest('button, a')) return; event.preventDefault(); void (next ? commands.next() : commands.previous()).catch(() => undefined); }; window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown); }, [commands]);
  useEffect(() => { if (!following || !state?.playlistItem || state.slideIndex < 0) return; const workspace = workspaceRef.current; const target = workspace?.querySelector<HTMLButtonElement>(`.slide-card[data-context-key="${state.playlistItem.cacheKey}"][data-slide-index="${state.slideIndex}"]`); if (!workspace || !target) return; const box = workspace.getBoundingClientRect(); const slide = target.getBoundingClientRect(); workspace.scrollTo({ top: Math.max(0, workspace.scrollTop + slide.top - box.top - (workspace.clientHeight / 3 - slide.height / 2)), behavior: 'smooth' }); }, [following, followRequest, renderVersion, state?.playlistItem?.cacheKey, state?.slideIndex]);
  const activeItem = (itemsQuery.data || []).find((item) => playlistItemId(item) === state?.playlistItemId); const title = source === 'library' ? `라이브러리 / ${selectedLibrary?.name || '프레젠테이션'}` : `${selectedPlaylist?.name || '재생목록'}${activeItem ? ` / ${objectName(activeItem)}` : ''}`;
  const focusPresentation = (context: PlaylistItemContext) => { setSource('playlist'); disableFollowing(); workspaceRef.current?.querySelector<HTMLElement>(`.slide-card[data-context-key="${context.cacheKey}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return <><TopNav settings={settings} state={state} title={title} following={following} onFollow={() => { setFollowing(true); setFollowRequest((value) => value + 1); }} onSettings={() => setShowSettings(true)} onConnection={onConnection} /><main className="control-app"><aside className="sidebar"><SidebarBrowser base={base} source={source} state={state} playlists={playlists} selectedPlaylist={selectedPlaylist} playlistItemsData={itemsQuery.data || []} playlistLoading={itemsQuery.isLoading} playlistError={itemsQuery.error as Error | null} onSourceChange={(nextSource) => { disableFollowing(); setSource(nextSource); }} onPlaylistSelect={(playlistId) => { disableFollowing(); setSelectedLibrary(null); setSelected(playlistId); }} onLibraryPresentation={(context) => { disableFollowing(); setSource('library'); setSelectedLibrary(context); }} onPresentationSelect={focusPresentation} /></aside><section ref={workspaceRef} className="workspace" onWheel={disableFollowing} onTouchMove={disableFollowing} tabIndex={-1}>{source === 'playlist' && <><>{itemsQuery.isLoading && <p>재생목록 항목 조회 중…</p>}{itemsQuery.error && <p className="form-error">재생목록을 불러올 수 없습니다.</p>}</><div className="presentation-list">{(itemsQuery.data || []).map((item, index) => { if (item.type === 'header') return <div className="header-card" key={`header-${index}`}>{objectName(item, '구분')}</div>; const context = selected ? playlistItemContext(selected, item, index) : null; return context?.presentationId ? <PresentationBlock key={context.cacheKey} context={context} slideMode={slideMode} thumbnailQuality={thumbnailQuality} onReady={markRendered} /> : null; })}</div></>}{source === 'library' && selectedLibrary?.presentationId && <div className="presentation-list"><PresentationBlock context={selectedLibrary} slideMode={slideMode} thumbnailQuality={thumbnailQuality} onReady={markRendered} /></div>}</section></main>{commands.error && <p className="remote-command-error">{commands.error}</p>}{showSettings && <AppPanel mode="modal" eyebrow="SETTINGS" title="앱 설정" titleId="settings-title" onClose={() => setShowSettings(false)}><label className="setting-row">슬라이드 표시 방식<select value={slideMode} onChange={(event) => { const value = event.target.value as 'preview' | 'text'; localStorage.setItem('propresenter-remote:slide-mode', value); setSlideMode(value); }}><option value="preview">미리보기</option><option value="text">텍스트</option></select></label><label className="setting-row">미리보기 해상도<select value={thumbnailQuality} onChange={(event) => { localStorage.setItem('propresenter-remote:thumbnail-quality', event.target.value); setThumbnailQuality(event.target.value); }}>{['64', '128', '256', '512'].map((quality) => <option key={quality} value={quality}>{quality}</option>)}</select></label><p className="intro">현재 슬라이드 추적은 사용자가 스크롤하면 해제되며, 상단 버튼으로 다시 켤 수 있습니다.</p></AppPanel>}</>;
}

function RemoteSlide({ label, text, previewUrl }: { label: string; text: string; previewUrl: string | null }) { return <section className={`remote-slide ${previewUrl ? 'remote-preview' : 'remote-text'}`}><span className="remote-slide-label">{label}</span>{previewUrl ? <img src={previewUrl} alt={`${label} 슬라이드 미리보기`} /> : <p>{text || '표시할 슬라이드가 없습니다.'}</p>}</section>; }

function RemoteControl() {
  const { base, state, connection, commands } = useProPresenterSession(); const [mode, setMode] = useState<RemoteMode>('auto'); const context = state?.playlistItem?.presentationId ? state.playlistItem : null; const presentationQuery = usePresentationCues(context); const slides = presentationQuery.data || []; const currentIndex = currentCueIndex(state, context); const currentSlide = currentIndex >= 0 ? slides[currentIndex] : undefined; const display = remoteDisplayMode(mode, state?.currentCue || null); const previewUrl = display === 'preview' ? presentationThumbnailUrl(base, context, currentIndex, '512') || genericPresentationThumbnailUrl(base, state?.presentationId || null, state?.slideIndex || -1, '512') : null; const groups = useMemo(() => groupStarts(slides), [slides]); const groupActive = (index: number) => currentIndex >= index && currentIndex < (groups.find((group) => group.index > index)?.index ?? slides.length); return <main className="remote-app"><section className="remote-screen"><header className="remote-header"><button className="remote-back" onClick={() => window.location.assign('/')}>컨트롤러</button><div className="remote-mode-switch" role="group" aria-label="리모컨 화면 모드">{(['text', 'preview', 'auto'] as RemoteMode[]).map((value) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)} aria-pressed={mode === value}>{value === 'text' ? '텍스트' : value === 'preview' ? '미리보기' : '자동'}</button>)}</div><span className="remote-status"><span className="status-dot" />{connection.status === 'connected' ? '연결됨' : connection.status === 'error' ? '연결 오류' : '확인 중'}</span></header>{commands.error && <p className="remote-command-error">{commands.error}</p>}<div className={`remote-slides ${display === 'preview' ? 'single' : ''}`}>{presentationQuery.isLoading && display === 'preview' ? <p className="remote-loading">현재 화면을 불러오는 중…</p> : <><RemoteSlide label="현재" text={state?.currentCue?.text || slideText(currentSlide)} previewUrl={previewUrl} />{display === 'text' && <RemoteSlide label="다음" text={state?.nextCue?.text || ''} previewUrl={null} />}</>}</div></section><section className="remote-control-area"><section className="remote-controls"><button className="remote-control previous" onClick={() => void commands.previous().catch(() => undefined)} disabled={commands.pending} aria-label="이전 슬라이드">‹<span>이전</span></button><button className="remote-control next" onClick={() => void commands.next().catch(() => undefined)} disabled={commands.pending} aria-label="다음 슬라이드"><span>다음</span>›</button></section><nav className="remote-group-strip" aria-label="프레젠테이션 그룹">{groups.map((group) => <button key={group.key} className={groupActive(group.index) ? 'active' : ''} disabled={commands.pending || !context} onClick={() => context && void commands.triggerPlaylistCue(context, group.index).catch(() => undefined)}>{group.name}</button>)}</nav></section></main>;
}

function SessionApp({ settings, onConnection }: { settings: Settings; onConnection: () => void }) { return <ProPresenterSessionProvider settings={settings}>{window.location.pathname === '/remote' ? <RemoteControl /> : <Controller settings={settings} onConnection={onConnection} />}</ProPresenterSessionProvider>; }

function App() { const nativeProxy = isNativeProxy(); const nativeSettings: Settings = { host: window.location.hostname || '127.0.0.1', port: 1025 }; const [supported, setSupported] = useState<boolean | null>(null); const [settings, setSettings] = useState<Settings | null>(() => nativeProxy ? nativeSettings : JSON.parse(localStorage.getItem(settingsKey) || 'null') as Settings | null); const [showConnection, setShowConnection] = useState(false); useEffect(() => { let mounted = true; const check = async () => { if (nativeProxy) return mounted && setSupported(true); if (!window.isSecureContext || !navigator.permissions?.query) return mounted && setSupported(false); try { await navigator.permissions.query({ name: 'local-network' as PermissionName }); if (mounted) setSupported(true); } catch { if (mounted) setSupported(false); } }; void check(); return () => { mounted = false; }; }, [nativeProxy]); const connect = (next: Settings) => { const resolved = nativeProxy ? nativeSettings : next; if (!nativeProxy) localStorage.setItem(settingsKey, JSON.stringify(resolved)); setSettings(resolved); setShowConnection(false); }; if (supported === false) return <BrowserSupportNotice />; if (supported === null) return null; if (!settings) return <Setup onConnect={connect} />; return <><SessionApp settings={settings} onConnection={() => setShowConnection(true)} />{showConnection && <ConnectionSettingsPanel settings={settings} onConnect={connect} onClose={() => setShowConnection(false)} />}</>; }

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 250, refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
