const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

let windowRef;
let setupWindowActive = false;
let setupWindowRef;
let appBooting = true;

function upsertEnvValue(text, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

function removeEnvValue(text, name) {
  return text.replace(new RegExp(`^${name}=.*(?:\\r?\\n|$)`, 'gm'), '');
}

async function apiConfigExists() {
  try {
    const content = await readFile(path.join(app.getPath('userData'), '.env.local'), 'utf8');
    const provider=content.match(/^AI_PROVIDER=(.*)$/m)?.[1]?.trim().toLowerCase()||'qwen';
    const hasProviderKey=provider==='qwen'
      ? /^QWEN_API_KEY=\s*\S+/m.test(content)
      : provider==='deepseek'
        ? /^DEEPSEEK_API_KEY=\s*\S+/m.test(content)
        : provider==='openai' && /^OPENAI_API_KEY=\s*\S+/m.test(content);
    return hasProviderKey;
  } catch {
    return false;
  }
}

async function apiConfigMeta() {
  let content = '';
  try { content = await readFile(path.join(app.getPath('userData'), '.env.local'), 'utf8'); } catch {}
  const value = name => content.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || '';
  const configuredProvider=value('AI_PROVIDER').toLowerCase();
  const provider=configuredProvider==='openai'?'openai':configuredProvider==='deepseek'?'deepseek':'qwen';
  return {
    ok: true,
    provider,
    hasApiKey: Boolean(provider==='qwen'?value('QWEN_API_KEY'):provider==='deepseek'?value('DEEPSEEK_API_KEY'):value('OPENAI_API_KEY')),
    googleOAuthBundled: true
  };
}

function createSetupWindow() {
  if (setupWindowRef && !setupWindowRef.isDestroyed()) {
    setupWindowRef.show();
    setupWindowRef.focus();
    return setupWindowRef;
  }
  setupWindowActive = true;
  setupWindowRef = new BrowserWindow({
    width: 760,
    height: 720,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#070a10',
    parent: windowRef && !windowRef.isDestroyed() ? windowRef : undefined,
    modal: Boolean(windowRef && !windowRef.isDestroyed()),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') }
  });
  setupWindowRef.on('closed', () => {
    setupWindowRef = undefined;
    setupWindowActive = false;
  });
  setupWindowRef.loadFile(path.join(__dirname, 'setup.html'));
  return setupWindowRef;
}

ipcMain.handle('studyflow:get-api-config-meta', () => apiConfigMeta());
ipcMain.handle('studyflow:open-api-setup', () => {
  const setupWindow = createSetupWindow();
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
  }
  return { ok: true };
});

