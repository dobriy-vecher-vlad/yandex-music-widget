// Установленное приложение Яндекс Музыки: путь, процессы, перезапуск с отладочным портом,
// чтение ресурсов из его app.asar (Electron читает файлы внутри .asar как обычную папку).
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'YandexMusic');
const EXE_NAME = 'Яндекс Музыка.exe';
const EXE_PATH = path.join(INSTALL_DIR, EXE_NAME);
const ASAR_APP_DIR = path.join(INSTALL_DIR, 'resources', 'app.asar', 'app');

function isInstalled() {
  return fs.existsSync(EXE_PATH);
}

function isRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }, (err, out) => {
      resolve(!err && out.includes(EXE_NAME));
    });
  });
}

// Запущена ли Яндекс Музыка с отладочным портом: в первые секунды после запуска порт ещё закрыт,
// и отличить её от запущенной без порта можно только по командной строке процесса.
function hasPortFlag(port) {
  const script = `(Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'").CommandLine -join "\\n"`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }, (err, out) => {
      resolve(!err && out.includes(`--remote-debugging-port=${port}`));
    });
  });
}

function kill() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', EXE_NAME, '/F'], () => resolve());
  });
}

// Порт слушает только 127.0.0.1. --remote-allow-origins не передаём, поэтому веб-страницы
// из браузера к нему подключиться не смогут — только локальные процессы.
function launch(port) {
  const child = spawn(EXE_PATH, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function relaunch(port) {
  await kill();
  for (let i = 0; i < 20 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 150));
  launch(port);
}

// Обычный запуск exe второй раз просто разворачивает уже открытое окно (single instance).
function focus() {
  spawn(EXE_PATH, [], { detached: true, stdio: 'ignore' }).unref();
}

// --- ярлыки Яндекс Музыки ---
// Чтобы Яндекс Музыка, открытая своим ярлыком («Пуск», рабочий стол, закреп на панели задач), сразу
// была доступна виджету, в ярлыки дописываем отладочный порт. Цель ярлыка не меняем — закреп на панели
// задач остаётся тем же значком, что и окно приложения. Обновление Яндекс Музыки может пересоздать
// ярлыки, поэтому виджет проверяет их при каждом запуске.
const shortcutDirs = (app) => [
  path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch'), // и закрепы панели задач
  app.getPath('desktop'),
];

function findShortcuts(dir, depth = 0, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) findShortcuts(full, depth + 1, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) out.push(full);
  }
  return out;
}

// enabled — дописать порт в ярлыки Яндекс Музыки, иначе убрать. Возвращает изменённые ярлыки.
function patchShortcuts(port, enabled) {
  const { app, shell } = require('electron');
  const flag = `--remote-debugging-port=${port}`;
  const changed = [];
  for (const file of [...new Set(shortcutDirs(app).flatMap((d) => findShortcuts(d)))]) {
    let link;
    try { link = shell.readShortcutLink(file); } catch { continue; }
    if (path.normalize(link.target || '').toLowerCase() !== EXE_PATH.toLowerCase()) continue;
    const args = (link.args || '').split(/\s+/).filter((a) => a && !a.startsWith('--remote-debugging-port='));
    if (enabled) args.push(flag);
    const next = args.join(' ');
    if (next === (link.args || '')) continue;
    if (shell.writeShortcutLink(file, 'update', { args: next })) changed.push(file);
  }
  return changed;
}

function assetPath(relative) {
  const resolved = path.normalize(path.join(ASAR_APP_DIR, relative));
  if (!resolved.startsWith(ASAR_APP_DIR)) return null;
  return resolved;
}

// Токены дизайн-системы берём прямо из CSS установленной версии приложения.
function extractTokens() {
  const cssDir = path.join(ASAR_APP_DIR, '_next', 'static', 'css');
  const blocks = new Set();
  const tokenBlock = /(?:^|})\s*((?::root|\.ym-(?:dark|light)-theme|\.ym-font-music)\s*\{[^{}]*--ym-[^{}]*\})/g;
  for (const file of fs.readdirSync(cssDir)) {
    if (!file.endsWith('.css')) continue;
    const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
    for (const m of css.matchAll(tokenBlock)) blocks.add(m[1]);
  }
  return [...blocks].join('\n');
}

module.exports = { EXE_PATH, isInstalled, isRunning, hasPortFlag, launch, relaunch, focus, patchShortcuts, assetPath, extractTokens };
