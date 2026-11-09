// Ponte minimo e controllato tra interfaccia e main process:
// l'interfaccia non ha accesso diretto a Node, file system o rete.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const on = (channel) => (cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  invoke: (channel, ...args) => {
    if (!/^(servers|server|settings|window|dialog|shell|ssh|term|screen|sftp|prompt|config|app|data|recipe|share):/.test(channel)) {
      return Promise.reject(new Error('Canale non consentito'));
    }
    return call(channel, ...args);
  },
  termWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onPrompt: on('prompt'),
  onTermData: on('term:data'),
  onTermExit: on('term:exit'),
  onConnClosed: on('conn:closed'),
  onTransfer: on('transfer'),
  onExternalSaved: on('external:saved'),
  onMenu: on('menu'),
  onTunnels: on('tunnels'),
  onUpdate: on('update'),
  onShare: on('share'),
  onChanges: on('changes'),
});
