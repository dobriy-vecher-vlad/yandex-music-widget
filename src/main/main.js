const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, protocol, screen } = require('electron');

const ym = require('../ym/app');
const { Bridge } = require('../ym/bridge');
const lrclib = require('../lyrics/lrclib');
const discord = require('../discord/presence');
const glow = require('./glow');
const popup = require('./popup');
const updater = require('./updater');
const settingsStore = require('./settings');
const geo = require('./geometry');
const win32 = require('./win32');
const { log } = require('./log');

const CDP_PORT = 9339;
const HOTKEY = 'Control+Alt+M';
const STATUS_POLL_MS = 2000;
// Окно, которое тоже держится поверх всех (игра в окне без рамки, оверлей), открывшись позже, ложится
// выше виджета, и Windows сама его уже не поднимет. Пока включено закрепление, виджет дважды в секунду
// спрашивает у Windows, не накрыт ли он, и если накрыт — поднимается. Без koffi — просто поднимается
// раз в 1,5 с вслепую.
const COVER_CHECK_MS = 500;
const HEAL_CHECK_MS = 3000; // самопроверка окна виджета глазами Windows (см. heal)
// Меню и всплывающие окна, открывшиеся под закреплённым виджетом, поднимаем над ним (liftPopups).
const POPUP_CHECK_MS = 150;
const BLIND_RAISE_MS = 1500;
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.ico');

