// Запасной источник текста песен — LRCLIB (lrclib.net): открытый API без ключа,
// синхронные тексты в формате LRC. Используется, когда в Яндекс Музыке текста нет.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const API = 'https://lrclib.net/api';
const USER_AGENT = `yandex-music-widget/${app.getVersion()} (https://github.com/dobriy-vecher-vlad/yandex-music-widget)`;
const DURATION_TOLERANCE = 3; // сек: насколько длительность версии в LRCLIB может отличаться
const MISS_TTL = 7 * 24 * 3600 * 1000; // «не нашли» перепроверяем через неделю
const CACHE_LIMIT = 1000; // больше записей не храним: самые старые вытесняются

const cacheFile = () => path.join(app.getPath('userData'), 'lyrics-cache.json');
let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const key of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[key];
  }
  fs.writeFile(cacheFile(), JSON.stringify(cache), () => {});
}

// Названия загруженных файлов часто содержат мусор: «(feat. …)», «[Official Video]», «prod. …».
function cleanTitle(title) {
  return title
    .replace(/\s*[([][^)\]]*(feat|ft\.|prod|remaster|official|video|audio|lyrics)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat|ft)\.?\s.+$/i, '')
    .replace(/\s+prod\.?\s.+$/i, '')
    .trim();
}

// «Исполнитель - Название» в поле названия (типично для загруженных mp3).
function splitArtistFromTitle(title, artist) {
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m && (!artist || m[1].toLowerCase().includes(artist.toLowerCase()))) return m[2];
  return title;
}

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ from: Number(s[1]) * 60 + Number(s[2]), text });
  }
  lines.sort((a, b) => a.from - b.from);
  return lines.map((l, i) => ({ ...l, to: lines[i + 1] ? lines[i + 1].from : l.from + 5 }));
}

function toResult(record) {
  if (!record) return null;
  if (record.syncedLyrics) return { source: 'lrclib', synced: true, lines: parseLrc(record.syncedLyrics) };
  if (record.plainLyrics) {
    return { source: 'lrclib', synced: false, lines: record.plainLyrics.split(/\r?\n/).map((text) => ({ text: text.trim() })) };
  }
  return null;
}

async function request(endpoint, params) {
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

// Точное совпадение по названию, исполнителю и длительности; иначе — поиск,
// из которого берём ближайшую по длительности версию (синхронные в приоритете).
async function lookupRemote({ title, artist, album, duration }) {
  const exact = { track_name: title, artist_name: artist, duration: Math.round(duration) };
  if (album) exact.album_name = album;
  const direct = await request('get', exact).catch(() => null);
  if (direct && (direct.syncedLyrics || direct.plainLyrics)) return direct;

  const found = (await request('search', { track_name: title, artist_name: artist })) || [];
  const close = found.filter((r) => !duration || Math.abs(r.duration - duration) <= DURATION_TOLERANCE);
  return close.find((r) => r.syncedLyrics) || close.find((r) => r.plainLyrics) || null;
}

async function lookup({ title, artists, album, duration }) {
  if (!title) return null;
  duration = Number(duration) || 0;
  const artist = (artists && artists[0]) || '';
  const key = `${artist}|${title}|${Math.round(duration)}`.toLowerCase();
  const cached = loadCache()[key];
  if (cached && (cached.result || Date.now() - cached.at < MISS_TTL)) return cached.result;

  const variants = [...new Set([title, cleanTitle(splitArtistFromTitle(title, artist))])];
  let record = null;
  try {
    for (const variant of variants) {
      record = await lookupRemote({ title: variant, artist, album, duration });
      if (record) break;
    }
  } catch {
    return null; // сеть или сервис недоступны — «не нашли» не кешируем
  }
  const result = toResult(record);
  cache[key] = { at: Date.now(), result };
  saveCache();
  return result;
}

module.exports = { lookup };
