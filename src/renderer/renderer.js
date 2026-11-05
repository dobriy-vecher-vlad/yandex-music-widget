const app = document.getElementById('app');
const queueEl = document.getElementById('queue');
const lyricsEl = document.getElementById('lyrics');
const viewBar = document.querySelector('.view-bar');
const barTimeline = document.querySelector('.bar-timeline');

const ui = { mode: 'art', panel: null, pinned: true, glow: true, glowLevel: 0.67, videoCovers: true, status: 'connecting' };
let state = null;
let base = { position: 0, at: performance.now(), playing: false };
let seeking = null; // { slider, value } пока пользователь тянет таймлайн
let lyrics = { trackId: null, data: null, loading: false };
let renderedQueueKey = '';
let userScrolledAt = 0;

const $$ = (selector) => document.querySelectorAll(selector);
const bindAll = (name, fn) => $$(`[data-bind="${name}"]`).forEach(fn);

// ---------- бегущая строка: длинное название и исполнители при наведении прокручиваются целиком ----------
// Текст лежит во вложенном span: строка обрезается многоточием, а при наведении на блок с названием
// span плавно уезжает влево до конца текста и возвращается.
function setRunText(el, text) {
  let run = el.firstElementChild;
  if (!run) {
    run = document.createElement('span');
    run.className = 'run';
    el.append(run);
  }
  if (run.textContent === text) return;
  run.textContent = text;
  el.classList.remove('is-running');
}

function startRunning(meta) {
  meta.querySelectorAll('.title, .artists').forEach((el) => {
    const over = el.scrollWidth - el.clientWidth;
    if (over < 2) return;
    el.style.setProperty('--shift', `${-over - 12}px`); // конец текста не уходит под затухание справа
    // скорость около 35 px/с, плюс паузы в начале и в конце
    el.style.setProperty('--dur', `${(over / 35 + 1.6).toFixed(2)}s`);
    el.classList.add('is-running');
  });
}

document.querySelectorAll('.meta').forEach((meta) => {
  meta.addEventListener('pointerenter', () => startRunning(meta));
  meta.addEventListener('pointerleave', () => meta.querySelectorAll('.is-running').forEach((el) => el.classList.remove('is-running')));
});

// ---------- утилиты ----------
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function hexToHsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100), l };
}

const artistsText = (track) => track.artists.map((a) => a.name).join(', ');

function setIcon(button, id) {
  const use = button.querySelector('use');
  if (use.getAttribute('href') !== `#${id}`) use.setAttribute('href', `#${id}`);
}

function currentPosition() {
  if (seeking) return seeking.value;
  const elapsed = base.playing ? (performance.now() - base.at) / 1000 : 0;
  return Math.min(base.position + elapsed, state?.duration || Infinity);
}

// ---------- действия ----------
async function act(name, ...args) {
  try {
    return await window.widget.act(name, ...args);
  } catch (e) {
    console.warn(name, e);
    return null;
  }
}

const actions = {
  toggle: () => {
    base = { position: currentPosition(), at: performance.now(), playing: !base.playing };
    app.classList.toggle('is-playing', base.playing);
    renderPlayButtons(base.playing);
    act('toggle');
  },
  next: () => skipNext(),
  prev: () => act('prev'),
  like: () => {
    if (!state?.track) return;
    state.track.liked = !state.track.liked;
    if (state.track.liked) state.track.disliked = false;
    renderLike();
    act('like', state.track.id, state.track.albumId);
  },
  // Как в приложении: «не нравится» у текущего трека помечает его и сразу переключает на следующий.
  dislike: () => {
    if (!state?.track) return;
    state.track.disliked = !state.track.disliked;
    if (state.track.disliked) state.track.liked = false;
    renderLike();
    act('dislike', state.track.id, state.track.albumId);
  },
  mute: () => setVolume(volume.value > 0 ? 0 : volume.restore),
  shuffle: () => act('shuffle'),
  repeat: () => act('repeat'),
  pin: () => window.widget.setPinned(!ui.pinned),
  glow: () => window.widget.setGlow(!ui.glow),
  'to-bar': () => window.widget.setLayout('bar', null),
  'to-art': () => window.widget.setLayout('art', null),
  'panel-queue': () => window.widget.setLayout('art', ui.panel === 'queue' ? null : 'queue'),
  'panel-lyrics': () => window.widget.setLayout('art', ui.panel === 'lyrics' ? null : 'lyrics'),
  'tab-queue': () => window.widget.setLayout('art', 'queue'),
  'tab-lyrics': () => window.widget.setLayout('art', 'lyrics'),
};

