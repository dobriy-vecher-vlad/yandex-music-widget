// Немного Win32 через koffi: Electron не умеет спросить у Windows, какое окно лежит поверх виджета.
// Если библиотека не загрузилась, модуль честно отвечает «не знаю», а main обходится средствами Electron.
const { screen } = require('electron');

let api = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  api = {
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)'),
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(POINT pt)'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint flags)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *text, int max)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *name, int max)'),
    GetWindowThreadProcessId: user32.func('uint __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint *pid)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint cmd)'),
    RedrawWindow: user32.func('bool __stdcall RedrawWindow(intptr_t hwnd, intptr_t rect, intptr_t region, uint flags)'),
  };
  try {
    const dwmapi = koffi.load('dwmapi.dll');
    api.DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint attr, _Out_ uint *value, uint size)');
  } catch {
    // без dwmapi просто не узнаем, спрятал ли окно DWM
  }
} catch (e) {
  console.warn('win32: koffi недоступен —', e.message);
}

const GA_ROOT = 2;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
const GW_HWNDNEXT = 2; // окно, лежащее ниже в z-порядке
const GW_HWNDPREV = 3; // окно, лежащее выше в z-порядке
const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000, WS_CAPTION = 0xc00000;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
const DWMWA_CLOAKED = 14;
const RDW_INVALIDATE = 0x1, RDW_ERASE = 0x4, RDW_ALLCHILDREN = 0x80, RDW_UPDATENOW = 0x100, RDW_FRAME = 0x400;
const INSET = 14; // точки проверки отступают от краёв: углы виджета скруглены и прозрачны

const handleOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return Number(buf.length === 8 ? buf.readBigInt64LE() : buf.readInt32LE());
};

const available = () => Boolean(api);

// Окна оболочки Windows, которые ненадолго ложатся поверх всего: «Пуск», поиск, уведомления,
// Alt+Tab, скрытые значки трея, всплывающие меню и подсказки. Подниматься над ними незачем —
// они закрываются сами, а виджет поверх «Пуска» или меню только мешает.
const SHELL_CLASSES = new Set([
  'Windows.UI.Core.CoreWindow', // «Пуск», поиск, центр уведомлений, всплывающие уведомления
  'XamlExplorerHostIslandWindow', // Alt+Tab, Win+Tab
  'MultitaskingViewFrame', // Alt+Tab в Windows 10
  'TopLevelWindowForOverflowXamlIsland', // скрытые значки трея в Windows 11
  'NotifyIconOverflowWindow', // скрытые значки трея в Windows 10
  'Xaml_WindowedPopupClass', // меню и всплывающие окна панели задач
  'Shell_LightDismissOverlay',
  'Shell_InputSwitchTopLevelWindow', // переключатель языка ввода
  'TaskListThumbnailWnd', // миниатюры окон над панелью задач
  'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', // сама панель задач, если она автоскрываемая
  'ForegroundStaging',
  '#32768', // контекстные меню, в том числе меню виджета в трее
  'tooltips_class32',
  'SysShadow',
]);

function classOf(hwnd) {
  const cls = new Uint16Array(256);
  const len = api.GetClassNameW(hwnd, cls, cls.length);
  return String.fromCharCode(...cls.subarray(0, Math.max(0, len)));
}

