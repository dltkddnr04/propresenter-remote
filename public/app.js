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
const playlists = [
  { name: '주일예배', slides: ['예배에의 부름', '찬양합니다', '대표기도', '설교 말씀', '축도'] },
  { name: '수요예배', slides: ['수요예배 시작', '찬송가 310장', '성경봉독', '말씀과 은혜'] },
  { name: '광고 및 안내', slides: ['이번 주 소식', '다음 행사 안내', '헌금 안내'] }
];

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

  localStorage.setItem(settingsKey, JSON.stringify({ host, port }));
  showControlView({ host, port });
});

function showControlView(settings) {
  setupView.hidden = true;
  controlView.hidden = false;
  connectionLabel.textContent = `${settings.host}:${settings.port}`;
  renderPlaylists(0);
}

function renderPlaylists(activeIndex) {
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
  slideGrid.replaceChildren(...playlist.slides.map((slide, index) => {
    const card = document.createElement('button');
    card.className = 'slide-card';
    card.type = 'button';
    card.innerHTML = `<span class="slide-preview">${slide}</span><span class="slide-meta"><span>${slide}</span><span>${index + 1}</span></span>`;
    return card;
  }));
}

document.querySelector('#settings-button').addEventListener('click', () => {
  controlView.hidden = true;
  setupView.hidden = false;
});
