'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('fish', {
  getState: () => ipcRenderer.invoke('state:get'),
  sendChat: (text, ack) => ipcRenderer.invoke('chat:send', { text, ack }),
  toggleTodo: (id) => ipcRenderer.invoke('todo:toggle', { id }),
  addTodo: (payload) => ipcRenderer.invoke('todo:add', payload),
  updateTodo: (id, patch) => ipcRenderer.invoke('todo:update', { id, patch }),
  removeTodo: (id) => ipcRenderer.invoke('todo:remove', { id }),
  toggleSub: (id, subId) => ipcRenderer.invoke('todo:sub-toggle', { id, subId }),
  addSub: (id, title) => ipcRenderer.invoke('todo:sub-add', { id, title }),
  updateSub: (id, subId, title) => ipcRenderer.invoke('todo:sub-update', { id, subId, title }),
  removeSub: (id, subId) => ipcRenderer.invoke('todo:sub-remove', { id, subId }),
  moveSub: (fromId, subId, toId) => ipcRenderer.invoke('todo:sub-move', { fromId, subId, toId }),
  setRepeat: (id, repeat) => ipcRenderer.invoke('todo:repeat', { id, repeat }),

  // 提醒
  listReminders: () => ipcRenderer.invoke('reminder:list'),
  saveReminder: (payload) => ipcRenderer.invoke('reminder:save', payload),
  removeReminder: (id) => ipcRenderer.invoke('reminder:remove', { id }),
  testReminder: (id) => ipcRenderer.invoke('reminder:test', { id }),
  testCare: () => ipcRenderer.invoke('care:test'),
  undo: () => ipcRenderer.invoke('undo'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  speak: (text, opts) => ipcRenderer.invoke('tts:speak', { text, ...(opts || {}) }),
  runBrief: (kind) => ipcRenderer.invoke('brief:run', { kind }),
  setMode: (mode) => ipcRenderer.invoke('win:mode', { mode }),
  hide: () => ipcRenderer.invoke('win:hide'),
  resizeWindow: (w, h) => ipcRenderer.send('win:resize', { w, h }),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  openData: () => ipcRenderer.invoke('app:open-data'),
  version: () => ipcRenderer.invoke('app:version'),
  pickPersonaFile: () => ipcRenderer.invoke('persona:pick'),

  // 角色音色库
  pickVoiceAudio: () => ipcRenderer.invoke('voice:pick-audio'),

  // 人设：每人设独立聊天记录 + 独立音色
  newPersona: (name) => ipcRenderer.invoke('persona:new', { name }),
  switchPersona: (id) => ipcRenderer.invoke('persona:switch', { id }),
  removePersona: (id) => ipcRenderer.invoke('persona:remove', { id }),
  addVoice: (payload) => ipcRenderer.invoke('voice:add', payload),
  updateVoice: (id, patch) => ipcRenderer.invoke('voice:update', { id, patch }),
  removeVoice: (id) => ipcRenderer.invoke('voice:remove', { id }),
  activateVoice: (id) => ipcRenderer.invoke('voice:activate', { id }),
  testVoice: (id) => ipcRenderer.invoke('voice:test', { id }),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  startLocalVoice: () => ipcRenderer.invoke('voice:start-local'),
  stopLocalVoice: () => ipcRenderer.invoke('voice:stop-local'),
  setLocalEnabled: (on) => ipcRenderer.invoke('voice:set-local-enabled', { on: Boolean(on) }),

  listLog: (opts) => ipcRenderer.invoke('log:list', opts || {}),
  deleteLogs: (ids) => ipcRenderer.invoke('log:delete', { ids: ids || [] }),
  deleteLogDay: (day) => ipcRenderer.invoke('log:delete-day', { day }),
  clearLog: () => ipcRenderer.invoke('log:clear'),
  exportLog: (opts) => ipcRenderer.invoke('log:export', opts || {}),

  onCare: (cb) => on('care', cb),
  onBrief: (cb) => on('brief', cb),
  onSpeak: (cb) => on('speak', cb),
  onFocusInput: (cb) => on('focus-input', cb),
  onMode: (cb) => on('mode', cb),
  onIdentity: (cb) => on('identity', cb),
  onOpenSettings: (cb) => on('open-settings', cb),
});
