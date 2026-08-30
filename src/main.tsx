import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueries } from '@tanstack/react-query';
import './styles.css';

const settingsKey = 'propresenter-remote:connection';
type Settings = { host: string; port: number };
type ApiObject = Record<string, any>;
type Playlist = ApiObject & { id: string; name: string; depth: number };
type PlaylistItem = ApiObject & { type?: string; presentation_info?: { presentation_uuid?: string } };
type Slide = ApiObject & { groupName: string; flatIndex: number };

async function api(base: string, path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
function listArray(value: unknown): ApiObject[] { if (Array.isArray(value)) return value; if (!value || typeof value !== 'object') return []; const object = value as ApiObject; for (const key of ['items', 'playlist_items', 'contents', 'children', 'playlists']) if (Array.isArray(object[key])) return object[key]; return []; }
function objectId(value: ApiObject): string | null { return value.id?.uuid || value.uuid || value.playlist_id?.uuid || value.id || null; }
function objectName(value: ApiObject | undefined, fallback = '이름 없는 항목'): string { return value?.id?.name || value?.name || value?.title || value?.playlist_id?.name || fallback; }
function flattenPlaylists(data: unknown): Playlist[] { const result: Playlist[] = []; const walk = (value: unknown, depth = 0) => listArray(value).forEach((item) => { const id = objectId(item); if (id) result.push({ ...item, id, name: objectName(item), depth }); ['children', 'playlists'].forEach((key) => { if (Array.isArray(item[key])) walk(item[key], depth + 1); }); }); walk(data); return result; }
function playlistItems(data: unknown): PlaylistItem[] { const object = data as ApiObject; return (object?.playlist?.items || listArray(data)) as PlaylistItem[]; }
function presentationUuid(item: PlaylistItem): string | null { return item.presentation_info?.presentation_uuid || null; }
function flattenSlides(data: unknown): Slide[] { const presentation = (data as ApiObject)?.presentation || data as ApiObject; return (presentation?.groups || []).flatMap((group: ApiObject) => (group.slides || []).map((slide: ApiObject) => ({ ...slide, groupName: group.name || '', flatIndex: 0 }))).map((slide: Slide, index: number) => ({ ...slide, flatIndex: index })); }
function activeUuid(data: unknown): string | null { const object = data as ApiObject; return object?.presentation?.id?.uuid || object?.presentation?.uuid || object?.id?.uuid || object?.uuid || null; }
function slideIndex(data: unknown): number { const object = data as ApiObject; for (const value of [object?.presentation_index?.index, object?.presentation_index, object?.index, object?.slide_index?.index, object?.slide_index]) { const index = Number(value); if (Number.isInteger(index)) return index; } return -1; }
function slideLabel(slide: Slide, index: number): string { return String(slide.text || `Slide ${index + 1}`).replace(/\s+/g, ' ').slice(0, 80); }

function Setup({ onConnect }: { onConnect: (settings: Settings) => void }) {
  const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null') as Settings | null;
  const [host, setHost] = useState(saved?.host || ''); const [port, setPort] = useState<number | string>(saved?.port || 1025); const [error, setError] = useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const validHost = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host.trim()); const numericPort = Number(port); if (!validHost) return setError('올바른 IPv4 주소를 입력하세요.'); if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return setError('포트 번호는 1에서 65535 사이의 정수여야 합니다.'); setError(''); onConnect({ host: host.trim(), port: numericPort }); };
  return <main className="shell"><section className="card"><span className="eyebrow">PROPRESENTER REMOTE</span><h1>연결 설정</h1><p className="intro">조작할 ProPresenter가 설치된 PC의 네트워크 정보를 입력하세요.</p><form onSubmit={submit}><label>PC IP 주소<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="예: 192.168.0.10" autoComplete="off" required /></label><span className="hint">같은 네트워크에 있는 ProPresenter PC의 IPv4 주소</span><label>포트 번호<input type="number" value={port} onChange={(event) => setPort(event.target.value)} min="1" max="65535" required /></label>{error && <p className="form-error">{error}</p>}<button type="submit">ProPresenter 연결</button></form></section></main>;
}