const MIME = {
  '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.webp': 'image/webp',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'ymw', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Chromium считает полностью закрытое окно невидимым и выбрасывает его картинку. Прозрачное окно
// виджета после этого, поднявшись над игрой, оставалось пустым — видна была только подложка.
// Виджет маленький, рисовать его всегда почти ничего не стоит.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Папка настроек не зависит от productName: у установленной копии и у запуска из исходников она общая.
app.setPath('userData', path.join(app.getPath('appData'), 'yandex-music-widget'));

if (!app.requestSingleInstanceLock()) app.quit();
const APP_ID = 'io.github.dobriy-vecher-vlad.yandex-music-widget'; // тот же appId, что в package.json → build
app.setAppUserModelId(APP_ID);

let win = null;
let glowWin = null;
let tray = null;
let settings = settingsStore.load();
settings.dims = geo.normalizeDims(settings.dims);
let bridge = null;
let status = 'connecting';
let lastState = null;
let drag = null;
let resizing = null; // исходные границы, курсор и размеры на начало жеста изменения размера
let view = 'status'; // status — экран состояния фиксированного размера, player — сам плеер
// Должен ли виджет быть на экране по нашей воле. Если Windows спрятала окно, а мы его не прятали,
// самопроверка (heal) показывает его снова.
let wantShown = false;
// Связка с Яндекс Музыкой (settings.linked). Windows запускает виджет при входе с --background: он
// ждёт в трее, появляется, когда Яндекс Музыка открыта и подключена, и прячется, когда её закрыли.
// После тихого обновления установщик запускает виджет с --updated: ведём себя так же, как при входе
// в Windows, — Яндекс Музыку сами не открываем, показываемся, когда она подключится.
const BACKGROUND = process.argv.includes('--background') || process.argv.includes('--updated');
let followHidden = BACKGROUND; // виджет спрятан, потому что Яндекс Музыка не запущена
// «Закрыть до запуска Яндекс Музыки»: виджет и значок в трее убраны, процесс ждёт следующего её
// открытия. armed — её уже видели закрытой, и следующий запуск разбудит виджет.
let sleeping = null; // null — не спит, иначе { armed }
let ymWasRunning = null; // запущена ли она была при прошлой проверке; null — проверок ещё не было
let ymSeenRunning = false; // видели её запущенной с тех пор, как виджет последний раз спрятался
let relaunchedAt = 0; // когда мы сами перезапускали Яндекс Музыку с портом
let portCheckAt = 0; // когда проверяли командную строку её процесса
const RELAUNCH_GUARD_MS = 30 * 1000;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- ресурсы Яндекс Музыки: ymw://ym/<путь внутри app.asar/app>, ymw://tokens/tokens.css ---
function registerAssetProtocol() {
  let tokensCss = null;
  protocol.handle('ymw', (request) => {
    const url = new URL(request.url);
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (url.host === 'tokens') {
      tokensCss ??= ym.extractTokens();
      return new Response(tokensCss, { headers: { ...headers, 'Content-Type': 'text/css' } });
    }
    const file = url.host === 'ym' && ym.assetPath(decodeURIComponent(url.pathname));
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    return new Response(fs.readFileSync(file), { headers: { ...headers, 'Content-Type': type } });
  });
}

// --- окно ---
function createWindow() {
  const size = geo.sizeFor(settings.mode, settings.panel, settings.dims, view);
  const pos = settings.x == null ? geo.defaultPosition(size) : { x: settings.x, y: settings.y };
  const bounds = geo.clampToArea({ ...pos, ...size });

  // Подложка с ореолом создаётся первой: виджет — её дочернее окно и поэтому всегда над ней.
  // Исключение — режим с кнопкой на панели задач: у дочернего окна кнопки быть не может,
  // поэтому там виджет самостоятельный, а порядок «подложка под виджетом» держит restack().
  glowWin = glow.create();
  win = new BrowserWindow({
    ...bounds,
    parent: settings.taskbar ? undefined : glowWin,
    frame: false,
    // Прозрачное окно без системной рамки: углы и обводку рисует CSS, тень — окно ореола под виджетом.
    // Системная рамка Windows 11 давала скругление только вместе со своей тенью, а та затеняла
    // дорисованный в окне ореола круг таймлайна. Изменение размера за края — своё (resize:* в IPC).
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    // со значком на панели задач «скрыть» сворачивает окно, чтобы кнопка на панели оставалась
    minimizable: settings.taskbar,
    fullscreenable: false,
    skipTaskbar: !settings.taskbar,
    icon: ICON_PATH,
    alwaysOnTop: settings.pinned,
    show: false,
    backgroundColor: '#00000000',
    title: 'Yandex Music Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Как у подложки: Chromium никогда не считает страницу виджета скрытой и не выбрасывает её
      // картинку. Без этого после игры на весь экран окно виджета возвращалось пустым — оставалась
      // видна только подложка, у которой этот флаг был с самого начала. Пока виджет скрыт,
      // renderer сам останавливает свой цикл кадров (ui:shown).
      backgroundThrottling: false,
    },
  });
  if (settings.pinned) win.setAlwaysOnTop(true, 'floating');
  glow.attach(win, { pinned: settings.pinned, glow: settings.glow, glowLevel: settings.glowLevel });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (followHidden) return; // запуск в фоне: покажемся, когда подключится Яндекс Музыка
    wantShown = true;
    win.showInactive();
  });
  // с кнопкой на панели задач сворачивание — это и есть «скрыть» (щелчок по кнопке, hideWidget)
  // без кнопки окно не сворачивается вовсе, и если его свернула система — самопроверка вернёт его
  win.on('minimize', () => { if (settings.taskbar) wantShown = false; });
  win.on('restore', () => { wantShown = true; });
  win.on('closed', () => { win = null; });
  popup.create({
    parent: win,
    onSet: (kind, value) => send('ui:pop-set', { kind, value }),
    onActive: (active) => send('ui:popping', active),
  });
  for (const event of ['hide', 'minimize']) win.on(event, () => popup.hide());
  for (const event of ['show', 'hide', 'minimize', 'restore']) {
    win.on(event, () => {
      syncMeter();
      send('ui:shown', isShown());
    });
  }
  // подложка, показанная заново, ложится поверх виджета — возвращаем виджет наверх
  for (const event of ['show', 'restore', 'focus']) win.on(event, () => setImmediate(restack));
  // после сворачивания и скрытия перерисовываем окно целиком, чтобы не остаться пустым
  for (const event of ['show', 'restore']) win.on(event, () => win.webContents.invalidate());
  // щелчок по кнопке на панели задач разворачивает окно — заодно поднимаем его наверх
  win.on('restore', raise);
}

// Подложка — сразу под виджетом. Для дочернего окна это делает Windows, для самостоятельного — мы.
function restack() {
  if (!isShown()) return;
  if (win32.available() && glowWin?.isVisible()) {
    // точно: подложка ложится сразу под виджет, сколько бы окон между ними ни было
    win32.placeBelow(glowWin, win);
    return;
  }
  glow.toTop();
  win.moveTop();
}

// Виден ли виджет на экране: показан и не свёрнут.
const isShown = () => Boolean(win && win.isVisible() && !win.isMinimized());

