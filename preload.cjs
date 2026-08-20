const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyflowDesktop', {
  savePdf: html => ipcRenderer.invoke('studyflow:save-pdf', html),
  saveApiConfig: payload => ipcRenderer.invoke('studyflow:save-api-config', payload),
  getApiConfigMeta: () => ipcRenderer.invoke('studyflow:get-api-config-meta'),
  openApiSetup: () => ipcRenderer.invoke('studyflow:open-api-setup'),
  loadStudyFileFromPath: filePath => ipcRenderer.invoke('studyflow:load-study-file', filePath),
  openVoiceBrowser: origin => ipcRenderer.invoke('studyflow:open-voice-browser', origin)
  ,getVoiceCapabilities: () => ipcRenderer.invoke('studyflow:get-voice-capabilities')
  ,speakVoice: text => ipcRenderer.invoke('studyflow:speak-voice', text)
  ,transcribeVoice: pcm16 => ipcRenderer.invoke('studyflow:transcribe-voice', pcm16)
});
