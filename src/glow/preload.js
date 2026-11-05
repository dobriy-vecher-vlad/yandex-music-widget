const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (listener) => ipcRenderer.on(channel, (_e, payload) => listener(payload));

contextBridge.exposeInMainWorld('glow', {
  onColors: on('glow:colors'),
  onState: on('glow:state'),
  onMeter: on('glow:meter'),
  onLevel: on('glow:level'),
  onThumb: on('glow:thumb'),
});
