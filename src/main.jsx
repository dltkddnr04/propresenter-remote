import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import './styles.css';

const settingsKey = 'propresenter-remote:connection';
const api = async (base, path) => { const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.status === 204 ? null : response.json(); };
const unwrap = (response) => response?.data ?? response;
const normalizePlaylists = (response) => { const data = unwrap(response); const items = Array.isArray(data) ? data : data?.playlists || data?.children || []; return items.filter((item) => item?.id).map((item) => ({ id: item.id, name: item.name || item.title || '이름 없는 재생목록' })); };
const normalizeSlides = (response) => { const data = unwrap(response); const items = Array.isArray(data) ? data : data?.items || data?.children || data?.playlist || []; return items.map((item) => ({ name: item.name || item.title || item.presentation?.name || '슬라이드' })); };

function Setup({ onConnect }) {
  const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null');
  const [host, setHost] = useState(saved?.host || ''); const [port, setPort] = useState(saved?.port || 1025); const [error, setError] = useState('');
  return <main className="shell"><section className="card"><span className="eyebrow">PROPRESENTER REMOTE</span><h1>연결 설정</h1><p className="intro">조작할 ProPresenter가 설치된 PC의 네트워크 정보를 입력하세요.</p><form onSubmit={(event) => { event.preventDefault(); const valid = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host.trim()); if (!valid) return setError('올바른 IPv4 주소를 입력하세요.'); if (!Number.isInteger(Number(port)) || port < 1 || port > 65535) return setError('포트 번호는 1에서 65535 사이의 정수여야 합니다.'); setError(''); onConnect({ host: host.trim(), port: Number(port) }); }}><label>PC IP 주소<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="예: 192.168.0.10" required /></label><span className="hint">같은 네트워크에 있는 ProPresenter PC의 IPv4 주소</span><label>포트 번호<input type="number" value={port} onChange={(e) => setPort(e.target.value)} min="1" max="65535" required /></label>{error && <p className="form-error">{error}</p>}<button type="submit">ProPresenter 연결</button></form></section></main>;
}

function Control({ settings, onSettings }) {
  const base = `http://${settings.host}:${settings.port}`; const [activeId, setActiveId] = useState(null); const queryClient = useQueryClient();
  const playlistsQuery = useQuery({ queryKey: ['playlists', base], queryFn: () => api(base, '/v1/playlists').then(normalizePlaylists) });
  const playlists = playlistsQuery.data || []; useEffect(() => { if (!activeId && playlists[0]) setActiveId(playlists[0].id); }, [playlists, activeId]);
  const active = playlists.find((item) => item.id === activeId); const slidesQuery = useQuery({ queryKey: ['playlist', base, activeId], queryFn: () => api(base, `/v1/playlist/${encodeURIComponent(activeId)}`).then(normalizeSlides), enabled: Boolean(activeId) });
  const trigger = useMutation({ mutationFn: (index) => api(base, `/v1/playlist/${encodeURIComponent(activeId)}/${index}/trigger`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlist', base, activeId] }) });
  return <main className="control-app"><aside className="sidebar"><div className="sidebar-header"><div><span className="eyebrow">PROPRESENTER REMOTE</span><h2>재생목록</h2></div><button className="icon-button" onClick={onSettings} aria-label="연결 설정">⚙</button></div><div className="connection-pill"><span className="status-dot" />{settings.host}:{settings.port}</div>{playlistsQuery.isLoading && <p>불러오는 중…</p>}{playlistsQuery.error && <p className="form-error">연결 실패: {playlistsQuery.error.message}</p>}<nav className="playlist-list">{playlists.map((playlist) => <button className={`playlist-item ${playlist.id === activeId ? 'active' : ''}`} key={playlist.id} onClick={() => setActiveId(playlist.id)}>{playlist.name}</button>)}</nav></aside><section className="workspace"><header className="workspace-header"><div><span className="eyebrow">PLAYLIST</span><h1>{active?.name || '재생목록'}</h1></div><span className="live-badge">연결됨</span></header>{slidesQuery.error && <p className="form-error">슬라이드를 불러올 수 없습니다: {slidesQuery.error.message}</p>}<div className="slide-grid">{slidesQuery.isLoading && <p>슬라이드를 불러오는 중…</p>}{slidesQuery.data?.map((slide, index) => <button className="slide-card" key={`${slide.name}-${index}`} onClick={() => trigger.mutate(index)} disabled={trigger.isPending}><span className="slide-preview">{slide.name}</span><span className="slide-meta"><span>{slide.name}</span><span>{index + 1}</span></span></button>)}</div></section></main>;
}

function App() { const [settings, setSettings] = useState(null); const connect = (next) => { localStorage.setItem(settingsKey, JSON.stringify(next)); setSettings(next); }; return settings ? <Control settings={settings} onSettings={() => setSettings(null)} /> : <Setup onConnect={connect} />; }
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