function pidOf(hwnd) {
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

const textOf = (hwnd) => {
  const text = new Uint16Array(8);
  return api.GetWindowTextW(hwnd, text, text.length) > 0;
};

// Временное окно: оболочки Windows или всплывающее окно любой программы — меню, выпадающий список,
// подсказка, уведомление. У таких окон нет заголовка или они «служебные» (WS_EX_TOOLWINDOW,
// WS_EX_NOACTIVATE). Например, меню Яндекс Музыки в трее — окно Chromium без заголовка.
function isTransient(hwnd) {
  if (SHELL_CLASSES.has(classOf(hwnd))) return true;
  const ex = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;
  if (ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return true;
  const style = Number(api.GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0;
  return Boolean(style & WS_POPUP) && (style & WS_CAPTION) !== WS_CAPTION && !textOf(hwnd);
}

const isOwn = (hwnd, own) => own.has(hwnd) || pidOf(hwnd) === process.pid;

// Окно, ради которого не стоит подниматься: своё (виджет, подложка, слайдер, подсказки Electron —
// всё, что принадлежит нашему процессу) или временное (isTransient).
const ignorable = (hwnd, own) => isOwn(hwnd, own) || isTransient(hwnd);

const isCloaked = (hwnd) => {
  if (!api.DwmGetWindowAttribute) return false;
  const cloaked = [0];
  api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4);
  return cloaked[0] !== 0;
};

// Временные окна, которые открылись под виджетом и перекрываются им: меню в трее, скрытые значки,
// контекстные меню. Windows часто не создаёт их заново, а показывает прежние на старом месте в
// z-порядке — ниже виджета, который с тех пор поднимался. Такие окна поднимаем над виджетом: они
// закрываются сами, а виджет поверх меню только мешает. Полноэкранные (оверлеи игр) не трогаем.
function liftPopupsAbove(win, ownWindows) {
  if (!api) return 0;
  const own = new Set(ownWindows.filter(Boolean).map(handleOf));
  const b = screen.dipToScreenRect(win, win.getBounds());
  const display = screen.getDisplayMatching(win.getBounds());
  const big = display.size.width * display.size.height * display.scaleFactor * display.scaleFactor * 0.8;
  const rect = {};
  let lifted = 0;
  let hwnd = api.GetWindow(handleOf(win), GW_HWNDNEXT);
  for (let i = 0; hwnd && i < 1000; i++, hwnd = api.GetWindow(hwnd, GW_HWNDNEXT)) {
    if (!api.IsWindowVisible(hwnd) || !api.GetWindowRect(hwnd, rect)) continue;
    const w = rect.right - rect.left, h = rect.bottom - rect.top;
    const overlaps = rect.left < b.x + b.width && rect.right > b.x && rect.top < b.y + b.height && rect.bottom > b.y;
    if (!overlaps || w * h >= big || w <= 4 || h <= 4) continue;
    if (isOwn(hwnd, own) || !isTransient(hwnd) || isCloaked(hwnd)) continue;
    api.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    lifted++;
  }
  return lifted;
}

// Чужое окно, которое накрывает виджет хотя бы в одной из пяти точек (центр и четыре угла), или 0.
// Свои и временные окна не считаются (см. ignorable).
function coveringWindow(win, ownWindows) {
  if (!api) return 0;
  const own = new Set(ownWindows.filter(Boolean).map(handleOf));
  const b = win.getBounds();
  const points = [
    { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    { x: b.x + INSET, y: b.y + INSET },
    { x: b.x + b.width - INSET, y: b.y + INSET },
    { x: b.x + INSET, y: b.y + b.height - INSET },
    { x: b.x + b.width - INSET, y: b.y + b.height - INSET },
  ];
  for (const p of points) {
    // getBounds — в DIP, WindowFromPoint ждёт физические пиксели
    const px = screen.dipToScreenPoint({ x: Math.round(p.x), y: Math.round(p.y) });
    const hit = api.WindowFromPoint({ x: px.x, y: px.y });
    const root = hit ? Number(api.GetAncestor(hit, GA_ROOT)) : 0;
    if (root && !ignorable(root, own)) return root;
  }
  return 0;
}

// Ставит окно в самый верх слоя «поверх всех», не активируя его и не трогая положение.
function bringToTop(win) {
  if (!api) return false;
  return api.SetWindowPos(handleOf(win), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// Заголовок, класс и процесс окна — для журнала: чьё окно накрыло виджет.
function describe(hwnd) {
  if (!api || !hwnd) return null;
  const text = new Uint16Array(256);
  const cls = new Uint16Array(256);
  const pid = [0];
  const decode = (buf, len) => String.fromCharCode(...buf.subarray(0, Math.max(0, len)));
  return {
    title: decode(text, api.GetWindowTextW(hwnd, text, text.length)),
    cls: decode(cls, api.GetClassNameW(hwnd, cls, cls.length)),
    pid: (api.GetWindowThreadProcessId(hwnd, pid), pid[0]),
  };
}

// Что о виджете думает сама Windows: виден ли он, свёрнут ли, спрятан ли DWM и не легла ли
// подложка выше него. Electron знает только своё мнение, а оно может разойтись с системным.
function inspect(win, glowWin) {
  if (!api) return null;
  const hwnd = handleOf(win);
  const cloaked = [0];
  if (api.DwmGetWindowAttribute) api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4);
  let glowAbove = false;
  if (glowWin && glowWin.isVisible()) {
    const glow = handleOf(glowWin);
    let above = api.GetWindow(hwnd, GW_HWNDPREV);
    for (let i = 0; above && i < 64; i++, above = api.GetWindow(above, GW_HWNDPREV)) {
      if (Number(above) === glow) { glowAbove = true; break; }
    }
  }
  return { visible: api.IsWindowVisible(hwnd), iconic: api.IsIconic(hwnd), cloaked: cloaked[0] !== 0, glowAbove };
}

// Кладёт подложку ровно под виджет: SetWindowPos(подложка, после = виджет).
function placeBelow(lower, upper) {
  if (!api) return false;
  return api.SetWindowPos(handleOf(lower), handleOf(upper), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// Принудительная перерисовка окна целиком, включая рамку и дочерние окна.
function redraw(win) {
  if (!api) return false;
  return api.RedrawWindow(handleOf(win), 0, 0, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_FRAME);
}

module.exports = { available, coveringWindow, liftPopupsAbove, bringToTop, describe, inspect, placeBelow, redraw };
