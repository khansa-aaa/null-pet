const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nullPet', {
  state: () => ipcRenderer.invoke('null:state'),
  toggle: () => ipcRenderer.send('null:toggle'),
  close: () => ipcRenderer.send('null:close'),
  setLarge: (on) => ipcRenderer.send('null:large', on),
  setMode: (mode) => ipcRenderer.send('null:mode', mode),
  approve: (cardId, actionIds) => ipcRenderer.invoke('null:approve', cardId, actionIds),
  reject: (cardId, why) => ipcRenderer.invoke('null:reject', cardId, why),
  chat: (cardId, text) => ipcRenderer.invoke('null:chat', cardId, text),
  say: (pid, text) => ipcRenderer.invoke('null:say', pid, text),
  dismiss: (cardId) => ipcRenderer.invoke('null:dismiss', cardId),
  recommend: (pid) => ipcRenderer.invoke('null:recommend', pid),
  addProject: () => ipcRenderer.invoke('null:addProject'),
  closeSession: (pid) => ipcRenderer.invoke('null:closeSession', pid),
  openSession: (projectId, sessionId) => ipcRenderer.invoke('null:openSession', projectId, sessionId),
  pauseSession: (projectId, sessionId, paused) => ipcRenderer.invoke('null:pauseSession', projectId, sessionId, paused),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag:end'),
  menu: () => ipcRenderer.send('pet:menu'),
  on: (channel, fn) => {
    const allowed = ['null:state', 'null:open', 'null:large', 'null:look', 'null:anim', 'null:toast'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
