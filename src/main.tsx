import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActiveExpectation, ActiveState, ApiObject, Slide, api, fetchActiveState, flattenSlides, groupStarts, isConfirmed, listArray, objectId, objectName, playlistItems, presentationUuid, relativeTarget, remoteDisplayMode, slideText } from './propresenter';
import './styles.css';

const settingsKey = 'propresenter-remote:connection';
const activeStateInterval = 400;
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
  return listArray(data).flatMap((item) => { const id = objectId(item); return id ? [{ ...item, id, name: objectName(item, '이름 없는 라이브러리') }] : []; });
}

function useActiveState(base: string) {
  return useQuery({ queryKey: ['active-state', base], queryFn: ({ signal }) => fetchActiveState(base, signal), refetchInterval: activeStateInterval, refetchIntervalInBackground: false, retry: 1, retryDelay: 250 });
}

function ConnectionForm({ initial, onConnect, onCancel }: { initial?: Settings | null; onConnect: (settings: Settings) => void; onCancel?: () => void }) {
  const [host, setHost] = useState(initial?.host || ''); const [port, setPort] = useState<number | string>(initial?.port || 1025); const [error, setError] = useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const validHost = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host.trim()); const numericPort = Number(port); if (!validHost) return setError('올바른 IPv4 주소를 입력하세요.'); if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return setError('포트 번호는 1에서 65535 사이의 정수여야 합니다.'); setError(''); onConnect({ host: host.trim(), port: numericPort }); };
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

function PresentationBlock({ base, item, active, slideMode, thumbnailQuality, onReady, onTrigger }: { base: string; item: ApiObject; active?: ActiveState; slideMode: 'preview' | 'text'; thumbnailQuality: string; onReady: () => void; onTrigger: (id: string, index: number) => void }) {
  const uuid = presentationUuid(item); const { ref, near } = useNearViewport();
  const query = useQuery({ queryKey: ['presentation', base, uuid], queryFn: ({ signal }) => api(base, `/v1/presentation/${encodeURIComponent(uuid as string)}?chunked=false`, signal).then(flattenSlides), enabled: Boolean(uuid) && (near || active?.presentationId === uuid), retry: 1 });
  const slides = query.data || [];
  useEffect(() => { if (slides.length) onReady(); }, [onReady, slides.length]);
  return <section ref={ref} className="presentation-block"><div className="presentation-heading"><strong>{objectName(item)}</strong><small>{query.isLoading ? '불러오는 중…' : `${slides.length} slides`}</small></div>{query.isLoading && <p className="sidebar-status">슬라이드 조회 중…</p>}{query.error && <p className="form-error">프레젠테이션을 불러올 수 없습니다.</p>}{!query.isLoading && <div className="slide-grid">{slides.map((slide, index) => { const current = active?.presentationId === uuid && active.slideIndex === index; return <button className={`slide-card ${current ? 'active' : ''}`} data-presentation-uuid={uuid || ''} data-slide-index={index} key={`${uuid}-${index}`} onClick={() => uuid && onTrigger(uuid, index)}>{slideMode === 'preview' ? <span className="slide-preview"><img loading="lazy" src={`${base}/v1/presentation/${encodeURIComponent(uuid as string)}/thumbnail/${index}?quality=${thumbnailQuality}`} alt="" /></span> : <span className="slide-preview text-slide">{slideText(slide) || `${index + 1}`}</span>}<span className="slide-meta"><span>{index + 1}</span>{slide.groupName && <span>{slide.groupName}</span>}</span></button>; })}</div>}</section>;
}

