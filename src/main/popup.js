// Вертикальный слайдер громкости и яркости ореола — отдельное маленькое окно у кнопки, как
// ChangeVolume в приложении. В окне виджета ему не хватает места: полоса всего 84 px высотой.
// Окно дочернее для виджета: Windows всегда держит его над виджетом, поэтому плашка может лежать
// и поверх обложки. Фокус не берёт; закрывается, когда курсор ушёл и с кнопки, и со слайдера.
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const PLATE = { width: 44, height: 216 }; // ChangeVolume_wrapperSlider: 2.75 × 13.5 rem
const PAD = 12; // поле под тень плашки
const SIZE = { width: PLATE.width + 2 * PAD, height: PLATE.height + 2 * PAD };
const GAP = 4; // зазор между кнопкой и плашкой
const CLOSE_DELAY_MS = 350; // успеть перевести курсор с кнопки на плашку

let popWin = null;
let current = null; // какой слайдер открыт: volume | glow
let overButton = false;
let overPlate = false;
let dragging = false;
let closeTimer = null;
let onSet = () => {};
let onActive = () => {}; // слайдер открыт: виджет держит вид «под курсором», хотя курсор над плашкой

function create({ parent, onSet: handleSet, onActive: handleActive }) {
  onSet = handleSet;
  onActive = handleActive;
  if (alive()) return;
  popWin = new BrowserWindow({
    ...SIZE,
    parent,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'popup', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  popWin.loadFile(path.join(__dirname, '..', 'popup', 'popup.html'));
  popWin.on('closed', () => { popWin = null; });
}

const alive = () => popWin && !popWin.isDestroyed();
const send = (channel, payload) => alive() && popWin.webContents.send(channel, payload);

// rect — кнопка в координатах экрана. Плашка открывается прямо над кнопкой, а если сверху не хватает
// рабочей области экрана — под ней, поверх обложки.
function open({ kind, rect, value, off, theme }) {
  if (!alive()) return;
  clearTimeout(closeTimer);
  overButton = true;
  const area = screen.getDisplayMatching(rect).workArea;
  const x = Math.round(Math.min(area.x + area.width - SIZE.width, Math.max(area.x, rect.x + rect.width / 2 - SIZE.width / 2)));
  const above = rect.y - GAP - PLATE.height - PAD;
  const down = above < area.y;
  const y = Math.round(down ? rect.y + rect.height + GAP - PAD : above);
  if (current === kind && popWin.isVisible()) return;
  current = kind;
  popWin.setBounds({ x, y, ...SIZE });
  send('pop:show', { kind, value, off, theme, down });
  popWin.showInactive();
  onActive(true);
}

function scheduleClose() {
  clearTimeout(closeTimer);
  if (overButton || overPlate || dragging) return;
  closeTimer = setTimeout(hide, CLOSE_DELAY_MS);
}

function hide() {
  clearTimeout(closeTimer);
  overButton = overPlate = dragging = false;
  current = null;
  if (!alive() || !popWin.isVisible()) return;
  send('pop:hide');
  popWin.hide();
  onActive(false);
}

function leaveButton() {
  overButton = false;
  scheduleClose();
}

function hover(inside) {
  overPlate = inside;
  if (inside) clearTimeout(closeTimer);
  else scheduleClose();
}

function setDragging(active) {
  dragging = active;
  if (!active) scheduleClose();
}

// Значение изменилось в виджете (колесо, громкость из Яндекс Музыки) — показываем его на плашке.
function update(data) {
  if (data.kind === current) send('pop:value', data);
}

function set({ kind, value }) {
  if (kind === current) onSet(kind, value);
}

const window_ = () => (alive() ? popWin : null);

module.exports = { create, open, leaveButton, hover, setDragging, update, set, hide, window: window_ };