// Поднимает подложку и виджет над всеми окнами «поверх всех», не забирая фокус.
function raise() {
  if (!isShown() || !settings.pinned) return;
  glow.raise();
  win.setAlwaysOnTop(true, 'floating');
  restack();
  // SetWindowPos(HWND_TOPMOST) напрямую: надёжнее moveTop против окна, которое само держится сверху
  win32.bringToTop(win);
  restack();
}

// Самопроверка глазами Windows. Electron может считать окно видимым, а Windows — нет, или Windows
// могла спрятать окно сама: тогда остаётся одна подложка без виджета. Проверяем, что виджет, который
// должен быть на экране, действительно виден, не спрятан DWM, подложка не свёрнута и лежит под ним,
// а страница не считает себя скрытой. Расхождения чиним и пишем в журнал с причиной.
let healing = false;
async function heal(reason) {
  if (healing || !win || !wantShown || !win32.available()) return;
  healing = true;
  try {
    const problems = [];
    const glowMinimized = Boolean(glowWin?.isMinimized());
    if (glowMinimized) problems.push('подложка свёрнута — Windows прячет вместе с ней и виджет');
    if (!isShown()) problems.push(win.isMinimized() ? 'виджет свёрнут' : 'Windows спрятала виджет');
    const info = win32.inspect(win, glowWin);
    if (isShown() && info.cloaked) problems.push('окно спрятано DWM');
    if (isShown() && info.glowAbove) problems.push('подложка выше виджета');
    const page = isShown() ? await win.webContents.executeJavaScript('document.visibilityState').catch(() => '?') : 'visible';
    if (page !== 'visible') problems.push(`страница: ${page}`);
    if (!problems.length) return;

    log(`самопроверка (${reason}): ${problems.join('; ')} — восстанавливаю`);
    if (glowMinimized) {
      glowWin.restore();
      glowWin.showInactive();
    }
    if (win.isMinimized()) win.restore();
    if (!isShown() || info.cloaked || page !== 'visible') {
      win.hide();
      win.showInactive();
    }
    if (settings.pinned) {
      win.setAlwaysOnTop(true, 'floating');
      win32.bringToTop(win);
    }
    restack();
    win.webContents.invalidate();
    win32.redraw(win);
  } finally {
    healing = false;
  }
}

// свои окна (подложка, слайдер над кнопкой) перекрытием не считаются
const ownWindows = () => [win, glowWin, popup.window()];

// Закреплённый виджет не должен лежать поверх меню и всплывающих окон других программ и Windows.
function liftPopups() {
  if (settings.pinned && isShown()) win32.liftPopupsAbove(win, ownWindows());
}
const isCovered = () => isShown() && Boolean(win32.coveringWindow(win, ownWindows()));

// Поднимаемся, только когда нас действительно накрыли: так виджет не дёргает окна понапрасну.
// В журнал пишем, чьё окно накрыло виджет и сколько подъёмов понадобилось, чтобы вернуться наверх.
let cover = { hwnd: 0, raises: 0 };
function keepOnTop() {
  if (!settings.pinned || !isShown()) return;
  const hwnd = win32.coveringWindow(win, ownWindows());
  if (!hwnd) {
    if (cover.hwnd) {
      log(`снова сверху, подъёмов: ${cover.raises}`);
      heal('после перекрытия');
      win.webContents.invalidate();
    }
    cover = { hwnd: 0, raises: 0 };
    return;
  }
  if (hwnd !== cover.hwnd) {
    const d = win32.describe(hwnd);
    log(`накрыт окном «${d.title}» (класс ${d.cls}, процесс ${d.pid})`);
    cover = { hwnd, raises: 0 };
  }
  cover.raises++;
  raise();
}

function showWidget() {
  if (!win) return createWindow();
  wantShown = true;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  raise();
}

function hideWidget() {
  if (!win) return;
  wantShown = false;
  popup.hide();
  if (settings.taskbar) win.minimize();
  else win.hide();
}

// Ctrl+Alt+M, щелчок по значку в трее: скрытый виджет — показать, перекрытый — поднять, видимый — скрыть.
function toggleVisible() {
  if (!isShown()) return showWidget();
  if (isCovered()) {
    if (settings.pinned) raise();
    else {
      restack();
      win32.bringToTop(win);
      win.setAlwaysOnTop(false); // без закрепления — только поднять над текущими окнами
    }
    return;
  }
  hideWidget();
}

