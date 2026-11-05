// Статус «Слушает Яндекс Музыка» в Discord, как у Spotify: трек, исполнитель, обложка и полоса времени.
// Discord принимает статус от локальных программ через именованный канал \\?\pipe\discord-ipc-N:
// кадр — код операции и длина (по 4 байта, little-endian), затем JSON.
// Название в строке «Слушает …» — это имя приложения в Discord Developer Portal с CLIENT_ID.
// Кнопок нет: статус с buttons клиент показывает у себя, но сервер Discord его отбрасывает —
// друзья и веб-версия его не видят.
const net = require('net');
const { randomUUID } = require('crypto');

// Application ID не секрет: Discord показывает его всем. Переменная окружения — для проверок.
const CLIENT_ID = process.env.YMW_DISCORD_CLIENT_ID || '1567225446163292170';
const RETRY_MS = 15000;
const UPDATE_DEBOUNCE_MS = 1000; // Discord разрешает около 5 обновлений статуса за 20 с
const DRIFT_SEC = 3; // на сколько позиция может разойтись с полосой в Discord до пересылки статуса
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const ActivityType = { LISTENING: 2 };

let enabled = false;
let socket = null;
let ready = false;
let retryTimer = null;
let updateTimer = null;
let state = null; // последний снимок плеера
let sentKey = ''; // что уже показано в Discord: трек, пауза
let sentStart = 0; // начало трека по часам, с которым отправлена полоса времени

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function connect(index = 0) {
  if (!enabled || !CLIENT_ID || socket) return;
  if (index > 9) return scheduleRetry();
  const sock = net.createConnection(`\\\\?\\pipe\\discord-ipc-${index}`);
  let buffer = Buffer.alloc(0);
  sock.once('connect', () => {
    socket = sock;
    sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
  });
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const length = buffer.readInt32LE(4);
      if (buffer.length < 8 + length) break;
      let message = null;
      try { message = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8')); } catch { /* битый кадр пропускаем */ }
      buffer = buffer.subarray(8 + length);
      onMessage(op, message);
    }
  });
  sock.on('error', () => {
    // канала с таким номером нет — пробуем следующий; Discord не запущен — повторим позже
    if (socket !== sock) connect(index + 1);
  });
  sock.on('close', () => {
    if (socket !== sock) return;
    socket = null;
    ready = false;
    sentKey = '';
    scheduleRetry();
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (enabled) retryTimer = setTimeout(() => connect(0), RETRY_MS);
}

function onMessage(op, message) {
  if (op === OP.PING) return socket?.write(encode(OP.PONG, message));
  if (op === OP.CLOSE) return socket?.destroy();
  if (op === OP.FRAME && message?.evt === 'READY') {
    ready = true;
    sentKey = '';
    scheduleUpdate(0);
  }
}

function send(activity) {
  if (!socket || !ready) return;
  socket.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: randomUUID() }));
}

// Текстовые поля Discord: от 2 до 128 символов после обрезки пробелов. Короткое значение дополняем
// невидимым символом U+2800: обычный пробел сервер обрезает, и поле снова становится слишком коротким.
// Обрезаем по целым символам, чтобы не разорвать суррогатную пару (эмодзи, редкие буквы).
const PAD = '\u2800';
function field(text, max = 128) {
  const value = String(text || '').trim();
  if (!value) return undefined;
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.length < 2 ? out + PAD : out;
}

const isHttpsUrl = (url, max) => typeof url === 'string' && url.length <= max && /^https:\/\/[^\s]+$/.test(url);

function activityFor(s) {
  const t = s.track;
  const start = Math.round(Date.now() - (s.position || 0) * 1000);
  const end = Math.round(start + (s.duration || t.durationSec || 0) * 1000);
  const activity = {
    type: ActivityType.LISTENING,
    details: field(t.title + (t.version ? ` (${t.version})` : '')),
    state: field(t.artists.map((a) => a.name).join(', ')) || field('Неизвестный исполнитель'),
    // в протоколе RPC отметки времени — миллисекунды Unix; конец только если он позже начала
    timestamps: end > start ? { start, end } : { start },
  };
  if (isHttpsUrl(t.cover, 256)) {
    // внешняя ссылка, а не ключ из Art Assets: клиент сам регистрирует её через API Discord
    activity.assets = { large_image: t.cover.replace('600x600', '400x400') };
    const text = field(t.albumTitle) || field(t.title);
    if (text) activity.assets.large_text = text;
  }
  return { activity, start };
}

function update() {
  const s = state;
  const playing = Boolean(enabled && s?.ready && s.track && s.playing);
  if (!playing) {
    // на паузе и без трека статус убираем, как Spotify
    if (sentKey !== 'none') {
      send(null);
      sentKey = 'none';
    }
    return;
  }
  const key = `${s.track.id}|playing`;
  const expectedStart = Date.now() - (s.position || 0) * 1000;
  if (key === sentKey && Math.abs(expectedStart - sentStart) < DRIFT_SEC * 1000) return;
  const { activity, start } = activityFor(s);
  send(activity);
  sentKey = key;
  sentStart = start;
}

function scheduleUpdate(delay = UPDATE_DEBOUNCE_MS) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(update, delay);
}

// Полный снимок состояния плеера (из bridge, тип state).
function onPlayerState(next) {
  state = next;
  scheduleUpdate();
}

// Позиция раз в секунду: при перемотке полоса времени в Discord пересчитывается.
function onPosition({ position, playing }) {
  if (!state) return;
  state = { ...state, position, playing };
  const expectedStart = Date.now() - position * 1000;
  if (playing && sentKey && Math.abs(expectedStart - sentStart) >= DRIFT_SEC * 1000) scheduleUpdate();
}

function setEnabled(value) {
  enabled = Boolean(value) && Boolean(CLIENT_ID);
  if (enabled) {
    connect(0);
  } else {
    clearTimeout(retryTimer);
    if (socket) {
      send(null);
      socket.end();
      socket = null;
    }
    ready = false;
    sentKey = '';
  }
}

const configured = () => Boolean(CLIENT_ID);

module.exports = { setEnabled, onPlayerState, onPosition, configured };
