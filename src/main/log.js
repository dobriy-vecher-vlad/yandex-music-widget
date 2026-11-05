// Короткий журнал в %APPDATA%\yandex-music-widget\widget.log — чтобы разбирать редкие ситуации
// (например, какое окно накрыло виджет). Больше 256 КБ не растёт: старая половина отбрасывается.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LIMIT = 256 * 1024;
const file = () => path.join(app.getPath('userData'), 'widget.log');

function log(message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    const size = fs.existsSync(file()) ? fs.statSync(file()).size : 0;
    if (size > LIMIT) {
      const text = fs.readFileSync(file(), 'utf8');
      fs.writeFileSync(file(), text.slice(text.indexOf('\n', text.length / 2) + 1));
    }
    fs.appendFileSync(file(), line);
  } catch {
    // журнал — вспомогательный, его ошибки не должны мешать виджету
  }
}

module.exports = { log, file };
