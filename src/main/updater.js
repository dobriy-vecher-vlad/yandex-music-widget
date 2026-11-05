// Обновление без участия человека. Установленный виджет раз в несколько часов спрашивает GitHub
// о новом релизе (electron-updater, latest.yml в ассетах релиза), сам скачивает установщик и ставит
// его тихо, когда музыка не играет: виджет закрывается на несколько секунд и запускается уже новым.
// В меню трея — пункт с состоянием: «Проверить обновления», «Проверяю…», «Скачиваю…»,
// «Обновить до … сейчас». Ручная проверка заканчивается уведомлением Windows с результатом.
// Из исходников (npm start) ничего не делает: там нет app-update.yml, да и обновлять нечего.
const { app } = require('electron');
const { log } = require('./log');

const FIRST_CHECK_MS = 30 * 1000; // после запуска даём виджету спокойно подключиться к Яндекс Музыке
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const IDLE_POLL_MS = 15 * 1000;
const IDLE_NEEDED_MS = 60 * 1000; // столько тишины подряд, прежде чем ставить обновление

let updater = null;
// idle | checking | downloading | ready | error; version — найденная версия, percent — сколько скачано
let state = { phase: 'idle', version: null, percent: 0 };
let manual = false; // проверку запустили из меню — о результате сообщаем уведомлением
let isIdle = () => true;
let onChange = () => {};
let notify = () => {};
let idleSince = 0;
let idleTimer = null;

function setState(next) {
  state = { ...state, ...next };
  onChange();
}

function start(options) {
  if (!app.isPackaged) return;
  ({ isIdle, onChange, notify } = options);
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.disableWebInstaller = true; // у нас обычный установщик, не веб-установщик
  // Предварительных релизов не публикуем. Без этого сборка с номером вроде 1.0.1-test.1 искала бы
  // только их и не видела обычный последний релиз.
  updater.allowPrerelease = false;
  updater.autoInstallOnAppQuit = true; // вышли из виджета раньше — обновление поставится при выходе
  updater.logger = { info() {}, warn: (m) => log(`обновление: ${m}`), error: (m) => log(`обновление: ${m}`), debug() {} };

  updater.on('checking-for-update', () => setState({ phase: 'checking' }));
  updater.on('update-not-available', () => {
    log(`обновление: стоит последняя версия ${app.getVersion()}`);
    setState({ phase: 'idle' });
    if (manual) notify(`Установлена последняя версия ${app.getVersion()}`);
    manual = false;
  });
  updater.on('update-available', (info) => {
    log(`обновление: найдена версия ${info.version}, скачиваю`);
    setState({ phase: 'downloading', version: info.version, percent: 0 });
    if (manual) notify(`Нашлась версия ${info.version}. Скачаю и поставлю, когда музыка не будет играть`);
    manual = false;
  });
  updater.on('download-progress', (p) => {
    // меню перестраиваем шагами по 10%, а не на каждый пакет
    const percent = Math.floor((p.percent || 0) / 10) * 10;
    if (percent !== state.percent) setState({ percent });
  });
  updater.on('update-downloaded', (info) => {
    log(`обновление: версия ${info.version} скачана, поставлю, когда музыка не будет играть`);
    setState({ phase: 'ready', version: info.version });
    watchIdle();
  });
  updater.on('error', (e) => {
    log(`обновление: ошибка — ${e?.message || e}`);
    if (state.phase === 'ready') return; // уже скачанное обновление ошибка новой проверки не отменяет
    setState({ phase: 'error' });
    if (manual) notify('Не удалось проверить обновления. Подробности — в widget.log');
    manual = false;
  });

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

function check() {
  if (!updater || ['checking', 'downloading', 'ready'].includes(state.phase)) return;
  updater.checkForUpdates().catch(() => {}); // ошибку уже записал обработчик 'error'
}

// Проверка из меню трея. Обновление уже скачано — ставим его сразу.
function checkNow() {
  if (state.phase === 'ready') return install();
  if (state.phase === 'checking' || state.phase === 'downloading') return;
  manual = true;
  check();
}

// Ставим обновление, когда музыка не играет минуту подряд, чтобы не оборвать трек.
function watchIdle() {
  clearInterval(idleTimer);
  idleSince = 0;
  idleTimer = setInterval(() => {
    if (!isIdle()) {
      idleSince = 0;
      return;
    }
    idleSince ||= Date.now();
    if (Date.now() - idleSince >= IDLE_NEEDED_MS) install();
  }, IDLE_POLL_MS);
}

function install() {
  if (state.phase !== 'ready') return;
  clearInterval(idleTimer);
  log(`обновление: ставлю версию ${state.version}`);
  // тихая установка (без окон мастера) и запуск новой версии сразу после неё
  setImmediate(() => updater.quitAndInstall(true, true));
}

// Пункт меню трея по текущему состоянию; null — в сборке из исходников, где обновлений нет.
function menuItem() {
  if (!updater) return null;
  const { phase, version, percent } = state;
  if (phase === 'ready') return { label: `Обновить до ${version} сейчас`, click: install };
  if (phase === 'checking') return { label: 'Проверяю обновления…', enabled: false };
  if (phase === 'downloading') return { label: `Скачиваю версию ${version}… ${percent}%`, enabled: false };
  return { label: `Проверить обновления (сейчас ${app.getVersion()})`, click: checkNow };
}

module.exports = { start, menuItem };
