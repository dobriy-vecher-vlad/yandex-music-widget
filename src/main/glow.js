// Ореол вокруг виджета — отдельное прозрачное окно, на MARGIN больше виджета с каждой стороны.
// Виджет создаётся дочерним окном подложки, поэтому Windows всегда держит его над ней.
// Подложка не принимает ни кликов, ни фокуса и повторяет каждое перемещение виджета.
const path = require('path');
const { BrowserWindow } = require('electron');

const MARGIN = 90; // должен совпадать с --margin в glow.css

let glowWin = null;
let widget = null;
let enabled = true;
let playing = false;
let trackKey = null;
let level = 0.67;

function create() {
  glowWin = new BrowserWindow({
    width: 200,
    height: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'glow', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  glowWin.setIgnoreMouseEvents(true);
  glowWin.loadFile(path.join(__dirname, '..', 'glow', 'glow.html'));
  glowWin.on('closed', () => { glowWin = null; });
  return glowWin;
}

function send(channel, payload) {
  if (glowWin && !glowWin.isDestroyed()) glowWin.webContents.send(channel, payload);
}

function follow() {
  if (!glowWin || !widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  glowWin.setBounds({ x: b.x - MARGIN, y: b.y - MARGIN, width: b.width + 2 * MARGIN, height: b.height + 2 * MARGIN });
}

// Окно подложки видно всегда, когда виден виджет: кроме ореола оно дорисовывает круг таймлайна,
// выходящий за край виджета. Сам ореол включается и выключается внутри страницы.
function syncVisibility() {
  if (!glowWin || !widget || widget.isDestroyed()) return;
  const visible = widget.isVisible() && !widget.isMinimized();
  if (visible && !glowWin.isVisible()) {
    follow();
    glowWin.showInactive();
  } else if (!visible && glowWin.isVisible()) {
    glowWin.hide();
  }
  send('glow:state', { on: enabled && visible, playing });
}

function attach(widgetWin, { pinned, glow, glowLevel }) {
  widget = widgetWin;
  enabled = glow;
  level = glowLevel;
  setPinned(pinned);
  for (const event of ['move', 'resize', 'moved', 'resized']) widget.on(event, follow);
  for (const event of ['show', 'hide', 'minimize', 'restore']) widget.on(event, syncVisibility);
  glowWin.webContents.once('did-finish-load', () => {
    send('glow:level', level);
    syncVisibility();
  });
}

function setPinned(pinned) {
  if (glowWin) glowWin.setAlwaysOnTop(pinned, 'floating');
}

// Подложку поднимаем вместе с виджетом; сам виджет main ставит сразу над ней (restack).
function raise() {
  if (!glowWin || !glowWin.isVisible()) return;
  glowWin.setAlwaysOnTop(true, 'floating');
  glowWin.moveTop();
}

function toTop() {
  if (glowWin && glowWin.isVisible()) glowWin.moveTop();
}

// Круг таймлайна полосы в координатах виджета (или null) — подложка рисует его часть за краем виджета.
function setThumbOverflow(data) {
  send('glow:thumb', data);
}

function setLevel(value) {
  level = value;
  send('glow:level', level);
}

function setEnabled(value) {
  enabled = value;
  syncVisibility();
}

// Акцентный цвет обложки — тот же averageColor, из которого Яндекс Музыка красит фон плеера
// (hsl(тон, насыщенность, 20%)); для света берём тот же тон и насыщенность, но светлее.
function hexToHueSat(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100) };
}

function accentColors(averageColor) {
  // у загруженных пользователем файлов цвета нет — нейтральный светлый
  const { h, s } = averageColor ? hexToHueSat(averageColor) : { h: 0, s: 0 };
  const sat = Math.min(100, Math.round(s * 1.2));
  // три оттенка одного цвета разной светлоты — ореол объёмный, но не пёстрый
  return [56, 64, 48].map((l) => `hsl(${h}, ${sat}%, ${l}%)`);
}

// Состояние плеера: на смене трека меняем цвет, на паузе ореол гаснет.
function onPlayerState(state) {
  const nowPlaying = Boolean(state.ready && state.playing);
  if (nowPlaying !== playing) {
    playing = nowPlaying;
    syncVisibility();
  }
  const track = state.track;
  const key = track ? track.id : null;
  if (!track || key === trackKey) return;
  trackKey = key;
  send('glow:colors', accentColors(track.averageColor));
}

function onMeter(msg) {
  send('glow:meter', msg);
}

module.exports = { create, attach, setPinned, raise, toTop, setEnabled, setLevel, setThumbOverflow, onPlayerState, onMeter, MARGIN };
