// Рисует build/icon.ico и build/icon.png из build/icon.svg. Запуск: npx electron build/make-icon.js
// Иконка многоразмерная: её берут и установщик, и трей.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

// Рисуем через canvas в странице: так не нужен ни видимый экран, ни offscreen-рендер
async function render(win, size) {
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.src = '${src}';
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ICO с PNG внутри: заголовок, каталог по 16 байт на размер, затем сами PNG
function toIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const entries = [];
  for (const size of SIZES) {
    entries.push({ size, png: await render(win, size) });
  }
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), toIco(entries));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), entries.at(-1).png);
  console.log('icon.ico:', SIZES.join(', '));
  app.quit();
});