ipcMain.handle('studyflow:save-api-config', async (_event, payload) => {
  const provider = ['qwen','deepseek','openai'].includes(String(payload?.provider||'').toLowerCase())?String(payload.provider).toLowerCase():'qwen';
  const key = String(payload?.apiKey || '').trim();
  if (key.length < 20) return { ok: false, message: 'AI API key ไม่ครบถ้วน' };
  const configPath = path.join(app.getPath('userData'), '.env.local');
  let content = '';
  try { content = await readFile(configPath, 'utf8'); } catch {}
  content = upsertEnvValue(content, 'AI_PROVIDER', provider);
  if(provider==='qwen'){content=upsertEnvValue(content,'QWEN_API_KEY',key);content=upsertEnvValue(content,'QWEN_MODEL','qwen3.7-plus');content=upsertEnvValue(content,'QWEN_BASE_URL','https://dashscope-intl.aliyuncs.com/compatible-mode/v1')}
  else if(provider==='deepseek'){content=upsertEnvValue(content,'DEEPSEEK_API_KEY',key);content=upsertEnvValue(content,'DEEPSEEK_MODEL','deepseek-v4-flash')}
  else{content=upsertEnvValue(content,'OPENAI_API_KEY',key);content=upsertEnvValue(content,'OPENAI_MODEL','gpt-4.1-mini')}
  // OAuth Client ID is bundled in server.mjs. Never ask testers to enter
  // client credentials, and remove legacy user-supplied values if present.
  content = removeEnvValue(content, 'GOOGLE_CLIENT_ID');
  content = removeEnvValue(content, 'GOOGLE_CLIENT_SECRET');
  content = removeEnvValue(content, 'GOOGLE_REDIRECT_URI');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(configPath, content, { encoding: 'utf8', mode: 0o600 });
  // Apply the replacement immediately; the server reads these values per request.
  process.env.AI_PROVIDER = provider;
  if(provider==='qwen'){process.env.QWEN_API_KEY=key;process.env.QWEN_MODEL='qwen3.7-plus';process.env.QWEN_BASE_URL='https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}
  else if(provider==='deepseek'){process.env.DEEPSEEK_API_KEY=key;process.env.DEEPSEEK_MODEL='deepseek-v4-flash'}
  else{process.env.OPENAI_API_KEY=key;process.env.OPENAI_MODEL='gpt-4.1-mini'}
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
  const owner = BrowserWindow.fromWebContents(_event.sender);
  if (owner && !owner.isDestroyed()) owner.close();
  if (windowRef && !windowRef.isDestroyed()) windowRef.focus();
  return { ok: true };
});

async function ensureApiConfig() {
  if (await apiConfigExists()) return true;
  await new Promise(resolve => {
    const setupWindow = createSetupWindow();
    setupWindow.once('closed', resolve);
  });
  return apiConfigExists();
}

ipcMain.handle('studyflow:save-pdf', async (event, html) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const chosen = await dialog.showSaveDialog(owner, { defaultPath: 'StudyFlow-summary.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (chosen.canceled || !chosen.filePath) return { canceled: true };
  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html || ''))}`);
    const pdf = await pdfWindow.webContents.printToPDF({ printBackground: true, marginsType: 0, pageSize: 'A4' });
    await writeFile(chosen.filePath, pdf);
    return { canceled: false, filePath: chosen.filePath };
  } finally {
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
  }
});

async function createWindow() {
  process.env.STUDYFLOW_DATA_DIR = app.getPath('userData');
  if (!(await ensureApiConfig())) { appBooting = false; app.quit(); return; }
  const expectedDataRoot = path.resolve(process.env.STUDYFLOW_DATA_DIR);
  const preferredPort = Number(process.env.PORT || 4173);
  let port = preferredPort;
  let serverReady = false;
  const runtimeMatches = async candidate => {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/api/runtime`);
      if (!response.ok) return false;
      const runtime = await response.json();
      return runtime?.app === 'studyflow' && path.resolve(runtime.dataRoot || '').toLowerCase() === expectedDataRoot.toLowerCase();
    } catch {
      return false;
    }
  };
  const { startServer } = await import('./server.mjs');
  for (let candidate = preferredPort; candidate < preferredPort + 20 && !serverReady; candidate += 1) {
    if (await runtimeMatches(candidate)) {
      port = candidate;
      serverReady = true;
      break;
    }
    process.env.PORT = String(candidate);
    try {
      await startServer(candidate);
      port = candidate;
      serverReady = true;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  if (!serverReady) throw new Error('ไม่สามารถเปิด StudyFlow server ได้');
  const serverUrl = `http://127.0.0.1:${port}`;
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#05070b',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') }
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    const resourceWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 760,
      minHeight: 560,
      parent: windowRef,
      autoHideMenuBar: true,
      backgroundColor: '#05070b',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    resourceWindow.loadURL(url);
    return { action: 'deny' };
  });
  await windowRef.loadURL(`${serverUrl}/`);
  appBooting = false;
}

app.whenReady().then(createWindow).catch(error => { console.error(error); appBooting = false; app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !appBooting && !setupWindowActive) app.quit(); });
