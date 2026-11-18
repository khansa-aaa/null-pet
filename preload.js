const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nullPet', {
  state: () => ipcRenderer.invoke('null:state'),
  toggle: () => ipcRenderer.send('null:toggle'),
  close: () => ipcRenderer.send('null:close'),
  setMode: (mode) => ipcRenderer.send('null:mode', mode),
  approve: (cardId, actionIds) => ipcRenderer.invoke('null:approve', cardId, actionIds),
  reject: (cardId, why) => ipcRenderer.invoke('null:reject', cardId, why),
  chat: (cardId, text) => ipcRenderer.invoke('null:chat', cardId, text),
  say: (pid, text) => ipcRenderer.invoke('null:say', pid, text),
  dismiss: (cardId) => ipcRenderer.invoke('null:dismiss', cardId),
  recommend: (pid) => ipcRenderer.invoke('null:recommend', pid),
  addProject: () => ipcRenderer.invoke('null:addProject'),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag:end'),
  menu: () => ipcRenderer.send('pet:menu'),
  on: (channel, fn) => {
    const allowed = ['null:state', 'null:open', 'null:look', 'null:anim', 'null:toast'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
