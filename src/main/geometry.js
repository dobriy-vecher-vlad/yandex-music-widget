// Размеры режимов, прилипание к краям экрана и анимация границ окна.
const { screen } = require('electron');

// Размеры, которые пользователь может менять, и их пределы.
const DIMS = {
  artWidth: { def: 320, min: 260, max: 560 }, // сторона квадратной обложки
  panelHeight: { def: 380, min: 200, max: 760 }, // высота раскрытой панели (очередь / текст)
  barWidth: { def: 480, min: 460, max: 900 }, // при наведении выезжают ещё три кнопки; название сжимается, но не пропадает
};
const BAR_HEIGHT = 84; // 10 + обложка 64 + 10; таймлайн рисуется поверх нижнего отступа
// Экран состояния («не запущена», «ничего не играет»…) всегда одного размера, независимо от режима.
const STATUS_SIZE = { width: 320, height: 168 };
const EDGE_GAP = 12; // отступ от края экрана у прилипшего окна
const MAGNET = 28; // на каком расстоянии окно притягивается к краю

const clamp = (value, key) => Math.round(Math.min(DIMS[key].max, Math.max(DIMS[key].min, value)));

function normalizeDims(dims = {}) {
  const out = {};
  for (const key of Object.keys(DIMS)) out[key] = clamp(dims[key] ?? DIMS[key].def, key);
  return out;
}

function sizeFor(mode, panel, dims, view = 'player') {
  if (view === 'status') return { ...STATUS_SIZE };
  if (mode === 'bar') return { width: dims.barWidth, height: BAR_HEIGHT };
  return { width: dims.artWidth, height: panel ? dims.artWidth + dims.panelHeight : dims.artWidth };
}

// Пересчитывает размер при перетаскивании края окна (proposed — размер по смещению курсора).
// Обложка всегда квадратная; при открытой панели верх/низ меняют высоту панели.
// Противоположный край остаётся на месте.
function resizeFromEdge(current, proposed, edge, mode, panel, dims) {
  const next = { ...dims };
  const horizontal = /left|right/.test(edge);
  const vertical = /top|bottom/.test(edge);
  if (mode === 'bar') {
    next.barWidth = clamp(proposed.width, 'barWidth');
  } else if (panel) {
    if (horizontal) next.artWidth = clamp(proposed.width, 'artWidth');
    if (vertical) next.panelHeight = clamp(proposed.height - next.artWidth, 'panelHeight');
  } else {
    const side = horizontal && vertical ? Math.max(proposed.width, proposed.height) : horizontal ? proposed.width : proposed.height;
    next.artWidth = clamp(side, 'artWidth');
  }
  // Окно не должно становиться выше рабочей области экрана.
  const area = workAreaFor(current);
  const maxHeight = area.height - 2 * EDGE_GAP;
  if (mode === 'art') {
    next.artWidth = Math.min(next.artWidth, maxHeight);
    if (panel) next.panelHeight = Math.max(DIMS.panelHeight.min, Math.min(next.panelHeight, maxHeight - next.artWidth));
  }
  const size = sizeFor(mode, panel, next);
  const stuckRight = current.x + current.width >= area.x + area.width - EDGE_GAP - 2;
  const fromRight = /left/.test(edge) || (!horizontal && stuckRight);
  const x = fromRight ? current.x + current.width - size.width : current.x;
  // Окно у нижнего края экрана при изменении ширины растёт вверх, а не уезжает под панель задач.
  const stuckBottom = current.y + current.height >= area.y + area.height - EDGE_GAP - 2;
  const fromBottom = /top/.test(edge) || (!vertical && stuckBottom);
  const y = fromBottom ? current.y + current.height - size.height : current.y;
  return { bounds: clampToArea({ x, y, ...size }), dims: next };
}

function workAreaFor(bounds) {
  return screen.getDisplayMatching(bounds).workArea;
}

// Притягивает прямоугольник к ближайшим краям рабочей области.
// Возвращает новые координаты и признаки того, к каким краям окно прилипло.
function magnetize(bounds) {
  const area = workAreaFor(bounds);
  const left = area.x + EDGE_GAP;
  const top = area.y + EDGE_GAP;
  const right = area.x + area.width - EDGE_GAP - bounds.width;
  const bottom = area.y + area.height - EDGE_GAP - bounds.height;
  let { x, y } = bounds;
  const stuck = { left: false, right: false, top: false, bottom: false };
  if (Math.abs(x - left) < MAGNET) { x = left; stuck.left = true; }
  else if (Math.abs(x - right) < MAGNET) { x = right; stuck.right = true; }
  if (Math.abs(y - top) < MAGNET) { y = top; stuck.top = true; }
  else if (Math.abs(y - bottom) < MAGNET) { y = bottom; stuck.bottom = true; }
  return { x, y, stuck };
}

// Не даёт окну уехать за пределы рабочей области (смена мониторов, раскрытие панели у края).
function clampToArea(bounds) {
  const area = workAreaFor(bounds);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
  return { ...bounds, x, y };
}

function defaultPosition(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - size.width - EDGE_GAP, y: area.y + area.height - size.height - EDGE_GAP };
}

// Новые границы при смене размера: окно растёт от того края, у которого стоит.
// Если снизу не хватает места — растёт вверх.
function resizeAnchored(current, size) {
  const area = workAreaFor(current);
  const nearBottom = current.y + current.height >= area.y + area.height - EDGE_GAP - 2;
  const nearRight = current.x + current.width >= area.x + area.width - EDGE_GAP - 2;
  let x = nearRight ? current.x + current.width - size.width : current.x;
  let y = nearBottom ? current.y + current.height - size.height : current.y;
  if (y + size.height > area.y + area.height) y = area.y + area.height - size.height - EDGE_GAP;
  return clampToArea({ x, y, ...size });
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

const animations = new WeakMap();

function animateBounds(win, target, duration = 220) {
  clearInterval(animations.get(win));
  const from = win.getBounds();
  const start = Date.now();
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);
    const t = Math.min(1, (Date.now() - start) / duration);
    const k = easeOutCubic(t);
    const lerp = (a, b) => Math.round(a + (b - a) * k);
    win.setBounds({
      x: lerp(from.x, target.x),
      y: lerp(from.y, target.y),
      width: lerp(from.width, target.width ?? from.width),
      height: lerp(from.height, target.height ?? from.height),
    });
    if (t === 1) clearInterval(timer);
  }, 1000 / 120);
  animations.set(win, timer);
}

module.exports = { normalizeDims, sizeFor, resizeFromEdge, magnetize, clampToArea, defaultPosition, resizeAnchored, animateBounds };
