// Окно вертикального слайдера над кнопкой громкости или свечения. Значение живёт в виджете:
// сюда оно приходит (pop:show, pop:value), а отсюда уходят только сдвиги ползунка (pop.set).
const level = document.getElementById('level');
const fill = document.getElementById('fill');
const thumb = document.getElementById('thumb');

let kind = null;
let value = 0;

function render() {
  const percent = `${value * 100}%`;
  fill.style.height = percent;
  thumb.style.bottom = percent;
}

window.pop.onShow((data) => {
  kind = data.kind;
  value = data.value;
  document.body.classList.toggle('ym-light-theme', data.theme === 'light');
  document.body.classList.toggle('ym-dark-theme', data.theme !== 'light');
  document.body.classList.toggle('is-down', data.down);
  document.body.classList.toggle('is-off', Boolean(data.off));
  render();
  requestAnimationFrame(() => document.body.classList.add('is-open'));
});
window.pop.onHide(() => document.body.classList.remove('is-open', 'is-dragging'));
window.pop.onValue((data) => {
  if (data.kind !== kind) return;
  document.body.classList.toggle('is-off', Boolean(data.off));
  if (document.body.classList.contains('is-dragging')) return;
  value = data.value;
  render();
});

function set(next) {
  value = Math.round(Math.min(1, Math.max(0, next)) * 100) / 100;
  render();
  window.pop.set(kind, value);
}

const track = level.querySelector('.track');
const valueAt = (e) => {
  const r = track.getBoundingClientRect();
  return (r.bottom - e.clientY) / r.height;
};
let pointerId = null;
level.addEventListener('pointerdown', (e) => {
  pointerId = e.pointerId;
  level.setPointerCapture(e.pointerId);
  document.body.classList.add('is-dragging');
  window.pop.dragging(true);
  set(valueAt(e));
});
level.addEventListener('pointermove', (e) => { if (e.pointerId === pointerId) set(valueAt(e)); });
const end = () => {
  if (pointerId === null) return;
  pointerId = null;
  document.body.classList.remove('is-dragging');
  window.pop.dragging(false);
};
level.addEventListener('pointerup', end);
level.addEventListener('pointercancel', end);
// колесо — над всем окном: его прозрачное поле под тень немного заходит на кнопку
document.addEventListener('wheel', (e) => set(value + (e.deltaY < 0 ? 0.05 : -0.05)), { passive: true });
// всё окно, а не только плашка: прозрачное поле вокруг неё тоже ловит курсор
document.documentElement.addEventListener('pointerenter', () => window.pop.hover(true));
document.documentElement.addEventListener('pointerleave', () => window.pop.hover(false));