function ripple(button, event) {
  const r = button.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const wave = document.createElement('span');
  wave.className = 'ripple';
  wave.style.cssText = `width:${size}px;height:${size}px;left:${event.clientX - r.left - size / 2}px;top:${event.clientY - r.top - size / 2}px`;
  button.appendChild(wave);
  wave.addEventListener('animationend', () => wave.remove());
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button || button.disabled) return;
  // клик, которым закончилось перетаскивание окна (например, за обложку в полосе), не считается нажатием
  if (justDragged) return;
  if (button.matches('button')) ripple(button, e);
  actions[button.dataset.action]?.();
});

// ---------- изменение размера за края ----------
// Окно прозрачное и без системной рамки, поэтому края обрабатываем сами. В полосе тянуть можно
// только влево-вправо: сверху и снизу курсора растягивания нет, и он не мешает таймлайну у нижнего края.
const RESIZE_ZONE = 5;
const RESIZE_CURSORS = {
  left: 'ew-resize', right: 'ew-resize', top: 'ns-resize', bottom: 'ns-resize',
  'top-left': 'nwse-resize', 'bottom-right': 'nwse-resize', 'top-right': 'nesw-resize', 'bottom-left': 'nesw-resize',
};
let resizing = false;

function resizeEdgeAt(x, y) {
  if (app.dataset.status !== 'ready') return null; // экран состояния фиксированного размера
  const horizontal = x < RESIZE_ZONE ? 'left' : x > innerWidth - RESIZE_ZONE ? 'right' : '';
  if (ui.mode === 'bar') return horizontal || null;
  const vertical = y < RESIZE_ZONE ? 'top' : y > innerHeight - RESIZE_ZONE ? 'bottom' : '';
  return (vertical && horizontal ? `${vertical}-${horizontal}` : vertical || horizontal) || null;
}

function setResizeCursor(edge) {
  const cursor = edge ? RESIZE_CURSORS[edge] : '';
  if (document.documentElement.style.getPropertyValue('--resize-cursor') === cursor) return;
  document.documentElement.style.setProperty('--resize-cursor', cursor);
  document.documentElement.classList.toggle('is-resize-zone', Boolean(edge));
}

window.addEventListener('pointermove', (e) => {
  if (resizing) {
    window.widget.resizeMove(e.screenX, e.screenY);
    return;
  }
  if (!pending?.started) setResizeCursor(resizeEdgeAt(e.clientX, e.clientY));
}, true);

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const edge = resizeEdgeAt(e.clientX, e.clientY);
  if (!edge) return;
  // нажатие у края — это растягивание, а не перетаскивание или клик по кнопке
  e.stopPropagation();
  e.preventDefault();
  resizing = true;
  document.documentElement.setPointerCapture(e.pointerId);
  window.widget.resizeStart(edge, e.screenX, e.screenY);
}, true);

const endResize = () => {
  if (!resizing) return;
  resizing = false;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  window.widget.resizeEnd();
};
window.addEventListener('pointerup', endResize, true);
window.addEventListener('pointercancel', endResize, true);
document.documentElement.addEventListener('pointerleave', () => { if (!resizing) setResizeCursor(null); });

// ---------- перетаскивание окна ----------
let pending = null;
let justDragged = false;
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button, [data-slider], .row, .line, .cover-expand') || !e.target.closest('[data-drag]')) return;
  pending = { x: e.screenX, y: e.screenY, id: e.pointerId, started: false };
});
document.addEventListener('pointermove', (e) => {
  if (!pending) return;
  if (!pending.started) {
    if (Math.hypot(e.screenX - pending.x, e.screenY - pending.y) < 4) return;
    // Захват — только когда движение началось: иначе обычный клик (по обложке в полосе) уходит на корень документа.
    document.documentElement.setPointerCapture(pending.id);
    pending.started = true;
    app.classList.add('is-dragging');
    window.widget.dragStart(pending.x, pending.y);
  }
  window.widget.dragMove(e.screenX, e.screenY);
});
const endDrag = () => {
  if (pending?.started) {
    window.widget.dragEnd();
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
  }
  pending = null;
  app.classList.remove('is-dragging');
};
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// ---------- таймлайн ----------
$$('[data-slider]').forEach((slider) => {
  const valueAt = (e) => {
    const r = slider.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (state?.duration || 0);
  };
  slider.addEventListener('pointerdown', (e) => {
    if (!state?.duration) return;
    slider.setPointerCapture(e.pointerId);
    seeking = { slider, value: valueAt(e) };
    slider.classList.add('is-seeking');
  });
  slider.addEventListener('pointermove', (e) => { if (seeking?.slider === slider) seeking.value = valueAt(e); });
  slider.addEventListener('pointerup', () => {
    if (seeking?.slider !== slider) return;
    const value = seeking.value;
    base = { position: value, at: performance.now(), playing: base.playing };
    seeking = null;
    slider.classList.remove('is-seeking');
    act('seek', value);
  });
});