function setTaskbar(enabled) {
  settings.taskbar = enabled;
  settingsStore.save(settings);
  // без кнопки на панели свёрнутый виджет было бы не вернуть — разворачиваем и прячем как обычно
  if (!enabled && win.isMinimized()) {
    win.restore();
    win.hide();
    wantShown = false;
  }
  win.setParentWindow(enabled ? null : glowWin);
  win.setMinimizable(enabled);
  win.setSkipTaskbar(!enabled);
  restack();
  rebuildTrayMenu();
}

function rememberPosition() {
  const b = win.getBounds();
  settings.x = b.x;
  settings.y = b.y;
  settingsStore.save(settings);
}

function applyLayout(mode, panel) {
  popup.hide();
  settings.mode = mode;
  settings.panel = mode === 'art' ? panel : null;
  resizeToView();
  send('ui:layout', { mode: settings.mode, panel: settings.panel });
}

// Окно принимает размер текущего вида: экрана состояния или плеера в выбранном режиме.
function resizeToView() {
  if (!win) return;
  const target = geo.resizeAnchored(win.getBounds(), geo.sizeFor(settings.mode, settings.panel, settings.dims, view));
  geo.animateBounds(win, target);
  settings.x = target.x;
  settings.y = target.y;
  settingsStore.save(settings);
}

// Плеер показываем, только когда есть связь и трек; иначе — экран состояния (как renderStatus в renderer.js).
function syncView() {
  const next = status === 'connected' && lastState?.ready && lastState.track ? 'player' : 'status';
  if (next === view) return;
  view = next;
  resizeToView();
}

function setPinned(pinned) {
  settings.pinned = pinned;
  win.setAlwaysOnTop(pinned, 'floating');
  glow.setPinned(pinned);
  settingsStore.save(settings);
  send('ui:pinned', pinned);
  rebuildTrayMenu();
}

function setGlow(enabled) {
  settings.glow = enabled;
  settingsStore.save(settings);
  glow.setEnabled(enabled);
  send('ui:glow', enabled);
  rebuildTrayMenu();
  syncMeter();
}

// Уровень басов снимаем, только когда его есть кому показать.
function syncMeter() {
  if (!bridge?.connected) return;
  const enabled = Boolean(settings.glow && isShown());
  bridge.act('meter', [enabled]).catch(() => {});
}

function setDiscord(enabled) {
  settings.discord = enabled;
  settingsStore.save(settings);
  discord.setEnabled(enabled);
  rebuildTrayMenu();
}

function setVideoCovers(enabled) {
  settings.videoCovers = enabled;
  settingsStore.save(settings);
  send('ui:video-covers', enabled);
  rebuildTrayMenu();
}

function setLyricsOnline(enabled) {
  settings.lyricsOnline = enabled;
  settingsStore.save(settings);
  rebuildTrayMenu();
}