function Control({ settings, onSettings }: { settings: Settings; onSettings: () => void }) {
  const base = `http://${settings.host}:${settings.port}`; const [selected, setSelected] = useState<string | null>(null);
  const playlistsQuery = useQuery({ queryKey: ['playlists', base], queryFn: () => api(base, '/v1/playlists?chunked=false').then(flattenPlaylists) }); const playlists = playlistsQuery.data || [];
  useEffect(() => { if (!selected && playlists.length) setSelected(playlists[0].id); }, [playlists, selected]);
  const activePlaylist = playlists.find((playlist) => playlist.id === selected); const itemsQuery = useQuery({ queryKey: ['playlist', base, selected], queryFn: () => api(base, `/v1/playlist/${encodeURIComponent(selected as string)}?chunked=false`).then(playlistItems), enabled: Boolean(selected) });
  const presentationItems = useMemo(() => (itemsQuery.data || []).filter((item) => item.type === 'presentation' && presentationUuid(item)), [itemsQuery.data]);
  const presentations = useQueries({ queries: presentationItems.map((item) => { const uuid = presentationUuid(item) as string; return { queryKey: ['presentation', base, uuid], queryFn: () => api(base, `/v1/presentation/${encodeURIComponent(uuid)}?chunked=false`).then(flattenSlides), enabled: true }; }) });
  const activeQuery = useQuery({ queryKey: ['active-presentation', base], queryFn: () => api(base, '/v1/presentation/active?chunked=false').then(activeUuid), refetchInterval: 1000 }); const indexQuery = useQuery({ queryKey: ['active-slide', base], queryFn: () => api(base, '/v1/presentation/slide_index?chunked=false').then(slideIndex), refetchInterval: 1000 });
  const trigger = useMutation({ mutationFn: ({ uuid, index }: { uuid: string; index: number }) => api(base, `/v1/presentation/${encodeURIComponent(uuid)}/${index}/trigger`) }); const relativeTrigger = useMutation({ mutationFn: (next: boolean) => api(base, next ? '/v1/trigger/next' : '/v1/trigger/previous') }); const connectedError = playlistsQuery.error as Error | null;
  return <main className="control-app"><aside className="sidebar"><div className="sidebar-header"><div><span className="eyebrow">PROPRESENTER REMOTE</span><h2>재생목록</h2></div><button className="icon-button" onClick={onSettings} aria-label="연결 설정">⚙</button></div><div className="connection-pill"><span className="status-dot" />{settings.host}:{settings.port}</div>{playlistsQuery.isLoading && <p>재생목록 조회 중…</p>}{connectedError && <p className="form-error">연결 실패: {connectedError.message}</p>}<nav className="playlist-list" aria-label="재생목록 목록">{playlists.map((playlist) => <button className={`playlist-item ${playlist.id === selected ? 'active' : ''}`} style={{ paddingLeft: 10 + playlist.depth * 15 }} key={playlist.id} onClick={() => setSelected(playlist.id)}>{playlist.name}</button>)}</nav></aside><section className="workspace"><header className="workspace-header"><div><span className="eyebrow">PLAYLIST</span><h1>{activePlaylist?.name || '재생목록'}</h1></div><span className="live-badge">연결됨</span></header>{itemsQuery.isLoading && <p>재생목록 항목 조회 중…</p>}{itemsQuery.error && <p className="form-error">재생목록을 불러올 수 없습니다: {(itemsQuery.error as Error).message}</p>}<div className="presentation-list">{(itemsQuery.data || []).map((item, itemIndex) => item.type === 'header' ? <div className="header-card" key={`header-${itemIndex}`}>{objectName(item, '구분')}</div> : item.type === 'presentation' ? <PresentationBlock key={`${presentationUuid(item)}-${itemIndex}`} base={base} item={item} slides={presentations[presentationItems.indexOf(item)]?.data || []} isLoading={presentations[presentationItems.indexOf(item)]?.isLoading || false} activeUuid={activeQuery.data} activeIndex={indexQuery.data ?? -1} onTrigger={(uuid, index) => trigger.mutate({ uuid, index })} /> : null)}</div><div className="nav"><button className="prev" onClick={() => relativeTrigger.mutate(false)}>◀ 이전</button><button className="next" onClick={() => relativeTrigger.mutate(true)}>다음 ▶</button></div>{trigger.error && <p className="form-error">슬라이드 실행 실패: {(trigger.error as Error).message}</p>}{relativeTrigger.error && <p className="form-error">슬라이드 이동 실패: {(relativeTrigger.error as Error).message}</p>}</section></main>;
}

function PresentationBlock({ base, item, slides, isLoading, activeUuid, activeIndex, onTrigger }: { base: string; item: PlaylistItem; slides: Slide[]; isLoading: boolean; activeUuid?: string | null; activeIndex: number; onTrigger: (uuid: string, index: number) => void }) {
  const uuid = presentationUuid(item); return <section className="presentation-block"><div className="presentation-heading"><strong>{objectName(item)}</strong><small>{isLoading ? '불러오는 중…' : `${slides.length} slides`}</small></div>{!uuid && <p className="form-error">이 항목에 presentation_uuid가 없습니다.</p>}{isLoading ? <p>슬라이드 조회 중…</p> : <div className="slide-grid">{slides.map((slide, index) => { const label = slideLabel(slide, index); return <button className={`slide-card ${activeUuid === uuid && activeIndex === index ? 'active' : ''}`} key={`${uuid}-${index}`} onClick={() => uuid && onTrigger(uuid, index)}><span className="slide-preview"><img loading="lazy" src={`${base}/v1/presentation/${encodeURIComponent(uuid as string)}/thumbnail/${index}?quality=256`} onError={(event) => { event.currentTarget.style.display = 'none'; }} alt="" /><span>{label}</span></span><span className="slide-meta"><span>{label}</span><span>{index + 1}</span></span></button>; })}</div>}</section>;
}

function App() { const [settings, setSettings] = useState<Settings | null>(null); const connect = (next: Settings) => { localStorage.setItem(settingsKey, JSON.stringify(next)); setSettings(next); }; return settings ? <Control settings={settings} onSettings={() => setSettings(null)} /> : <Setup onConnect={connect} />; }
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
