const halo = document.getElementById('halo');
const thumb = document.getElementById('thumb');
const MARGIN = 90; // отступ подложки от виджета, совпадает с MARGIN в main/glow.js

// Яркость ореола не зависит от громкости: пока трек играет, он горит ровно (presence → 1), а сверху
// три слоя из адаптера (adapter.page.js, «Свечение в три слоя»):
//   pulse ← beat  — удары бочки: вспышка всего ореола, главный слой;
//   snap  ← snap  — хлопки, малый барабан, тарелки: короткое мерцание контура;
//   voice ← voice — голос и мелодия: медленное «дыхание» части пятен.
let lit = false; // свечение включено, виджет виден и трек играет
const target = { pulse: 0, snap: 0, voice: 0, presence: 0 };
const value = { pulse: 0, snap: 0, voice: 0, presence: 0 };
// скорость приближения к цели за кадр: [нарастание, спад]
const RATE = {
  pulse: [0.7, 0.12], // удар почти мгновенно, гаснет за ~0,3 с
  snap: [0.8, 0.25], // ещё короче
  voice: [0.08, 0.04], // голос плавно, без рывков на каждом слоге
  presence: [0.04, 0.04], // ореол разгорается и гаснет на паузе
};

window.glow.onColors((colors) => {
  colors.forEach((c, i) => halo.style.setProperty(`--glow-${i + 1}`, c));
});

window.glow.onState(({ on, playing }) => {
  halo.classList.toggle('is-on', on);
  lit = on && playing;
  target.presence = lit ? 1 : 0;
  if (!lit) target.pulse = target.snap = target.voice = 0;
  wake();
});

window.glow.onThumb((data) => {
  thumb.style.display = data ? 'block' : 'none';
  if (!data) return;
  thumb.style.left = `${MARGIN + data.x - data.size / 2}px`;
  thumb.style.top = `${MARGIN + data.y - data.size / 2}px`;
  thumb.style.width = thumb.style.height = `${data.size}px`;
  thumb.style.background = data.color;
});

window.glow.onLevel((level) => halo.style.setProperty('--level', level));

window.glow.onMeter(({ beat = 0, snap = 0, voice = 0 }) => {
  if (!lit) return;
  target.pulse = beat;
  target.snap = snap;
  target.voice = voice;
  wake();
});

// Замеры приходят 60 раз в секунду, значения сглаживаем по кадрам. Цикл кадров живёт, только пока
// значения меняются: на паузе и с выключенным свечением окно подложки ничего не считает.
let running = false;
// у самой цели значение ставим точно, иначе цикл замрёт на долях процента от нуля
const approach = (v, t, [up, down]) => (Math.abs(t - v) < 0.01 ? t : v + (t - v) * (t > v ? up : down));
function frame() {
  let changed = false;
  for (const key of Object.keys(value)) {
    const next = approach(value[key], target[key], RATE[key]);
    if (next === value[key]) continue;
    value[key] = next;
    halo.style.setProperty(`--${key}`, next.toFixed(3));
    changed = true;
  }
  if (changed) {
    requestAnimationFrame(frame);
  } else {
    running = false;
    // погасший ореол не анимирует пятна, чтобы на паузе подложка не тратила кадры
    halo.classList.toggle('is-idle', value.presence < 0.01);
  }
}
function wake() {
  halo.classList.remove('is-idle');
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}