// Высота выезжающей части обложки — на неё в покое сдвинут нижний блок (см. .art-bottom в styles.css)
const artBottom = document.querySelector('.art-bottom');
const artMore = document.querySelector('.art-more');
new ResizeObserver(() => artBottom.style.setProperty('--more-h', `${artMore.offsetHeight}px`)).observe(artMore);

// ---------- вертикальные слайдеры над кнопками: яркость ореола и громкость ----------
// Сам слайдер — отдельное окно (main/popup.js): в полосе высотой 84 px ему не хватает места.
// Здесь живут значения; окну слайдера отправляем каждое изменение, а оттуда приходят сдвиги ползунка.
const hud = document.getElementById('volume-hud');
const volumeFill = document.getElementById('volume-fill');

const popOff = (kind) => kind === 'glow' && !ui.glow; // выключенный ореол: слайдер приглушён

function renderLevel(kind, value) {
  window.widget.popValue({ kind, value, off: popOff(kind) });
}

const clamp01 = (value) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

function renderGlowLevel() {
  $$('.pop-ctl[data-pop="glow"]').forEach((ctl) => ctl.classList.toggle('is-off', !ui.glow));
  renderLevel('glow', ui.glowLevel);
}

function setGlowLevel(value) {
  ui.glowLevel = clamp01(value);
  renderGlowLevel();
  window.widget.setGlowLevel(ui.glowLevel);
  // уровень выше нуля при выключенном ореоле — значит, его хотят видеть
  if (!ui.glow && ui.glowLevel > 0) window.widget.setGlow(true);
}

// Громкость меняем сразу в интерфейсе, а в Яндекс Музыку отправляем не чаще раза в 50 мс.
// Пока пользователь двигает слайдер (и ещё немного после), громкость из снимков плеера не применяем,
// иначе запоздавший снимок отбросит ползунок назад.
const volume = { value: 1, restore: 0.5, heldUntil: 0, timer: null };

function renderVolume() {
  renderLevel('volume', volume.value);
  const muted = volume.value === 0;
  $$('[data-action="mute"]').forEach((b) => {
    setIcon(b, muted ? 'volumeOff_xs' : 'volume_xs');
    b.title = muted ? 'Включить звук' : 'Выключить звук';
  });
  volumeFill.style.width = `${volume.value * 100}%`;
}

function setVolume(value) {
  volume.value = clamp01(value);
  if (volume.value > 0) volume.restore = volume.value;
  volume.heldUntil = performance.now() + 1500;
  renderVolume();
  if (!volume.timer) {
    volume.timer = setTimeout(() => {
      volume.timer = null;
      act('volume', volume.value);
    }, 50);
  }
}

function syncVolume(value) {
  if (performance.now() < volume.heldUntil || !Number.isFinite(value)) return;
  volume.value = clamp01(value);
  if (volume.value > 0) volume.restore = volume.value;
  renderVolume();
}

const levels = {
  glow: { get: () => ui.glowLevel, set: setGlowLevel },
  volume: { get: () => volume.value, set: setVolume },
};

$$('.pop-ctl').forEach((ctl) => {
  const kind = ctl.dataset.pop;
  const level = levels[kind];
  ctl.addEventListener('pointerenter', () => {
    const r = ctl.querySelector('button').getBoundingClientRect();
    window.widget.popOpen({
      kind,
      value: level.get(),
      off: popOff(kind),
      theme: state?.theme,
      rect: { x: Math.round(window.screenX + r.left), y: Math.round(window.screenY + r.top), width: Math.round(r.width), height: Math.round(r.height) },
    });
  });
  ctl.addEventListener('pointerleave', () => window.widget.popLeave());
  ctl.addEventListener('wheel', (e) => {
    e.stopPropagation();
    level.set(level.get() + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: true });
});

// ---------- громкость колесом над обложкой и полосой ----------
let hudTimer = null;
app.addEventListener('wheel', (e) => {
  if (!state?.ready || app.dataset.status !== 'ready' || e.target.closest('.panel-body')) return;
  setVolume(volume.value + (e.deltaY < 0 ? 0.05 : -0.05));
  hud.classList.add('is-visible');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.remove('is-visible'), 1200);
}, { passive: true });

// ---------- отрисовка ----------
function renderPlayButtons(playing) {
  $$('[data-action="toggle"]').forEach((b) => setIcon(b, playing ? 'pause_filled_l' : 'play_filled_l'));
}

