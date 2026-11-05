// Внедряется в страницу Яндекс Музыки через CDP. Единственное место, которое знает
// внутреннее устройство приложения: при обновлении Яндекс Музыки правки — только здесь.
// Наружу отдаёт снимки состояния через binding __ymwPush и принимает команды через __ymw.act().
(() => {
  const VERSION = 21;
  if (window.__ymw && window.__ymw.version === VERSION) return;
  if (window.__ymw) window.__ymw.stop();

  const QUEUE_LIMIT = 150;
  const COVER_SIZE = '600x600';
  const THUMB_SIZE = '100x100';

  let rootModel = null;
  let playbackController = null;

  // Корневая MobX-модель и контроллер воспроизведения лежат в value React-контекстов
  // над любым элементом приложения; поднимаемся по fiber-дереву, пока не найдём.
  function findContextValue(predicate) {
    const anchors = ['[data-test-id=PLAYERBAR_DESKTOP]', 'main', 'body > div'];
    for (const selector of anchors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
      for (let fiber = key && el[key]; fiber; fiber = fiber.return) {
        const value = fiber.memoizedProps && fiber.memoizedProps.value;
        if (value && typeof value === 'object' && predicate(value)) return value;
      }
    }
    return null;
  }

  function resolve() {
    if (!rootModel) rootModel = findContextValue((v) => v.isRootModel);
    if (!playbackController) {
      const ctx = findContextValue((v) => 'playbackController' in v);
      playbackController = ctx && ctx.playbackController;
    }
    return Boolean(rootModel && playbackController);
  }

  // До первого запуска трека после старта приложения активного воспроизведения нет.
  const playback = () => playbackController.activePlayback.value;
  const queueState = () => playback().state.queueState;
  const likeStore = () => {
    const current = playback() && queueState().currentEntity.value;
    return current && current.entity.likeStore;
  };

  const coverUrl = (uri, size) => (uri ? 'https://' + uri.replace('%%', size) : null);

  function artistsOf(meta) {
    return (meta.artists || []).map((a) => ({ id: a.id, name: a.name }));
  }

  // Видеообложка, как в мобильном приложении: вертикальное mp4 9:16 по кругу; есть не у всех треков.
  const videoOf = (meta) => (meta && typeof meta.backgroundVideoUri === 'string' && /^https:\/\//.test(meta.backgroundVideoUri) ? meta.backgroundVideoUri : null);

  function trackOf(meta, likes) {
    const albumId = meta.albumId || (meta.albums && meta.albums[0] && meta.albums[0].id) || null;
    return {
      id: String(meta.id),
      albumId,
      albumTitle: (meta.albums && meta.albums[0] && meta.albums[0].title) || null,
      title: meta.title,
      version: meta.version || null,
      artists: artistsOf(meta),
      cover: coverUrl(meta.coverUri, COVER_SIZE),
      thumb: coverUrl(meta.coverUri, THUMB_SIZE),
      video: videoOf(meta),
      averageColor: meta.averageColor || null,
      durationSec: meta.durationMs ? meta.durationMs / 1000 : 0,
      explicit: Boolean(meta.contentWarning === 'explicit' || meta.explicit),
      hasSyncLyrics: Boolean(meta.hasSyncLyrics),
      hasLyrics: Boolean(meta.hasLyrics),
      liked: likes ? likes.isTrackLiked(meta.id) : false,
      disliked: likes ? likes.isTrackDisliked(meta.id) : false,
    };
  }

  function queueSnapshot(likes) {
    if (!playback()) return { index: -1, total: 0, items: [] };
    const qs = queueState();
    const entities = qs.entityList.value;
    const order = qs.order.value;
    const index = qs.index.value;
    const from = Math.max(0, index - 30);
    const to = Math.min(order.length, from + QUEUE_LIMIT);
    const items = [];
    for (let i = from; i < to; i++) {
      const item = entities[order[i]];
      const meta = item && item.entity.data && item.entity.data.meta;
      if (!meta || meta.isHiddenFromSonataQueue) continue;
      items.push({ index: i, ...trackOf(meta, likes) });
    }
    return { index, total: order.length, items };
  }

  function snapshot() {
    if (!resolve()) return { ready: false };
    const s = rootModel.sonataState;
    const meta = s.entityMeta;
    const likes = likeStore();
    return {
      ready: true,
      theme: document.body.classList.contains('ym-light-theme') ? 'light' : 'dark',
      track: meta && meta.id ? withFullMeta(trackOf(meta, likes)) : null,
      status: s.status,
      playing: s.status === 'playing',
      // трек грузится или докачивается: виджет показывает это на кнопке воспроизведения
      loading: s.status === 'loadingMediaSource' || s.status === 'buffering',
      position: s.position || 0,
      duration: s.duration || (meta && meta.durationMs / 1000) || 0,
      volume: s.volume,
      repeat: s.repeatMode,
      shuffle: s.shuffle,
      canNext: s.canMoveForward,
      canPrev: s.canMoveBackward,
      canShuffle: s.canShuffle,
      canRepeat: s.canChangeRepeatMode,
      context: { type: s.contextType, id: s.contextId },
      queue: queueSnapshot(likes),
    };
  }

  // sonataState.entityMeta — урезанная копия данных трека: в ней нет, например, backgroundVideoUri.
  // Полные данные лежат в текущем элементе очереди — берём недостающее оттуда.
  function withFullMeta(track) {
    const current = playback() && queueState().currentEntity.value;
    const full = current && current.entity.data && current.entity.data.meta;
    if (full && String(full.id) === track.id && !track.video) track.video = videoOf(full);
    return track;
  }

  function likeArgs(id, albumId) {
    return { entityId: String(id), albumId, userId: rootModel.user.account.data.uid };
  }

  // Команды приходят из виджета; NaN или undefined в плеер не пропускаем.
  function finite(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('Некорректное значение: ' + value);
    return n;
  }

  const REPEAT_CYCLE = { none: 'context', context: 'one', one: 'none' };

  const actions = {
    toggle: () => playback().togglePause(),
    next: () => playback().moveForward(),
    prev: () => playback().moveBackward(),
    seek: (sec) => playback().setProgress(finite(sec)),
    volume: (v) => playback().setExponentVolume(Math.min(1, Math.max(0, finite(v)))),
    shuffle: () => playback().toggleShuffle(),
    repeat: () => playback().setRepeatMode(REPEAT_CYCLE[rootModel.sonataState.repeatMode] || 'none'),
    playIndex: (i) => playback().setEntityByIndex(i),
    like: (id, albumId) => likeStore().toggleTrackLike(likeArgs(id, albumId)),
    async dislike(id, albumId) {
      await likeStore().toggleTrackDislike(likeArgs(id, albumId));
      // Как в самом приложении: дизлайк текущего трека переключает на следующий.
      const current = rootModel.sonataState.entityMeta;
      if (likeStore().isTrackDisliked(id) && current && String(current.id) === String(id)) {
        await playback().moveForward();
      }
    },
    async lyrics(id) {
      const model = rootModel.fullscreenPlayer.syncLyrics;
      if (String(model.currentTrackId) !== String(id) || !model.isResolved) await model.getData(id);
      if (!model.isResolved || String(model.currentTrackId) !== String(id)) return null;
      return {
        source: 'yandex',
        synced: true,
        trackId: String(id),
        lines: (model.lines || []).map((l) => ({ text: l.text, from: l.fromSec, to: l.toSec })),
        writers: model.writers ? [...model.writers] : [],
      };
    },
  };

  // Полный снимок шлём при любом изменении, кроме позиции; позицию — раз в секунду,
  // либо сразу при перемотке. Виджет сам интерполирует её между тиками.
  let lastKey = '';
  let lastPosAt = 0;
  let lastPos = 0;
  // Виджет пингует адаптер каждые несколько секунд. Если виджет закрыли или он упал, адаптер
  // перестаёт снимать состояние и не нагружает Яндекс Музыку, пока виджет не появится снова.
  const ALIVE_MS = 10000;
  let lastPing = performance.now();
  const alive = () => performance.now() - lastPing < ALIVE_MS;

  function tick() {
    if (!alive()) return;
    let state;
    try {
      state = snapshot();
    } catch (e) {
      rootModel = playbackController = null;
      state = { ready: false, error: String(e && e.message) };
    }
    const { position, ...rest } = state;
    const key = JSON.stringify(rest);
    const now = performance.now();
    const expected = lastPos + (state.playing ? (now - lastPosAt) / 1000 : 0);
    const jumped = Math.abs(expected - (position || 0)) > 1.5;
    if (key !== lastKey || jumped || now - lastPosAt > 1000) {
      const full = key !== lastKey;
      lastKey = key;
      lastPos = position || 0;
      lastPosAt = now;
      window.__ymwPush(JSON.stringify(full ? { type: 'state', state } : { type: 'position', position, playing: state.playing }));
    }
  }

  const timer = setInterval(tick, 200);

  // Свёрнутое приложение на паузе Chromium душит: интервал выше срабатывает раз в минуту.
  // Поэтому после команды снимаем состояние сами — сразу и ещё дважды, пока плеер его применяет;
  // свежие таймеры, запущенные из команды, под минутное ограничение не попадают.
  function followUp() {
    tick();
    for (const ms of [150, 600]) setTimeout(tick, ms);
  }

  // ---------- уровень басов для свечения ----------
  // Сигнал берём с analyserNode графа плеера: источник → эквалайзер → анализатор → выход.
  // Громкость Яндекс Музыка задаёт самому audio-элементу (element.volume), и в граф звук попадает уже
  // тихим: на малой громкости ударов почти не видно, на нуле их нет вовсе. Поэтому, пока свечение
  // включено, громкость переносим в граф: элемент играет на полной громкости, а то же значение применяет
  // наш GainNode между анализатором и выходом. Плеер читает и пишет element.volume как раньше — это
  // свойство у элемента подменено, — слышно ровно то же, а анализатор видит звук до громкости.
  // element.captureStream() не годится: в этой версии Chromium копия звука элемента, подключённого
  // к WebAudio, замолкает через секунду после подключения.
  // Свечение в три слоя, 60 замеров в секунду (окно FFT 1024 ≈ 23 мс):
  //   beat  — бочка и другие удары внизу (40–170 Гц): вспышка всего ореола на полную силу;
  //   snap  — малый барабан, хлопки, тарелки (1–11 кГц): лёгкое мерцание контура;
  //   voice — голос и мелодия (250–3000 Гц): медленное «дыхание» части пятен, пока кто-то поёт.
  // Отдельных дорожек в треке нет — только общий звук. Поэтому каждый замер делим на ударную и тональную
  // части по форме звука: удар короткий и широкий (на спектрограмме — вертикальная черта), голос и
  // мелодия длинные и узкие (горизонтальные полосы). Для каждой частоты сравниваем медиану по соседним
  // частотам в этом замере (ударное) с медианой той же частоты за последние ~150 мс (тональное)
  // и делим энергию между ними в этой пропорции. Так длинный бас 808 уходит в тональную часть и не
  // заглушает удары бочки поверх него.
  // Удары — по доле ударной части в басе (beat) и по сумме роста полос с прошлого
  // замера с плавающим порогом (snap). Голос — уровень тональной части между её недавним минимумом и
  // максимумом. В децибелах выбросы не ломают масштаб.
  const METER_HZ = 60;
  const FFT = 1024;
  const TOP_HZ = 11000;
  const KICK = [40, 170];
  const SNAP = [1000, 11000];
  const VOICE = [250, 3000];
  const TIME_FRAMES = 9; // окно медианы по времени, ~150 мс
  const FREQ_BINS = 4; // полуширина медианы по частоте, ±4 полосы
  const SHARE_DB = [-8, -3]; // ударная часть баса на 8 дБ тише всего баса — удар начинается, на 3 дБ — полная вспышка
  const FLOOR_DB = -90; // тише — не считаем: в шуме у тишины нет ударов
  const DECAY = { beat: 0.85, snap: 0.72 }; // спад вспышки за замер: удар бочки ~0,4 с, мерцание ~0,15 с
  const SILENCE_DB = -70; // тише — считаем тишиной: ударов нет
  let audioModel = null;
  const meter = { timer: null, graph: null, tap: null, data: null, silent: 0 };
  const layers = () => ({ bassPeak: null, beat: 0, snap: 0, voice: 0, prevSnap: null, snapMean: 0, snapPeak: 1, voiceLo: null, voiceHi: null, hist: [], frames: 0 });
  let state = layers();

  // --- громкость в графе ---
  const VOLUME = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const nodeConnect = AudioNode.prototype.connect;
  const nodeDisconnect = AudioNode.prototype.disconnect;
  const hooks = new Map(); // граф → { el, an, gain, ctx }

  function hookGraph(g) {
    if (hooks.has(g)) return;
    const el = g.audioElement || (g.sourceNode && g.sourceNode.mediaElement);
    const an = g.analyserNode;
    const ctx = g.context;
    if (!el || !an || !ctx || Object.hasOwn(el, 'volume')) return;
    const gain = ctx.createGain();
    let volume = VOLUME.get.call(el);
    gain.gain.value = volume;
    nodeConnect.call(gain, ctx.destination);
    try {
      nodeDisconnect.call(an, ctx.destination);
    } catch (e) {
      // анализатор не выводит звук напрямую — граф устроен иначе, чем мы ждём; ничего не трогаем
      nodeDisconnect.call(gain);
      return;
    }
    nodeConnect.call(an, gain);
    // Плеер может пересобрать граф (connectNodes, эквалайзер): его подключение анализатора к выходу
    // уводим в наш GainNode, иначе звук пошёл бы мимо громкости.
    const route = (node) => (node === ctx.destination ? gain : node);
    an.connect = function (node, ...rest) { return nodeConnect.call(this, route(node), ...rest); };
    an.disconnect = function (node, ...rest) { return node === undefined ? nodeDisconnect.call(this) : nodeDisconnect.call(this, route(node), ...rest); };
    Object.defineProperty(el, 'volume', {
      configurable: true,
      get: () => volume,
      set(v) {
        if (!(v >= 0 && v <= 1)) return VOLUME.set.call(el, v); // та же ошибка, что у настоящего свойства
        volume = v;
        gain.gain.value = v;
      },
    });
    VOLUME.set.call(el, 1);
    hooks.set(g, { el, an, gain, ctx });
  }

  function unhookGraph(g) {
    const h = hooks.get(g);
    hooks.delete(g);
    const volume = h.el.volume;
    delete h.an.connect;
    delete h.an.disconnect;
    delete h.el.volume;
    try { h.an.disconnect(h.gain); h.an.connect(h.ctx.destination); } catch (e) { /* граф уже разобран плеером */ }
    VOLUME.set.call(h.el, volume);
    h.gain.disconnect();
  }

  // Все графы плееров (их два: текущий и следующий для кроссфейда) — под нашу громкость.
  function hookAll() {
    const graphs = (audioModel && audioModel.analyser.graphs) || [];
    for (const g of graphs) hookGraph(g);
    for (const g of [...hooks.keys()]) if (!graphs.includes(g)) unhookGraph(g);
  }

  function unhookAll() {
    for (const g of [...hooks.keys()]) unhookGraph(g);
  }

  function detachMeter() {
    if (meter.tap && meter.graph) {
      try { nodeDisconnect.call(meter.graph.analyserNode, meter.tap); } catch (e) { /* узел уже отключён плеером */ }
    }
    meter.graph = meter.tap = null;
  }

  function attachMeter(graph) {
    detachMeter();
    const tap = graph.context.createAnalyser();
    tap.fftSize = FFT;
    tap.smoothingTimeConstant = 0; // сглаживание размазывает удар по замерам — гасим сами (DECAY)
    nodeConnect.call(graph.analyserNode, tap);
    const hz = graph.context.sampleRate / FFT;
    const top = Math.min(tap.frequencyBinCount - 1, Math.ceil(TOP_HZ / hz));
    const bins = ([lo, hi]) => [Math.max(1, Math.floor(lo / hz)), Math.min(top, Math.ceil(hi / hz))];
    Object.assign(meter, {
      graph, tap, top, silent: 0,
      data: new Float32Array(tap.frequencyBinCount),
      mag: new Float32Array(top + 1),
      perc: new Float32Array(top + 1),
      harm: new Float32Array(top + 1),
      scratch: new Float32Array(Math.max(TIME_FRAMES, FREQ_BINS * 2 + 1)),
      kick: bins(KICK), snap: bins(SNAP), voice: bins(VOICE),
    });
    state.hist = Array.from({ length: TIME_FRAMES }, () => new Float32Array(top + 1));
    state.frames = 0;
    state.prevSnap = null;
  }

  // медиана первых n значений scratch (сортировка вставками: значений не больше девяти)
  function median(buf, n) {
    for (let i = 1; i < n; i++) {
      const x = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > x) { buf[j + 1] = buf[j]; j--; }
      buf[j + 1] = x;
    }
    return buf[n >> 1];
  }

  // Делит текущий замер на ударную (perc) и тональную (harm) части, см. описание слоёв выше.
  function separate() {
    const { data, mag, perc, harm, scratch, top } = meter;
    for (let i = 1; i <= top; i++) mag[i] = Math.pow(10, Math.max(data[i], FLOOR_DB) / 20);
    state.hist[state.frames % TIME_FRAMES].set(mag);
    state.frames++;
    const n = Math.min(state.frames, TIME_FRAMES);
    for (let i = 1; i <= top; i++) {
      for (let k = 0; k < n; k++) scratch[k] = state.hist[k][i];
      const h = median(scratch, n);
      const lo = Math.max(1, i - FREQ_BINS), hi = Math.min(top, i + FREQ_BINS);
      for (let k = lo; k <= hi; k++) scratch[k - lo] = mag[k];
      const p = median(scratch, hi - lo + 1);
      const share = (p * p) / (p * p + h * h + 1e-20);
      perc[i] = mag[i] * share;
      harm[i] = mag[i] * (1 - share);
    }
  }

  const bandDb = (arr, [lo, hi]) => {
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += arr[i];
    return 20 * Math.log10(Math.max(sum / (hi - lo + 1), 1e-6));
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Бочка: какая доля баса сейчас ударная. На ударе ударная часть почти равна всему басу, между
  // ударами она на 10–15 дБ тише тянущегося баса. Рост самой ударной части не годился: от замера к
  // замеру она дрожит на ±5 дБ. Тихий бас (ниже недавнего максимума на 18+ дБ) вспышек не даёт.
  function beatHit(percDb, allDb) {
    if (allDb <= SILENCE_DB) return 0;
    state.bassPeak = Math.max(allDb, (state.bassPeak ?? allDb) - 0.02);
    const share = Math.pow(clamp01((percDb - allDb - SHARE_DB[0]) / (SHARE_DB[1] - SHARE_DB[0])), 1.3);
    return share * clamp01((allDb - state.bassPeak + 18) / 8);
  }

  // хлопки и тарелки: средний рост ударной части наверху в дБ; порог плавает выше местного среднего,
  // масштаб задаёт самый сильный всплеск за последние секунды
  function snapHit() {
    const [lo, hi] = meter.snap;
    const first = !state.prevSnap;
    if (first) state.prevSnap = new Float32Array(hi + 1);
    let flux = 0;
    for (let i = lo; i <= hi; i++) {
      const v = 20 * Math.log10(Math.max(meter.perc[i], 1e-6));
      flux += Math.max(0, v - state.prevSnap[i]);
      state.prevSnap[i] = v;
    }
    if (first) return 0;
    flux /= hi - lo + 1;
    state.snapMean += (flux - state.snapMean) * 0.05;
    state.snapPeak = Math.max(flux, state.snapPeak * 0.997, 1);
    const floor = state.snapMean * 1.5;
    return clamp01((flux - floor) / Math.max(1, state.snapPeak - floor));
  }

  // голос: где тональная середина сейчас между своим недавним минимумом и максимумом. Края шкалы
  // сразу расширяются до нового значения и медленно (~0,6 дБ в секунду) сходятся обратно, чтобы и тихий
  // куплет после громкого припева тоже «дышал».
  function voiceLevel(db) {
    if (db <= SILENCE_DB) return 0;
    if (state.voiceLo === null) { state.voiceLo = db - 6; state.voiceHi = db + 6; }
    state.voiceLo = db < state.voiceLo ? db : state.voiceLo + 0.01;
    state.voiceHi = db > state.voiceHi ? db : state.voiceHi - 0.01;
    if (state.voiceHi - state.voiceLo < 12) state.voiceLo = state.voiceHi - 12;
    return clamp01((db - state.voiceLo) / (state.voiceHi - state.voiceLo));
  }

  function pushMeter(values) {
    const round = (v) => Math.round(v * 1000) / 1000;
    window.__ymwPush(JSON.stringify({ type: 'meter', beat: round(values.beat), snap: round(values.snap), voice: round(values.voice) }));
  }

  function meterTick() {
    if (!alive()) return;
    const playing = resolve() && rootModel.sonataState.status === 'playing';
    if (!playing) {
      if (state.beat || state.snap || state.voice || state.frames) {
        const hist = state.hist;
        state = layers();
        state.hist = hist; // буферы те же, просто начинаем заново
        pushMeter({ beat: 0, snap: 0, voice: 0 });
      }
      return;
    }
    if (!audioModel) audioModel = findContextValue((v) => 'analyser' in v && 'equalizer' in v);
    const graph = audioModel && audioModel.analyser.currentGraph;
    if (!graph || !graph.analyserNode) return;
    hookAll();
    // Плеер пересоздаёт граф при смене трека и кроссфейде, а пересобирая его, может отключить и наш
    // узел — тогда переподключаемся: к новому графу сразу, к прежнему после секунды тишины.
    if (graph !== meter.graph || meter.silent > METER_HZ) attachMeter(graph);

    meter.tap.getFloatFrequencyData(meter.data);
    separate();
    const level = bandDb(meter.mag, meter.kick);
    meter.silent = level <= FLOOR_DB + 1 ? meter.silent + 1 : 0;

    state.beat = Math.max(beatHit(bandDb(meter.perc, meter.kick), level), state.beat * DECAY.beat);
    state.snap = Math.max(snapHit(), state.snap * DECAY.snap);
    state.voice = voiceLevel(bandDb(meter.harm, meter.voice));
    pushMeter(state);
  }

  function setMeter(enabled) {
    clearInterval(meter.timer);
    meter.timer = null;
    if (enabled) meter.timer = setInterval(meterTick, 1000 / METER_HZ);
    else { detachMeter(); unhookAll(); state = layers(); }
  }

  const api = {
    version: VERSION,
    // Остановленный адаптер убирает себя со страницы, чтобы следующий запуск виджета внедрил его заново.
    stop: () => {
      clearInterval(timer);
      setMeter(false);
      if (window.__ymw === api) delete window.__ymw;
    },
    ping: () => { lastPing = performance.now(); },
    resync: () => { lastPing = performance.now(); lastKey = ''; tick(); },
    act: async (name, args) => {
      lastPing = performance.now();
      if (name === 'stop') return api.stop() || null;
      if (name === 'meter') return setMeter(Boolean(args && args[0])) || null;
      if (!Object.hasOwn(actions, name)) throw new Error('Неизвестная команда: ' + name);
      if (!resolve()) throw new Error('Яндекс Музыка ещё не готова');
      // Переключение трека возвращается, только когда новый трек загрузится, а очередь сдвигается сразу.
      // Снимаем состояние и сразу после команды: виджет показывает новый трек, не дожидаясь загрузки.
      const run = actions[name](...(args || []));
      lastKey = '';
      followUp();
      const result = await run;
      lastKey = '';
      followUp();
      return result === undefined ? null : result;
    },
  };
  window.__ymw = api;
})();
