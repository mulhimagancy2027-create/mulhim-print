const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (c, a) => ipcRenderer.invoke(c, a);
contextBridge.exposeInMainWorld('api', {
  printers: () => inv('printers:list'),
  test: a => inv('printers:test', a),
  pick: () => inv('file:pick'),
  info: p => inv('file:info', p),
  get: () => inv('store:get'),
  set: d => inv('store:set', d),
  run: j => inv('job:run', j),
  pathOf: f => webUtils.getPathForFile(f)
});