function renderLike() {
  const liked = Boolean(state?.track?.liked);
  const disliked = Boolean(state?.track?.disliked);
  $$('[data-action="like"]').forEach((b) => {
    setIcon(b, liked ? 'liked_xs' : 'like_xs');
    b.classList.toggle('is-active', liked);
    b.title = liked ? 'Убрать из «Мне нравится»' : 'Нравится';
  });
  $$('[data-action="dislike"]').forEach((b) => {
    setIcon(b, disliked ? 'disliked_xs' : 'dislike_xs');
    b.classList.toggle('is-active', disliked);
    b.title = disliked ? 'Убрать из «Не нравится»' : 'Не нравится';
  });
}

function renderTrack() {
  const t = state.track;
  bindAll('title', (el) => setRunText(el, t ? t.title + (t.version ? ` · ${t.version}` : '') : ''));
  bindAll('artists', (el) => setRunText(el, t ? artistsText(t) : ''));
  bindAll('cover', (el) => {
    const src = t?.cover || '';
    if (el.getAttribute('src') !== src) src ? el.setAttribute('src', src) : el.removeAttribute('src');
  });
  if (t?.averageColor) {
    const { h, s } = hexToHsl(t.averageColor);
    const l = state.theme === 'light' ? 92 : 20;
    app.style.setProperty('--player-average-color-background', `hsl(${h}, ${s}%, ${l}%)`);
  } else {
    app.style.removeProperty('--player-average-color-background');
  }
}

function renderControls() {
  renderPlayButtons(state.playing);
  renderLike();
  app.classList.toggle('is-playing', state.playing);
  $$('[data-action="next"]').forEach((b) => { b.disabled = !state.canNext; });
  $$('[data-action="prev"]').forEach((b) => { b.disabled = !state.canPrev; });
  const shuffle = document.querySelector('[data-action="shuffle"]');
  shuffle.disabled = !state.canShuffle;
  shuffle.classList.toggle('is-active', state.shuffle);
  const repeat = document.querySelector('[data-action="repeat"]');
  repeat.disabled = !state.canRepeat;
  repeat.classList.toggle('is-active', state.repeat !== 'none');
  setIcon(repeat, state.repeat === 'one' ? 'repeat_one_xs' : 'repeat_xs');
  const lyricsButton = document.querySelector('[data-action="panel-lyrics"]');
  lyricsButton.classList.toggle('is-active', ui.panel === 'lyrics');
  document.querySelector('[data-action="panel-queue"]').classList.toggle('is-active', ui.panel === 'queue');
}

function renderLayout() {
  app.dataset.mode = ui.mode;
  app.dataset.panel = ui.panel || '';
  $$('[data-action="pin"]').forEach((b) => {
    b.classList.toggle('is-active', ui.pinned);
    setIcon(b, ui.pinned ? 'pin_filled_xxs' : 'pin_xxs');
    b.title = ui.pinned ? 'Открепить' : 'Закрепить поверх всех окон';
  });
  renderGlowLevel();
  $$('[data-action="glow"]').forEach((b) => {
    b.classList.toggle('is-active', ui.glow);
    setIcon(b, ui.glow ? 'lamp_filled_xxs' : 'lamp_xxs');
    b.title = ui.glow ? 'Выключить свечение' : 'Включить свечение под музыку';
  });
  document.querySelector('[data-action="tab-queue"]').classList.toggle('is-active', ui.panel === 'queue');
  document.querySelector('[data-action="tab-lyrics"]').classList.toggle('is-active', ui.panel === 'lyrics');
  if (state) renderControls();
  if (ui.panel === 'lyrics') loadLyrics();
  if (ui.panel === 'queue') requestAnimationFrame(() => scrollQueueToCurrent(true));
}

const STATUS_TEXT = {
  connecting: ['Подключаемся к Яндекс Музыке…'],
  'no-port': ['Яндекс Музыка запущена без доступа для виджета. Перезапустите её, чтобы виджет заработал', 'Перезапустить', () => window.widget.relaunchYM()],
  'not-running': ['Яндекс Музыка не запущена', 'Запустить', () => window.widget.launchYM()],
  'not-installed': ['Яндекс Музыка для Windows не установлена'],
  idle: ['Сейчас ничего не играет. Включите музыку в Яндекс Музыке', 'Открыть Яндекс Музыку', () => window.widget.focusYM()],
};