function TopNav({ settings, active, title, following, onFollow, onSettings, onConnection }: { settings: Settings; active?: ActiveState; title: string; following: boolean; onFollow: () => void; onSettings: () => void; onConnection: () => void }) { return <nav className="top-nav"><strong>ProPresenter Remote</strong><span className="top-playlist">{title}</span><div className="top-actions"><span className="top-live-badge"><span className="status-dot" />{settings.host}:{settings.port} · {active ? '연결됨' : '연결 확인 중'}</span><button className="top-follow-button" disabled={following} onClick={onFollow}>{following ? '현재 슬라이드 추적 중' : '현재 슬라이드 따라가기'}</button><button onClick={() => window.location.assign('/remote')}>리모컨</button><button onClick={onSettings}>앱 설정</button><button onClick={onConnection}>연결 정보</button></div></nav>; }

function LibraryGroup({ base, library, onSelect }: { base: string; library: Library; onSelect: (libraryId: string, presentation: ApiObject) => void }) {
  const [open, setOpen] = useState(false); const presentationsQuery = useQuery({ queryKey: ['library', base, library.id], queryFn: ({ signal }) => api(base, `/v1/library/${encodeURIComponent(library.id)}?chunked=false`, signal).then(listArray), enabled: open, retry: 1 });
  return <div className="library-group"><button className="library-item" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span className="library-item-label"><span aria-hidden="true">{open ? '⌄' : '›'}</span>{library.name}</span></button>{open && <div className="library-presentations">{presentationsQuery.isLoading && <p className="sidebar-status">불러오는 중…</p>}{(presentationsQuery.data || []).map((presentation) => <button key={objectId(presentation)} className="library-presentation-item" onClick={() => onSelect(library.id, presentation)}>{objectName(presentation)}</button>)}</div>}</div>;
}

function LibrarySection({ base, onSelect }: { base: string; onSelect: (libraryId: string, presentation: ApiObject) => void }) {
  const [open, setOpen] = useState(true); const librariesQuery = useQuery({ queryKey: ['libraries', base], queryFn: ({ signal }) => api(base, '/v1/libraries?chunked=false', signal).then(flattenLibraries), retry: 1 });
  return <section className="sidebar-section"><button className="sidebar-section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>라이브러리</span><span aria-hidden="true">{open ? '⌄' : '›'}</span></button>{open && <div className="library-list">{librariesQuery.isLoading && <p className="sidebar-status">라이브러리 조회 중…</p>}{(librariesQuery.data || []).map((library) => <LibraryGroup key={library.id} base={base} library={library} onSelect={onSelect} />)}</div>}</section>;
}

