// Связь с запущенной Яндекс Музыкой по Chrome DevTools Protocol.
// Находит страницу приложения, внедряет adapter.page.js и транслирует его события.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ADAPTER_SOURCE = fs.readFileSync(path.join(__dirname, 'adapter.page.js'), 'utf8');
const BINDING = '__ymwPush';
const RECONNECT_MS = 2000;
const PING_MS = 3000; // адаптер считает виджет закрытым, если пинга нет 10 с
// Закрытую принудительно Яндекс Музыку соединение может замечать секунды; без ответа на пинг столько — разрыв.
const PONG_TIMEOUT_MS = 5000;

class Bridge extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connected = false;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect().catch((e) => this.emit('log', 'connect failed: ' + e.stack));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }

  async isPortOpen() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async findPage() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const targets = await res.json();
    return targets.find((t) => t.type === 'page' && t.url.startsWith('music-application://'));
  }

  async connect() {
    if (this.stopped) return;
    let page;
    try {
      page = await this.findPage();
    } catch {
      page = null;
    }
    if (!page) {
      this.setConnected(false);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws = ws;
    // Не удалось подготовить страницу — закрываем соединение, onclose запустит повторную попытку.
    ws.onopen = () => this.onOpen().catch((e) => {
      this.emit('log', 'inject failed: ' + e.message);
      ws.close();
    });
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => this.drop(ws);
    ws.onerror = (e) => this.emit('log', 'ws error: ' + (e.message || e.type));
  }

  // Соединение потеряно: отклоняем ждущие ответы и переподключаемся.
  drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.pingTimer);
    for (const { reject } of this.pending.values()) reject(new Error('CDP соединение закрыто'));
    this.pending.clear();
    this.setConnected(false);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), RECONNECT_MS);
  }

  async onOpen() {
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Runtime.addBinding', { name: BINDING });
    // Переживает перезагрузки страницы; адаптер сам дождётся появления React-дерева.
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `setTimeout(() => {${ADAPTER_SOURCE}}, 3000)` });
    await this.inject();
    clearInterval(this.pingTimer);
    const ws = this.ws;
    let lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
        this.emit('log', 'нет ответа на пинг — соединение потеряно');
        this.drop(ws);
        try { ws.close(); } catch { /* уже закрыто */ }
        return;
      }
      this.send('Runtime.evaluate', { expression: 'window.__ymw && window.__ymw.ping()' }).then(() => { lastPong = Date.now(); }, () => {});
    }, PING_MS);
    this.setConnected(true);
  }

  inject() {
    // Адаптер мог остаться на странице от прошлого запуска виджета — просим заново прислать полный снимок.
    return this.send('Runtime.evaluate', { expression: `${ADAPTER_SOURCE}\n;window.__ymw && window.__ymw.resync();` });
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('connection', value);
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === BINDING) {
      try {
        this.emit('message', JSON.parse(msg.params.payload));
      } catch (e) {
        this.emit('log', 'bad payload: ' + e.message);
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Нет связи с Яндекс Музыкой'));
        return;
      }
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async act(name, args = []) {
    const expression = `window.__ymw.act(${JSON.stringify(name)}, ${JSON.stringify(args)})`;
    let result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails && /__ymw/.test(JSON.stringify(result.exceptionDetails))) {
      // Страница перезагрузилась, а скрипт из addScriptToEvaluateOnNewDocument ещё не отработал.
      await this.inject();
      result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

module.exports = { Bridge };