function renderStatus() {
  let key = ui.status;
  if (key === 'connected') key = state?.ready && state.track ? 'ready' : state?.ready ? 'idle' : 'connecting';
  app.dataset.status = key;
  if (key === 'ready') return;
  const [text, label, handler] = STATUS_TEXT[key];
  document.getElementById('status-text').textContent = text;
  const button = document.getElementById('status-action');
  button.hidden = !label;
  if (label) {
    button.textContent = label;
    button.onclick = handler;
  }
}

// ---------- очередь ----------
function renderQueue() {
  const q = state.queue;
  const key = JSON.stringify([q.index, q.items.map((i) => [i.index, i.id, i.liked])]);
  if (key === renderedQueueKey) return;
  const firstRender = !renderedQueueKey;
  renderedQueueKey = key;

  queueEl.replaceChildren(...q.items.map((item) => {
    const li = document.createElement('li');
    li.className = 'row' + (item.index === q.index ? ' is-current' : '') + (item.index < q.index ? ' is-past' : '');
    li.dataset.index = item.index;
    li.innerHTML = `
      <div class="row-cover"><span class="eq"><i></i><i></i><i></i></span></div>
      <div class="meta"><div class="title"></div><div class="artists"></div></div>
      <button class="btn btn-like${item.liked ? ' is-active' : ''}" title="Нравится"><svg class="i20"><use href="#${item.liked ? 'liked_xxs' : 'like_xxs'}"/></svg></button>
      <span class="row-time">${formatTime(item.durationSec)}</span>`;
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = '';
      img.draggable = false;
      img.loading = 'lazy';
      li.querySelector('.row-cover').prepend(img);
    }
    li.querySelector('.title').textContent = item.title + (item.version ? ` · ${item.version}` : '');
    li.querySelector('.artists').textContent = artistsText(item);
    li.querySelector('.btn-like').addEventListener('click', (e) => {
      e.stopPropagation();
      const button = e.currentTarget;
      const liked = !button.classList.contains('is-active');
      button.classList.toggle('is-active', liked);
      setIcon(button, liked ? 'liked_xxs' : 'like_xxs');
      act('like', item.id, item.albumId);
    });
    li.addEventListener('click', () => { if (item.index !== q.index) act('playIndex', item.index); });
    return li;
  }));
  scrollQueueToCurrent(firstRender);
}

function scrollQueueToCurrent(force) {
  if (ui.panel !== 'queue') return;
  if (!force && performance.now() - userScrolledAt < 5000) return;
  const current = queueEl.querySelector('.is-current');
  if (current) queueEl.scrollTo({ top: current.offsetTop - 8, behavior: force ? 'instant' : 'smooth' });
}
queueEl.addEventListener('wheel', () => { userScrolledAt = performance.now(); }, { passive: true });

// ---------- текст песни ----------
// Повторяет SyncLyricsScroller Яндекс Музыки: вертикальная лента (Swiper, 32 px между строками),
// активная строка прокручивается к верху и увеличивается в 1.2 раза, следующая — 0.3, дальше — 0.1,
// спетые скрыты. Перед первой строкой — пульсирующие точки, за 3 с — обратный отсчёт.
// Ручная прокрутка на 3 с показывает все строки и делает их кликабельными.
const LYRICS_IDLE_MS = 3000;
const PREPARE_SEC = 3;
let lyricsView = null;

async function loadLyrics() {
  const t = state?.track;
  if (!t || ui.panel !== 'lyrics' || lyrics.trackId === t.id) return;
  lyrics = { trackId: t.id, data: null, loading: true };
  renderLyrics();
  let data = t.hasSyncLyrics ? await act('lyrics', t.id) : null;
  if (!data?.lines?.length) {
    data = await window.widget.lookupLyrics({
      title: t.title,
      artists: t.artists.map((a) => a.name),
      album: t.albumTitle,
      duration: t.durationSec || state.duration,
    }).catch(() => null);
  }
  if (lyrics.trackId !== t.id) return;
  lyrics = { trackId: t.id, data, loading: false };
  renderLyrics();
}

function lyricsFooterText(data) {
  if (data.source === 'lrclib') return data.synced ? 'Текст: LRCLIB' : 'Текст: LRCLIB · без синхронизации';
  return data.writers?.length ? 'Авторы: ' + data.writers.join(', ') : '';
}