function Controller({ settings, onConnection }: { settings: Settings; onConnection: () => void }) {
  const base = `http://${settings.host}:${settings.port}`;
  const queryClient = useQueryClient();
  const activeQuery = useActiveState(base);
  const active = activeQuery.data;
  const [source, setSource] = useState<'playlist' | 'library'>('playlist');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLibrary, setSelectedLibrary] = useState<{ libraryId: string; presentationId: string; name: string } | null>(null);
  const [following, setFollowing] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [slideMode, setSlideMode] = useState<'preview' | 'text'>(() => localStorage.getItem('propresenter-remote:slide-mode') === 'text' ? 'text' : 'preview');
  const [thumbnailQuality, setThumbnailQuality] = useState(() => localStorage.getItem('propresenter-remote:thumbnail-quality') || '256');
  const [renderVersion, setRenderVersion] = useState(0);
  const workspaceRef = useRef<HTMLElement>(null);
  const markRendered = useCallback(() => setRenderVersion((value) => value + 1), []);

  const playlistsQuery = useQuery({ queryKey: ['playlists', base], queryFn: ({ signal }) => api(base, '/v1/playlists?chunked=false', signal).then(flattenPlaylists), retry: 1 });
  const playlists = playlistsQuery.data || [];
  useEffect(() => {
    if (!selected && playlists.length) setSelected(active?.playlistId && playlists.some((item) => item.id === active.playlistId) ? active.playlistId : playlists[0].id);
  }, [active?.playlistId, playlists, selected]);
  useEffect(() => {
    if (following && active?.playlistId && playlists.some((item) => item.id === active.playlistId)) {
      setSource('playlist');
      setSelectedLibrary(null);
      setSelected(active.playlistId);
    }
  }, [active?.playlistId, following, playlists]);

  const selectedPlaylist = playlists.find((item) => item.id === selected);
  const itemsQuery = useQuery({
    queryKey: ['playlist', base, selected],
    queryFn: ({ signal }) => api(base, `/v1/playlist/${encodeURIComponent(selected as string)}?chunked=false`, signal).then(playlistItems),
    enabled: source === 'playlist' && Boolean(selected),
    retry: 1,
  });
  const refreshActiveState = () => queryClient.refetchQueries({ queryKey: ['active-state', base], type: 'active' });
  const trigger = useMutation({ mutationFn: ({ id, index }: { id: string; index: number }) => api(base, `/v1/presentation/${encodeURIComponent(id)}/${index}/trigger`), onSuccess: refreshActiveState });
  const libraryTrigger = useMutation({ mutationFn: ({ libraryId, id, index }: { libraryId: string; id: string; index: number }) => api(base, `/v1/library/${encodeURIComponent(libraryId)}/${encodeURIComponent(id)}/${index}/trigger`) });
  const relativeTrigger = useMutation({ mutationFn: (next: boolean) => api(base, next ? '/v1/trigger/next' : '/v1/trigger/previous'), onSuccess: refreshActiveState });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || relativeTrigger.isPending) return;
      const target = event.target as HTMLElement | null;
      const isTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
      if (isTextEntry || target?.closest('[role="dialog"]')) return;
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ';
      const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!next && !previous) return;
      if (event.key === ' ' && target?.closest('button, a')) return;
      event.preventDefault();
      relativeTrigger.mutate(next);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [relativeTrigger]);

  useEffect(() => {
    if (!following || !active?.presentationId || active.slideIndex < 0) return;
    const workspace = workspaceRef.current;
    const target = workspace?.querySelector<HTMLButtonElement>(`.slide-card[data-presentation-uuid="${active.presentationId}"][data-slide-index="${active.slideIndex}"]`);
    if (!workspace || !target) return;
    const box = workspace.getBoundingClientRect();
    const slide = target.getBoundingClientRect();
    workspace.scrollTo({ top: Math.max(0, workspace.scrollTop + slide.top - box.top - (workspace.clientHeight / 3 - slide.height / 2)), behavior: 'smooth' });
  }, [active?.presentationId, active?.slideIndex, following, renderVersion]);

  const activeItem = (itemsQuery.data || []).find((item) => presentationUuid(item) === active?.presentationId);
  const title = source === 'library'
    ? `라이브러리 / ${selectedLibrary?.name || '프레젠테이션'}`
    : `${selectedPlaylist?.name || '재생목록'}${activeItem ? ` / ${objectName(activeItem)}` : ''}`;
  const chooseLibraryPresentation = (libraryId: string, presentation: ApiObject) => {
    const presentationId = presentationUuid(presentation) || objectId(presentation);
    if (!presentationId) return;
    setFollowing(false);
    setSource('library');
    setSelectedLibrary({ libraryId, presentationId, name: objectName(presentation) });
  };
  const choosePlaylist = (playlistId: string) => {
    setFollowing(false);
    setSource('playlist');
    setSelectedLibrary(null);
    setSelected(playlistId);
  };
  const saveSlideMode = (value: 'preview' | 'text') => { localStorage.setItem('propresenter-remote:slide-mode', value); setSlideMode(value); };
  const saveThumbnailQuality = (value: string) => { localStorage.setItem('propresenter-remote:thumbnail-quality', value); setThumbnailQuality(value); };
  const libraryItem = selectedLibrary ? { name: selectedLibrary.name, presentation_info: { presentation_uuid: selectedLibrary.presentationId } } : null;

  return <>
    <TopNav settings={settings} active={active} title={title} following={following} onFollow={() => setFollowing(true)} onSettings={() => setShowSettings(true)} onConnection={onConnection} />
    <main className="control-app">
      <aside className="sidebar">
        <LibrarySection base={base} onSelect={chooseLibraryPresentation} />
        <section className="sidebar-section">
          <h3 className="sidebar-section-title">재생목록</h3>
          {playlistsQuery.isLoading && <p className="sidebar-status">재생목록 조회 중…</p>}
          {playlistsQuery.error && <p className="form-error">연결 실패: {(playlistsQuery.error as Error).message}</p>}
          <nav className="playlist-list" aria-label="재생목록 목록">
            {playlists.map((playlist) => <button key={playlist.id} className={`playlist-item ${source === 'playlist' && playlist.id === selected ? 'active' : ''}`} style={{ paddingLeft: 10 + playlist.depth * 15 }} onClick={() => choosePlaylist(playlist.id)}>{playlist.name}</button>)}
          </nav>
        </section>
      </aside>
      <section ref={workspaceRef} className="workspace" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} tabIndex={-1}>
        {source === 'playlist' && <>
          {itemsQuery.isLoading && <p>재생목록 항목 조회 중…</p>}
          {itemsQuery.error && <p className="form-error">재생목록을 불러올 수 없습니다.</p>}
          <div className="presentation-list">
            {(itemsQuery.data || []).map((item, index) => item.type === 'header'
              ? <div className="header-card" key={`header-${index}`}>{objectName(item, '구분')}</div>
              : item.type === 'presentation'
                ? <PresentationBlock key={`${presentationUuid(item)}-${index}`} base={base} item={item} active={active} slideMode={slideMode} thumbnailQuality={thumbnailQuality} onReady={markRendered} onTrigger={(id, slideIndex) => trigger.mutate({ id, index: slideIndex })} />
                : null)}
          </div>
        </>}
        {source === 'library' && libraryItem && <div className="presentation-list">
          <PresentationBlock base={base} item={libraryItem} active={active} slideMode={slideMode} thumbnailQuality={thumbnailQuality} onReady={markRendered} onTrigger={(id, slideIndex) => libraryTrigger.mutate({ libraryId: selectedLibrary!.libraryId, id, index: slideIndex })} />
        </div>}
      </section>
    </main>
    {showSettings && <AppPanel mode="modal" eyebrow="SETTINGS" title="앱 설정" titleId="settings-title" onClose={() => setShowSettings(false)}>
      <label className="setting-row">슬라이드 표시 방식<select value={slideMode} onChange={(event) => saveSlideMode(event.target.value as 'preview' | 'text')}><option value="preview">미리보기</option><option value="text">텍스트</option></select></label>
      <label className="setting-row">미리보기 해상도<select value={thumbnailQuality} onChange={(event) => saveThumbnailQuality(event.target.value)}>{['64', '128', '256', '512'].map((quality) => <option key={quality} value={quality}>{quality}</option>)}</select></label>
      <p className="intro">현재 슬라이드 추적은 사용자가 스크롤하면 해제되며, 상단 버튼으로 다시 켤 수 있습니다.</p>
    </AppPanel>}
  </>;
}

