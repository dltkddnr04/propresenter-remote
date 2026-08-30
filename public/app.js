const form = document.querySelector('#connection-form');
const hostInput = document.querySelector('#host');
const portInput = document.querySelector('#port');
const error = document.querySelector('#form-error');
const status = document.querySelector('#form-status');
const settingsKey = 'propresenter-remote:connection';

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
  status.textContent = `${host}:${port} 연결 정보가 저장되었습니다.`;
  status.hidden = false;
});