function renderLyrics() {
  lyricsView = null;
  lyricsEl.className = 'lyrics';
  delete lyricsEl.dataset.state;
  const note = (text) => { const div = document.createElement('div'); div.className = 'lyrics-note'; div.textContent = text; return div; };
  if (lyrics.loading) return lyricsEl.replaceChildren(note('Загружаем текст…'));
  const data = lyrics.data;
  if (!data?.lines?.length) return lyricsEl.replaceChildren(note('Текст для этого трека не найден'));

  const track = document.createElement('div');
  track.className = 'lyrics-track';
  const counter = document.createElement('div');
  counter.className = 'lyrics-slide lyrics-counter';
  const lines = data.lines.map((line, i) => {
    const slide = document.createElement('div');
    slide.className = 'lyrics-slide line' + (i === data.lines.length - 1 ? ' is-last' : '');
    const text = document.createElement('span');
    text.className = 'line-text';
    text.textContent = line.text || '♪';
    slide.appendChild(text);
    if (data.synced) {
      // любая строка — перемотка к её началу, без предварительной прокрутки колесом
      slide.addEventListener('click', () => {
        base = { position: line.from, at: performance.now(), playing: base.playing };
        act('seek', line.from + 0.01);
        endLyricsScroll();
      });
    }
    return slide;
  });
  const footer = document.createElement('div');
  footer.className = 'lyrics-slide lyrics-footer';
  footer.textContent = lyricsFooterText(data);
  track.append(counter, ...lines, footer);
  lyricsEl.replaceChildren(track);

  if (!data.synced) {
    lyricsEl.classList.add('is-plain');
    return;
  }
  lyricsView = { track, counter, lines, data, state: null, active: -2, counterKey: null, offset: 0, scrolled: false };
  updateLyrics(currentPosition(), true);
}

function lyricsState(pos, lines) {
  const first = lines[0].from;
  const end = lines[lines.length - 1].to;
  if (pos < first) return first - pos <= PREPARE_SEC ? 'prepare' : 'intro';
  if (pos > end) return 'outro';
  return 'playing';
}

function renderCounter(view, stateName, pos) {
  const first = view.data.lines[0].from;
  const key = stateName === 'prepare' ? `n${Math.ceil(first - pos)}` : stateName === 'intro' ? 'dots' : '';
  if (key === view.counterKey) return;
  view.counterKey = key;
  if (key === 'dots') {
    const dots = Array.from({ length: 4 }, (_, i) => {
      const dot = document.createElement('i');
      dot.className = 'lyrics-dot';
      dot.style.animationDelay = `${(i + 1) * 0.275}s`;
      return dot;
    });
    view.counter.replaceChildren(...dots);
  } else if (key) {
    const number = document.createElement('span');
    number.className = 'line-text lyrics-countdown';
    number.textContent = key.slice(1);
    view.counter.replaceChildren(number);
  } else {
    view.counter.replaceChildren();
  }
}

function lyricsTarget(view) {
  if (view.state === 'playing') return view.active + 1;
  if (view.state === 'outro') return view.data.lines.length;
  return 0;
}

// Сдвиг ленты, при котором середина слайда стоит посередине панели: текущая строка всегда в центре.
// Для первых строк сдвиг отрицательный — лента опускается, сверху остаётся пустое место.
function centerOffset(view, index) {
  const slides = view.track.children;
  const target = slides[Math.min(index, slides.length - 1)];
  return target.offsetTop + target.offsetHeight / 2 - lyricsEl.clientHeight / 2;
}

function slideTo(view, index, instant) {
  view.offset = centerOffset(view, index);
  view.track.classList.toggle('is-instant', Boolean(instant));
  view.track.style.transform = `translateY(${-view.offset}px)`;
}

function updateLyrics(pos, force) {
  const view = lyricsView;
  if (!view || ui.panel !== 'lyrics') return;
  const lines = view.data.lines;
  const nextState = lyricsState(pos, lines);
  let active = -1;
  if (nextState === 'playing') for (let i = 0; i < lines.length && lines[i].from <= pos; i++) active = i;
  renderCounter(view, nextState, pos);
  if (!force && nextState === view.state && active === view.active) return;
  view.state = nextState;
  view.active = active;
  if (view.scrolled) return;
  applyLyricsClasses(view);
  slideTo(view, lyricsTarget(view), force);
}

function applyLyricsClasses(view) {
  lyricsEl.dataset.state = view.scrolled ? '' : view.state;
  lyricsEl.classList.toggle('is-scrolled', view.scrolled);
  view.lines.forEach((el, i) => el.classList.toggle('is-active', !view.scrolled && i === view.active));
}