type Command = { expected: ActiveExpectation; optimistic?: ActiveState };
function RemoteSlide({ base, label, slide, presentationId, index, preview }: { base: string; label: string; slide?: Slide; presentationId: string | null; index: number; preview: boolean }) { return <section className={`remote-slide ${preview ? 'remote-preview' : 'remote-text'}`}><span className="remote-slide-label">{label}</span>{slide ? preview ? <img src={`${base}/v1/presentation/${encodeURIComponent(presentationId || '')}/thumbnail/${index}?quality=512`} alt={`${label} 슬라이드 미리보기`} /> : <p>{slideText(slide) || '텍스트 없음'}</p> : <p className="remote-empty">표시할 슬라이드가 없습니다.</p>}</section>; }

function RemoteControl({ settings }: { settings: Settings }) {
  const base = `http://${settings.host}:${settings.port}`; const queryClient = useQueryClient(); const activeQuery = useActiveState(base); const active = activeQuery.data; const [mode, setMode] = useState<RemoteMode>('auto'); const [command, setCommand] = useState<Command | null>(null); const [error, setError] = useState(''); const commandTimeout = useRef<number | null>(null);
  const playlistItemsQuery = useQuery({ queryKey: ['remote-playlist', base, active?.playlistId], queryFn: ({ signal }) => api(base, `/v1/playlist/${encodeURIComponent(active?.playlistId as string)}?chunked=false`, signal).then(playlistItems), enabled: Boolean(active?.playlistId), retry: 1 }); const currentSlidesQuery = useQuery({ queryKey: ['remote-presentation', base, active?.presentationId], queryFn: ({ signal }) => api(base, `/v1/presentation/${encodeURIComponent(active?.presentationId as string)}?chunked=false`, signal).then(flattenSlides), enabled: Boolean(active?.presentationId), retry: 1 });
  const items = playlistItemsQuery.data || []; const currentPosition = items.findIndex((item) => presentationUuid(item) === active?.presentationId || objectId(item) === active?.playlistItemId); const adjacent = (direction: 1 | -1) => (direction > 0 ? items.slice(currentPosition + 1) : items.slice(0, currentPosition).reverse()).find((item) => item.type === 'presentation'); const nextId = presentationUuid(adjacent(1)); const previousId = presentationUuid(adjacent(-1));
  const nextSlidesQuery = useQuery({ queryKey: ['remote-adjacent-presentation', base, nextId], queryFn: ({ signal }) => api(base, `/v1/presentation/${encodeURIComponent(nextId as string)}?chunked=false`, signal).then(flattenSlides), enabled: Boolean(nextId), retry: 1 }); const previousSlidesQuery = useQuery({ queryKey: ['remote-adjacent-presentation', base, previousId], queryFn: ({ signal }) => api(base, `/v1/presentation/${encodeURIComponent(previousId as string)}?chunked=false`, signal).then(flattenSlides), enabled: Boolean(previousId), retry: 1 });
  const slides = currentSlidesQuery.data || []; const view = command?.optimistic || active; const viewIndex = view?.slideIndex ?? -1; const currentSlide = viewIndex >= 0 ? slides[viewIndex] : undefined; const effectiveMode = remoteDisplayMode(mode, currentSlide); const nextInCurrent = viewIndex + 1 < slides.length; const nextSlide = nextInCurrent ? slides[viewIndex + 1] : nextSlidesQuery.data?.[0]; const nextSlideId = nextInCurrent ? active?.presentationId || null : nextId; const groups = useMemo(() => groupStarts(slides), [slides]);
  const refresh = () => queryClient.refetchQueries({ queryKey: ['active-state', base], type: 'active' });
  const run = async (path: string, nextCommand: Command) => { if (command) return; setError(''); setCommand(nextCommand); if (commandTimeout.current !== null) window.clearTimeout(commandTimeout.current); commandTimeout.current = window.setTimeout(() => { setCommand(null); setError('ProPresenter 상태 확인 시간이 초과되었습니다. 다시 시도하세요.'); }, 1_800); try { await api(base, path); await refresh(); } catch (reason) { setCommand(null); setError((reason as Error).message || '슬라이드를 실행할 수 없습니다.'); } };
  useEffect(() => { if (command && active && isConfirmed(command.expected, active)) { if (commandTimeout.current !== null) window.clearTimeout(commandTimeout.current); setCommand(null); } }, [active, command]); useEffect(() => () => { if (commandTimeout.current !== null) window.clearTimeout(commandTimeout.current); }, []);
  const relative = (direction: 1 | -1) => { if (!active || !slides.length || command) return; const target = relativeTarget(active, slides, direction, direction > 0 ? nextId : previousId, direction > 0 ? nextSlidesQuery.data : previousSlidesQuery.data); if (!target) return setError('이동할 프레젠테이션이 없습니다.'); void run(direction > 0 ? '/v1/trigger/next' : '/v1/trigger/previous', { expected: target, optimistic: target.optimistic ? { ...active, slideIndex: target.slideIndex } : undefined }); };
  const jumpGroup = (index: number) => { if (!active?.presentationId || command) return; void run(`/v1/presentation/${encodeURIComponent(active.presentationId)}/${index}/trigger`, { expected: { presentationId: active.presentationId, slideIndex: index }, optimistic: { ...active, slideIndex: index } }); };
  const groupActive = (groupIndex: number) => viewIndex >= groupIndex && viewIndex < (groups.find((group) => group.index > groupIndex)?.index ?? slides.length);
  return <main className="remote-app"><section className="remote-screen"><header className="remote-header"><button className="remote-back" onClick={() => window.location.assign('/')}>컨트롤러</button><div className="remote-mode-switch" role="group" aria-label="리모컨 화면 모드">{(['text', 'preview', 'auto'] as RemoteMode[]).map((value) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)} aria-pressed={mode === value}>{value === 'text' ? '텍스트' : value === 'preview' ? '미리보기' : '자동'}</button>)}</div><span className="remote-status"><span className="status-dot" />{active ? '연결됨' : '확인 중'}</span></header>{error && <p className="remote-command-error">{error}</p>}<div className={`remote-slides ${effectiveMode === 'preview' ? 'single' : ''}`}>{currentSlidesQuery.isLoading ? <p className="remote-loading">현재 화면을 불러오는 중…</p> : <><RemoteSlide base={base} label="현재" slide={currentSlide} presentationId={active?.presentationId || null} index={viewIndex} preview={effectiveMode === 'preview'} />{effectiveMode === 'text' && <RemoteSlide base={base} label="다음" slide={nextSlide} presentationId={nextSlideId} index={nextInCurrent ? viewIndex + 1 : 0} preview={false} />}</>}</div></section><section className="remote-control-area"><section className="remote-controls"><button className="remote-control previous" onClick={() => relative(-1)} disabled={Boolean(command)} aria-label="이전 슬라이드">‹<span>이전</span></button><button className="remote-control next" onClick={() => relative(1)} disabled={Boolean(command)} aria-label="다음 슬라이드"><span>다음</span>›</button></section><nav className="remote-group-strip" aria-label="프레젠테이션 그룹">{groups.map((group) => <button key={group.key} className={groupActive(group.index) ? 'active' : ''} disabled={Boolean(command)} onClick={() => jumpGroup(group.index)}>{group.name}</button>)}</nav></section></main>;
}

function App() {
  const [supported, setSupported] = useState<boolean | null>(null); const [settings, setSettings] = useState<Settings | null>(() => JSON.parse(localStorage.getItem(settingsKey) || 'null') as Settings | null); const [showConnection, setShowConnection] = useState(false);
  useEffect(() => { let mounted = true; const check = async () => { if (!window.isSecureContext || !navigator.permissions?.query) return mounted && setSupported(false); try { await navigator.permissions.query({ name: 'local-network' as PermissionName }); if (mounted) setSupported(true); } catch { if (mounted) setSupported(false); } }; void check(); return () => { mounted = false; }; }, []);
  const connect = (next: Settings) => { localStorage.setItem(settingsKey, JSON.stringify(next)); setSettings(next); setShowConnection(false); };
  if (supported === false) return <BrowserSupportNotice />; if (supported === null) return null; if (!settings) return <Setup onConnect={connect} />; if (window.location.pathname === '/remote') return <RemoteControl settings={settings} />;
  return <><Controller settings={settings} onConnection={() => setShowConnection(true)} />{showConnection && <ConnectionSettingsPanel settings={settings} onConnect={connect} onClose={() => setShowConnection(false)} />}</>;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 250, refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
