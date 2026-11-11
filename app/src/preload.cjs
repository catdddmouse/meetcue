'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = ['notice', 'ask-start', 'ask-state', 'answer', 'ask-error', 'keytest'];
contextBridge.exposeInMainWorld('prompter', {
  call: (name, arg) => ipcRenderer.invoke('prompter:' + name, arg),
  on: (ch, fn) => { if (CHANNELS.includes(ch)) ipcRenderer.on('prompter:' + ch, (_e, d) => fn(d)); }
});
