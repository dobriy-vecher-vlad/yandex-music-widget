const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  x: null,
  y: null,
  mode: 'art', // art — квадратная обложка, bar — горизонтальная полоса
  panel: null, // null | 'queue' | 'lyrics' — раскрытая панель под обложкой
  pinned: true,
  taskbar: false, // кнопка виджета на панели задач (включается в меню трея)
  lyricsOnline: true, // искать текст в LRCLIB, если в Яндекс Музыке его нет
  discord: true, // статус «Слушает Яндекс Музыка» в Discord
  glow: true, // свечение цветами обложки, пульсирующее под бит
  glowLevel: 0.67, // яркость ореола 0..1; 0.67 — исходная яркость, 1 — в полтора раза ярче
  videoCovers: true, // видеообложки треков вместо картинки в большом режиме
  // запуск вместе с Яндекс Музыкой: виджет ждёт её в фоне с входа в Windows и показывается, когда она
  // открыта, а в её ярлыки дописан порт для виджета (см. linkWithYM в main.js)
  linked: true,
  dims: {}, // artWidth, panelHeight, barWidth — пределы и значения по умолчанию в geometry.js
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

// Повреждённый или чужой файл не должен ломать запуск: неизвестные значения заменяем значениями по умолчанию.
function sanitize(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['art', 'bar'].includes(s.mode)) s.mode = DEFAULTS.mode;
  if (![null, 'queue', 'lyrics'].includes(s.panel)) s.panel = null;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) { s.x = null; s.y = null; }
  for (const key of ['pinned', 'taskbar', 'lyricsOnline', 'discord', 'glow', 'videoCovers', 'linked']) s[key] = typeof s[key] === 'boolean' ? s[key] : DEFAULTS[key];
  s.glowLevel = Number.isFinite(s.glowLevel) ? Math.min(1, Math.max(0, s.glowLevel)) : DEFAULTS.glowLevel;
  if (!s.dims || typeof s.dims !== 'object') s.dims = {};
  return s;
}

function load() {
  try {
    // файл, сохранённый Блокнотом или PowerShell, может начинаться с BOM
    return sanitize(JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, '')));
  } catch {
    return sanitize(null);
  }
}

let saveTimer = null;
let pending = null;

// Пишем во временный файл и переименовываем: обрыв на середине записи не оставит битый settings.json.
function write() {
  clearTimeout(saveTimer);
  if (!pending) return;
  const data = JSON.stringify(pending, null, 2);
  pending = null;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file() + '.tmp', data);
    fs.renameSync(file() + '.tmp', file());
  } catch (e) {
    console.warn('settings: не удалось сохранить', e.message);
  }
}

function save(settings) {
  pending = settings;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 300);
}

module.exports = { load, save, flush: write };
