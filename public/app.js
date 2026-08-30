const form = document.querySelector('#connection-form');
const hostInput = document.querySelector('#host');
const portInput = document.querySelector('#port');
const error = document.querySelector('#form-error');
const status = document.querySelector('#form-status');
const settingsKey = 'propresenter-remote:connection';
const setupView = document.querySelector('.shell');
const controlView = document.querySelector('#control-view');
const connectionLabel = document.querySelector('#connection-label');
const playlistList = document.querySelector('#playlist-list');
const slideGrid = document.querySelector('#slide-grid');
const workspaceTitle = document.querySelector('#workspace-title');
const apiError = document.querySelector('#api-error');
let apiBase = '';
let playlists = [];

const savedSettings = JSON.parse(localStorage.getItem(settingsKey) || 'null');
if (savedSettings) {
  hostInput.value = savedSettings.host || '';
  portInput.value = savedSettings.port || '';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  error.hidden = true;
  status.hidden = true;

  const host = hostInput.value.trim();
  const port = Number(portInput.value);
  const isIpv4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host);

  if (!isIpv4) {
    error.textContent = '올바른 IPv4 주소를 입력하세요.';
    error.hidden = false;
    hostInput.focus();
    return;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    error.textContent = '포트 번호는 1에서 65535 사이의 정수여야 합니다.';
    error.hidden = false;
    portInput.focus();
    return;
  }

  const settings = { host, port };
  localStorage.setItem(settingsKey, JSON.stringify(settings));
  connect(settings);
});

async function connect(settings) {
  apiBase = `http://${settings.host}:${settings.port}`;
  try {
    const response = await apiFetch('/v1/playlists');
    playlists = normalizePlaylists(response);
    if (!playlists.length) throw new Error('재생목록이 없습니다.');
    showControlView(settings);
  } catch (requestError) {
    error.textContent = `ProPresenter에 연결할 수 없습니다: ${requestError.message}`;
    error.hidden = false;
  }
}

async function apiFetch(path) {
  const response = await fetch(`${apiBase}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

function normalizePlaylists(response) {
  const data = response?.data ?? response;
  const entries = Array.isArray(data) ? data : (data?.playlists || data?.children || []);
  return entries.filter((item) => item && item.id).map((item) => ({ id: item.id, name: item.name || item.title || '이름 없는 재생목록' }));
}

function showControlView(settings) {
  setupView.hidden = true;
  controlView.hidden = false;
  connectionLabel.textContent = `${settings.host}:${settings.port}`;
  renderPlaylists(0);
}

async function renderPlaylists(activeIndex) {
  playlistList.replaceChildren(...playlists.map((playlist, index) => {
    const item = document.createElement('button');
    item.className = `playlist-item${index === activeIndex ? ' active' : ''}`;
    item.type = 'button';
    item.textContent = playlist.name;
    item.addEventListener('click', () => renderPlaylists(index));
    return item;
  }));
  const playlist = playlists[activeIndex];
  workspaceTitle.textContent = playlist.name;
  slideGrid.innerHTML = '<p class="loading">슬라이드를 불러오는 중…</p>';
  try {
    const response = await apiFetch(`/v1/playlist/${encodeURIComponent(playlist.id)}`);
    const slides = normalizeSlides(response);
    slideGrid.replaceChildren(...slides.map((slide, index) => {
    const card = document.createElement('button');
    card.className = 'slide-card';
    card.type = 'button';
    card.innerHTML = `<span class="slide-preview">${escapeHtml(slide.name)}</span><span class="slide-meta"><span>${escapeHtml(slide.name)}</span><span>${index + 1}</span></span>`;
    card.addEventListener('click', async () => {
      try { await apiFetch(`/v1/playlist/${encodeURIComponent(playlist.id)}/${index}/trigger`); } catch (requestError) { showError(`슬라이드 실행 실패: ${requestError.message}`); }
    });
    return card;
    }));
  } catch (requestError) {
    showError(`슬라이드를 불러올 수 없습니다: ${requestError.message}`);
  }
}

function normalizeSlides(response) {
  const data = response?.data ?? response;
  const entries = Array.isArray(data) ? data : (data?.items || data?.children || data?.playlist || []);
  return entries.map((item) => ({ name: item.name || item.title || item.presentation?.name || '슬라이드' }));
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function showError(message) { apiError.textContent = message; apiError.hidden = false; }

document.querySelector('#settings-button').addEventListener('click', () => {
  controlView.hidden = true;
  setupView.hidden = false;
});
