const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (listener) => ipcRenderer.on(channel, (_e, payload) => listener(payload));

contextBridge.exposeInMainWorld('pop', {
  set: (kind, value) => ipcRenderer.send('pop:set', { kind, value }),
  hover: (inside) => ipcRenderer.send('pop:hover', inside),
  dragging: (active) => ipcRenderer.send('pop:dragging', active),
  onShow: on('pop:show'),
  onHide: on('pop:hide'),
  onValue: on('pop:value'),
});