// Ручная прокрутка колесом (freeMode в оригинале)
let lyricsScrollTimer = null;
function endLyricsScroll() {
  clearTimeout(lyricsScrollTimer);
  const view = lyricsView;
  if (!view) return;
  view.scrolled = false;
  updateLyrics(currentPosition(), false);
  applyLyricsClasses(view);
  slideTo(view, lyricsTarget(view));
}
lyricsEl.addEventListener('wheel', (e) => {
  const view = lyricsView;
  if (!view) return;
  view.scrolled = true;
  applyLyricsClasses(view);
  // прокрутка — от первого до последнего слайда в центре панели
  view.offset = Math.min(centerOffset(view, Infinity), Math.max(centerOffset(view, 0), view.offset + e.deltaY));
  view.track.classList.add('is-instant');
  view.track.style.transform = `translateY(${-view.offset}px)`;
  clearTimeout(lyricsScrollTimer);
  lyricsScrollTimer = setTimeout(endLyricsScroll, LYRICS_IDLE_MS);
}, { passive: true });

// Ширина панели меняется вместе с окном — пересчитываем положение ленты без анимации.
new ResizeObserver(() => {
  if (lyricsView && !lyricsView.scrolled && lyricsView.state) slideTo(lyricsView, lyricsTarget(lyricsView), true);
}).observe(lyricsEl);

// ---------- круг таймлайна полосы за краем окна ----------
// Линия прижата к нижнему краю окна, и круг по её центру выходит за окно на 4 px. Рисовать за пределами
// своего окна виджет не может, поэтому сообщает круг окну ореола: оно лежит под виджетом и шире его,
// рисует такой же круг в той же точке экрана, и снаружи видна как раз недостающая часть.
let thumbOverflowKey = '';
function sendThumbOverflow() {
  let data = null;
  if (ui.mode === 'bar' && (barTimeline.matches(':hover') || barTimeline.classList.contains('is-seeking'))) {
    const thumb = barTimeline.querySelector('.timeline-thumb');
    const r = thumb.getBoundingClientRect();
    if (r.width > 0 && r.bottom > innerHeight) {
      data = {
        x: Math.round((r.left + r.right) * 5) / 10,
        y: Math.round((r.top + r.bottom) * 5) / 10,
        size: Math.round(r.width * 10) / 10,
        color: getComputedStyle(thumb).backgroundColor,
      };
    }
  }
  const key = JSON.stringify(data);
  if (key === thumbOverflowKey) return;
  thumbOverflowKey = key;
  window.widget.thumbOverflow(data);
}

// ---------- кадр: таймлайн, время, активная строка ----------
// Элементы и последние значения кэшируем: DOM трогаем, только когда что-то действительно изменилось.
const frameEls = {
  progress: [...$$('[data-bind="progress"]')],
  thumb: [...$$('[data-bind="thumb"]')],
  pos: [...$$('[data-bind="pos"]')],
  dur: [...$$('[data-bind="dur"]')],
};
const frameLast = { percent: '', pos: '', dur: '' };

// Страница виджета никогда не считается скрытой (backgroundThrottling: false в main), поэтому
// цикл кадров останавливаем сами, пока окно скрыто или свёрнуто, и запускаем снова при показе.
let shown = true;
let frameRunning = false;
function startFrames() {
  if (frameRunning || !shown) return;
  frameRunning = true;
  requestAnimationFrame(frame);
}

function frame() {
  if (!shown) {
    frameRunning = false;
    return;
  }
  if (state?.track && app.dataset.status === 'ready') {
    const pos = currentPosition();
    const ratio = state.duration ? Math.min(1, pos / state.duration) : 0;
    const percent = `${Math.round(ratio * 10000) / 100}%`;
    if (percent !== frameLast.percent) {
      frameLast.percent = percent;
      frameEls.progress.forEach((el) => { el.style.width = percent; });
      frameEls.thumb.forEach((el) => { el.style.left = percent; });
      viewBar.style.setProperty('--track-progress', percent);
    }
    const posText = formatTime(pos);
    if (posText !== frameLast.pos) {
      frameLast.pos = posText;
      frameEls.pos.forEach((el) => { el.textContent = posText; });
    }
    const durText = formatTime(state.duration);
    if (durText !== frameLast.dur) {
      frameLast.dur = durText;
      frameEls.dur.forEach((el) => { el.textContent = durText; });
    }
    updateLyrics(pos);
  }
  sendThumbOverflow();
  requestAnimationFrame(frame);
}

// ---------- видеообложка ----------
// У части треков вместо картинки есть короткое вертикальное видео по кругу (как в мобильном приложении).
// Крутится, только пока играет музыка, виджет виден и открыт большой режим; иначе стоит на кадре.
// Пока видео не пошло (грузится, ошибка, его нет) — видна обычная обложка.
const artVideo = document.querySelector('.art-video');
artVideo.addEventListener('playing', () => artVideo.classList.add('is-ready'));
artVideo.addEventListener('error', () => artVideo.classList.remove('is-ready'));