// --- трей ---
function rebuildTrayMenu() {
  if (!tray) return;
  // проверка обновлений и её состояние; скачанное обновление поставится само, когда музыка не играет
  const update = updater.menuItem();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать / скрыть', accelerator: HOTKEY, click: toggleVisible },
    { label: 'Поверх всех окон', type: 'checkbox', checked: settings.pinned, click: (i) => setPinned(i.checked) },
    { label: 'Показывать на панели задач', type: 'checkbox', checked: settings.taskbar, click: (i) => setTaskbar(i.checked) },
    { label: 'Свечение под музыку', type: 'checkbox', checked: settings.glow, click: (i) => setGlow(i.checked) },
    { label: 'Видеообложки', type: 'checkbox', checked: settings.videoCovers, click: (i) => setVideoCovers(i.checked) },
    { label: 'Искать текст в LRCLIB', type: 'checkbox', checked: settings.lyricsOnline, click: (i) => setLyricsOnline(i.checked) },
    { label: 'Статус в Discord', type: 'checkbox', visible: discord.configured(), checked: settings.discord, click: (i) => setDiscord(i.checked) },
    { label: 'Открыть Яндекс Музыку', click: () => ym.focus() },
    { type: 'separator' },
    // автозапуск имеет смысл только у установленной копии: из исходников в реестр попал бы electron.exe
    { label: 'Запускать вместе с Яндекс Музыкой', type: 'checkbox', visible: app.isPackaged,
      checked: settings.linked, click: (i) => setLinked(i.checked) },
    ...(update ? [update] : []),
    // при связке виджет не выходит совсем, а ждёт следующего открытия Яндекс Музыки;
    // выйти полностью — снять галочку «Запускать вместе с Яндекс Музыкой»
    isLinked()
      ? { label: 'Закрыть до запуска Яндекс Музыки', click: sleep }
      : { label: 'Выход', click: () => { log('выход из меню трея'); app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(ICON_PATH);
  tray.setToolTip('Yandex Music Widget');
  tray.on('click', toggleVisible);
  rebuildTrayMenu();
}

// --- связь с Яндекс Музыкой ---
function setStatus(next) {
  if (status === next) return;
  status = next;
  send('ym:status', status);
  syncView();
}

async function refreshStatus() {
  if (bridge.connected) setStatus('connected');
  else if (!ym.isInstalled()) setStatus('not-installed');
  else if (await bridge.isPortOpen()) setStatus('connecting');
  else setStatus((await ym.isRunning()) ? 'no-port' : 'not-running');
  followYM();
}

// Связка: виджет появляется и прячется вслед за Яндекс Музыкой.
function followYM() {
  const running = status !== 'not-running' && status !== 'not-installed';
  const wasRunning = ymWasRunning;
  ymWasRunning = running;
  if (running) ymSeenRunning = true;
  if (!settings.linked) return;
  if (sleeping) {
    if (!running) sleeping.armed = true;
    else if (sleeping.armed && status === 'connected') wake('Яндекс Музыку открыли снова');
  }
  if (status === 'connected' && followHidden && !sleeping) {
    followHidden = false;
    log('Яндекс Музыка подключена — показываю виджет');
    showWidget();
  }
  // закрыли Яндекс Музыку — прячемся в трей; свой перезапуск её с портом не в счёт
  if (!running && ymSeenRunning && !followHidden && Date.now() - relaunchedAt > RELAUNCH_GUARD_MS) {
    followHidden = true;
    ymSeenRunning = false;
    lastState = null;
    log('Яндекс Музыка закрыта — прячу виджет');
    // прячем целиком, а не сворачиваем: кнопке виджета на панели задач без Яндекс Музыки делать нечего
    wantShown = false;
    popup.hide();
    win?.hide();
  }
  // Её открыли без порта (ярлык, который мы не поправили, автозапуск, ссылка) — только что, пока ничего
  // не играет, перезапускаем с портом. Уже работающую без порта не трогаем: там кнопка на экране состояния.
  const fresh = wasRunning === false || (wasRunning === null && BACKGROUND);
  if (status === 'no-port' && fresh && Date.now() - portCheckAt > RELAUNCH_GUARD_MS) relaunchWithPort();
}

async function relaunchWithPort() {
  portCheckAt = Date.now();
  // в первые секунды порт ещё не открыт и у запущенной с ним Яндекс Музыки — смотрим на командную строку
  if (await ym.hasPortFlag(CDP_PORT)) return;
  relaunchedAt = Date.now();
  log('Яндекс Музыка открыта без порта для виджета — перезапускаю её с портом');
  ym.relaunch(CDP_PORT);
}

// Включает или выключает связку: ярлыки Яндекс Музыки с портом и запуск виджета в фоне при входе в Windows.
function linkWithYM(enabled) {
  if (!app.isPackaged) return; // из исходников в автозапуск попал бы electron.exe
  const changed = ym.patchShortcuts(CDP_PORT, enabled);
  if (changed.length) log(`ярлыки Яндекс Музыки ${enabled ? 'с портом' : 'без порта'}: ${changed.join(', ')}`);
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--background'] });
}

const isLinked = () => app.isPackaged && settings.linked;

// Прячем виджет и значок в трее до следующего открытия Яндекс Музыки. Процесс остаётся: он
// подключён к ней и ждёт её закрытия, а потом — нового запуска. Свечение и Discord выключаем.
function sleep() {
  if (sleeping) return;
  sleeping = { armed: !(ymWasRunning ?? false) };
  followHidden = true;
  log(`закрыт до запуска Яндекс Музыки${sleeping.armed ? '' : ' — жду, пока её закроют и откроют снова'}`);
  wantShown = false;
  popup.hide();
  win?.hide(); // подложка прячется вслед за виджетом (glow.attach)
  discord.setEnabled(false);
  globalShortcut.unregister(HOTKEY);
  tray?.destroy();
  tray = null;
}

function wake(reason) {
  if (!sleeping) return;
  sleeping = null;
  log(`${reason} — возвращаю виджет`);
  createTray();
  globalShortcut.register(HOTKEY, toggleVisible);
  discord.setEnabled(settings.discord);
  followHidden = false;
  showWidget();
}

function setLinked(enabled) {
  settings.linked = enabled;
  settingsStore.save(settings);
  linkWithYM(enabled);
  if (!enabled && followHidden) {
    followHidden = false;
    showWidget();
  }
  rebuildTrayMenu();
}

function startBridge() {
  bridge = new Bridge(CDP_PORT);
  bridge.on('connection', (connected) => {
    refreshStatus();
    if (connected) syncMeter();
  });
  bridge.on('log', (line) => console.log('[bridge]', line));
  bridge.on('message', (msg) => {
    if (msg.type === 'state') {
      lastState = msg.state;
      send('ym:state', msg.state);
      syncView();
      glow.onPlayerState(msg.state);
      discord.onPlayerState(msg.state);
    } else if (msg.type === 'position') {
      send('ym:position', msg);
      discord.onPosition(msg);
    } else if (msg.type === 'meter') {
      glow.onMeter(msg);
    }
  });
  bridge.start();
  setInterval(refreshStatus, STATUS_POLL_MS);
}

// Виджет запустили сами — запускаем и Яндекс Музыку. Запуск в фоне при входе в Windows её не открывает.
async function launchYMIfNeeded() {
  if (ym.isInstalled() && !(await ym.isRunning())) ym.launch(CDP_PORT);
  refreshStatus();
}

// --- IPC ---
function registerIpc() {
  ipcMain.handle('init', () => ({
    settings: { mode: settings.mode, panel: settings.panel, pinned: settings.pinned, glow: settings.glow, glowLevel: settings.glowLevel, videoCovers: settings.videoCovers },
    status,
    state: lastState,
  }));

  ipcMain.handle('ym:act', (_e, name, args) => bridge.act(name, args));
  ipcMain.handle('lyrics:lookup', (_e, track) => (settings.lyricsOnline ? lrclib.lookup(track) : null));
  ipcMain.handle('ym:relaunch', () => ym.relaunch(CDP_PORT));
  ipcMain.handle('ym:launch', () => ym.launch(CDP_PORT));
  ipcMain.handle('ym:focus', () => ym.focus());

  ipcMain.on('ui:layout', (_e, { mode, panel }) => applyLayout(mode, panel));
  ipcMain.on('ui:pin', (_e, pinned) => setPinned(pinned));
  ipcMain.on('ui:glow', (_e, enabled) => setGlow(enabled));
  ipcMain.on('ui:thumb-overflow', (_e, data) => glow.setThumbOverflow(data));
  ipcMain.on('ui:glow-level', (_e, value) => {
    settings.glowLevel = Math.min(1, Math.max(0, Number(value) || 0));
    glow.setLevel(settings.glowLevel);
    settingsStore.save(settings);
  });

  // вертикальные слайдеры громкости и свечения (popup.js): кнопка в виджете, плашка — своё окно
  ipcMain.on('ui:pop-open', (_e, data) => popup.open(data));
  ipcMain.on('ui:pop-leave', () => popup.leaveButton());
  ipcMain.on('ui:pop-value', (_e, data) => popup.update(data));
  ipcMain.on('pop:set', (_e, data) => popup.set(data));
  ipcMain.on('pop:hover', (_e, inside) => popup.hover(Boolean(inside)));
  ipcMain.on('pop:dragging', (_e, active) => popup.setDragging(Boolean(active)));

  // Перетаскивание делаем сами, а не через -webkit-app-region: так работают hover-эффекты
  // и магнит к краям прямо во время движения.
  ipcMain.on('drag:start', (_e, { screenX, screenY }) => {
    popup.hide();
    const b = win.getBounds();
    drag = { dx: screenX - b.x, dy: screenY - b.y, width: b.width, height: b.height };
  });
  ipcMain.on('drag:move', (_e, { screenX, screenY }) => {
    if (!drag) return;
    const raw = { x: Math.round(screenX - drag.dx), y: Math.round(screenY - drag.dy), width: drag.width, height: drag.height };
    const { x, y } = geo.magnetize(raw);
    win.setBounds({ x, y, width: drag.width, height: drag.height });
  });
  // Изменение размера за край: renderer сам определяет край (в полосе — только левый и правый) и шлёт
  // экранные координаты курсора. Размеры считаем от смещения с начала жеста, чтобы обложка
  // оставалась квадратной, а у полосы не менялась высота.
  ipcMain.on('resize:start', (_e, { edge, screenX, screenY }) => {
    if (view !== 'player') return; // экран состояния фиксированного размера
    resizing = { edge, bounds: win.getBounds(), cursor: { x: screenX, y: screenY }, dims: settings.dims };
  });
  ipcMain.on('resize:move', (_e, { screenX, screenY }) => {
    if (!resizing) return;
    const { edge, bounds: b } = resizing;
    const dx = screenX - resizing.cursor.x;
    const dy = screenY - resizing.cursor.y;
    const proposed = {
      width: b.width + (/left/.test(edge) ? -dx : /right/.test(edge) ? dx : 0),
      height: b.height + (/top/.test(edge) ? -dy : /bottom/.test(edge) ? dy : 0),
    };
    const { bounds: next, dims } = geo.resizeFromEdge(b, proposed, edge, settings.mode, settings.panel, resizing.dims);
    settings.dims = dims;
    win.setBounds(next);
  });
  ipcMain.on('resize:end', () => {
    if (!resizing) return;
    resizing = null;
    const b = win.getBounds();
    settings.x = b.x;
    settings.y = b.y;
    settingsStore.save(settings);
  });

  ipcMain.on('drag:end', () => {
    if (!drag) return;
    drag = null;
    const b = win.getBounds();
    const clamped = geo.clampToArea(b);
    if (clamped.x !== b.x || clamped.y !== b.y) geo.animateBounds(win, clamped, 160);
    settings.x = clamped.x;
    settings.y = clamped.y;
    settingsStore.save(settings);
  });
}

// Повторный запуск (ярлык в «Пуске», на рабочем столе) показывает уже работающий виджет и поднимает его.
// Если Яндекс Музыка закрыта — открываем и её.
app.on('second-instance', () => {
  wake('виджет запустили вручную');
  followHidden = false;
  showWidget();
  launchYMIfNeeded();
});

app.whenReady().then(async () => {
  registerAssetProtocol();
  registerIpc();
  createWindow();
  createTray();
  globalShortcut.register(HOTKEY, toggleVisible);
  if (win32.available()) {
    setInterval(keepOnTop, COVER_CHECK_MS);
    setInterval(liftPopups, POPUP_CHECK_MS);
    setInterval(() => heal('плановая'), HEAL_CHECK_MS);
  }
  else setInterval(raise, BLIND_RAISE_MS);
  startBridge();
  discord.setEnabled(settings.discord);
  if (settings.linked) linkWithYM(true);
  if (BACKGROUND) refreshStatus();
  else launchYMIfNeeded();
  updater.start({
    isIdle: () => !lastState?.playing,
    onChange: rebuildTrayMenu,
    notify: (content) => tray?.displayBalloon({ title: 'Yandex Music Widget', content, iconType: 'custom', icon: nativeImage.createFromPath(ICON_PATH) }),
  });

  screen.on('display-removed', () => win && win.setBounds(geo.clampToArea(win.getBounds())));
  screen.on('display-metrics-changed', () => {
    if (!win) return;
    win.setBounds(geo.clampToArea(win.getBounds()));
    setTimeout(() => heal('смена параметров экрана'), 500);
  });
  // Падение процесса GPU или страницы: записываем и перерисовываем виджет, когда Chromium поднимет их заново.
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'GPU') return;
    log(`процесс GPU завершился: ${details.reason}`);
    setTimeout(() => heal('после перезапуска GPU'), 1500);
  });
  app.on('render-process-gone', (_e, contents, details) => {
    log(`страница завершилась: ${details.reason}`);
    if (win && contents === win.webContents) win.reload();
  });
});

app.on('window-all-closed', (e) => e.preventDefault());
// Перед выходом останавливаем адаптер в Яндекс Музыке и дописываем настройки на диск.
let quitting = false;
app.on('before-quit', (e) => {
  if (!quitting) log('виджет завершает работу');
  if (quitting || !bridge?.connected) return settingsStore.flush();
  e.preventDefault();
  quitting = true;
  const timeout = new Promise((r) => setTimeout(r, 800));
  discord.setEnabled(false);
  Promise.race([bridge.act('stop').catch(() => {}), timeout]).finally(() => {
    settingsStore.flush();
    bridge.stop();
    app.quit();
  });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
