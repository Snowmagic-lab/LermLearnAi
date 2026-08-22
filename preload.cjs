const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyflowDesktop', {
  savePdf: html => ipcRenderer.invoke('studyflow:save-pdf', html),
  saveApiConfig: payload => ipcRenderer.invoke('studyflow:save-api-config', payload),
  getApiConfigMeta: () => ipcRenderer.invoke('studyflow:get-api-config-meta'),
  openApiSetup: () => ipcRenderer.invoke('studyflow:open-api-setup')
});