function syncVideo() {
  const url = (ui.videoCovers && state?.ready && state.track?.video) || null;
  if ((artVideo.dataset.src || null) !== url) {
    artVideo.classList.remove('is-ready');
    if (url) {
      artVideo.dataset.src = url;
      artVideo.src = url;
    } else {
      delete artVideo.dataset.src;
      artVideo.removeAttribute('src');
      artVideo.load(); // сбрасывает загруженное видео и освобождает декодер
    }
  }
  if (url && shown && ui.mode === 'art' && base.playing) artVideo.play().catch(() => {});
  else artVideo.pause();
}

// ---------- быстрое переключение ----------
// Яндекс Музыка сдвигает очередь сразу, а новый трек показывает, только когда он загрузится; на медленной
// сети или при частых нажатиях это секунды. Поэтому по «следующему» виджет сразу показывает следующий
// трек из очереди и ждёт, пока плеер его догонит. Не догнал за SKIP_HOLD_MS — показываем, как есть.
// «Предыдущий» так не предугадать: после первых секунд трека он перематывает в начало текущего.
const SKIP_HOLD_MS = 5000;
let rawState = null; // последнее состояние от Яндекс Музыки, без предугаданного трека
let skipTo = null; // { index, until }

function skipNext() {
  if (!rawState?.ready || !rawState.canNext) return;
  const q = rawState.queue;
  const item = q.items.find((i) => i.index === (skipTo ? skipTo.index : q.index) + 1);
  act('next');
  if (!item) return;
  skipTo = { index: item.index, until: performance.now() + SKIP_HOLD_MS };
  clearTimeout(skipNext.timer);
  skipNext.timer = setTimeout(() => rawState && applyState(rawState), SKIP_HOLD_MS + 50);
  applyState(rawState);
}

// Состояние с предугаданным треком, пока плеер не дошёл до него; иначе — как есть.
function withSkip(next) {
  if (!skipTo) return next;
  const item = next.ready && next.queue && next.queue.index < skipTo.index && performance.now() < skipTo.until
    && next.queue.items.find((i) => i.index === skipTo.index);
  if (!item) {
    skipTo = null;
    return next;
  }
  const { index, ...track } = item;
  return { ...next, track, position: 0, duration: track.durationSec, loading: true, canPrev: true, queue: { ...next.queue, index } };
}

// ---------- события из main ----------
function applyState(raw) {
  rawState = raw;
  const next = withSkip(raw);
  const trackChanged = next.track?.id !== state?.track?.id;
  state = next;
  if (!state.ready) return renderStatus();
  document.body.classList.toggle('ym-light-theme', state.theme === 'light');
  document.body.classList.toggle('ym-dark-theme', state.theme !== 'light');
  base = { position: state.position, at: performance.now(), playing: state.playing };
  app.classList.toggle('is-loading', Boolean(state.loading));
  syncVolume(state.volume);
  renderStatus();
  renderTrack();
  renderControls();
  renderQueue();
  syncVideo();
  if (trackChanged) loadLyrics();
}

async function loadSprite() {
  const svg = await (await fetch('ymw://ym/icons/sprite.svg')).text();
  document.getElementById('sprite').innerHTML = svg;
}

(async () => {
  await loadSprite();
  const init = await window.widget.init();
  Object.assign(ui, init.settings, { status: init.status });
  renderLayout();
  if (init.state) applyState(init.state);
  renderStatus();

  window.widget.onState(applyState);
  window.widget.onPosition(({ position, playing }) => {
    if (skipTo) return; // позиция ещё прежнего трека
    base = { position, at: performance.now(), playing };
    syncVideo();
  });
  window.widget.onStatus((status) => { ui.status = status; renderStatus(); });
  window.widget.onLayout(({ mode, panel }) => { ui.mode = mode; ui.panel = panel; renderLayout(); syncVideo(); });
  window.widget.onVideoCovers((enabled) => { ui.videoCovers = enabled; syncVideo(); });
  window.widget.onPinned((pinned) => { ui.pinned = pinned; renderLayout(); });
  window.widget.onGlow((glow) => { ui.glow = glow; renderLayout(); });
  window.widget.onPopSet(({ kind, value }) => levels[kind]?.set(value));
  // пока открыт слайдер, курсор над его окном — виджет всё равно показывает кнопки, как под курсором
  window.widget.onPopping((active) => app.classList.toggle('is-popping', active));
  window.widget.onShown((value) => {
    shown = value;
    syncVideo();
    if (shown) {
      frameLast.percent = frameLast.pos = frameLast.dur = ''; // после показа перерисовать всё
      startFrames();
    }
  });
  startFrames();
})();
