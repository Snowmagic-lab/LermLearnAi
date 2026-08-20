const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const { mkdir, readFile, writeFile, stat } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let windowRef;
let setupWindowActive = false;
let setupWindowRef;
let appBooting = true;
let athenaVoiceProcess;
let athenaVoiceBuffer = '';
let athenaVoiceSequence = 0;
const athenaVoiceRequests = new Map();
// Public OAuth client identifier for the published desktop app. It identifies
// the app but is not a secret; API keys and client secrets stay local.
const BUNDLED_GOOGLE_CLIENT_ID = '658472864580-mp1kghp3n1i2p9mtojocmaf36v5q9uus.apps.googleusercontent.com';

function upsertEnvValue(text, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
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
    // New users only need an AI key. The desktop OAuth client is bundled.
    return hasProviderKey && Boolean(envValue(content, 'GOOGLE_CLIENT_ID') || BUNDLED_GOOGLE_CLIENT_ID);
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
    googleClientId: value('GOOGLE_CLIENT_ID') || BUNDLED_GOOGLE_CLIENT_ID,
    hasClientSecret: Boolean(value('GOOGLE_CLIENT_SECRET')),
    hasGeminiVoiceKey: Boolean(value('GEMINI_VOICE_API_KEY'))
  };
}

function envValue(text, name) {
  return text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || '';
}

function athenaRoot() {
  const configured = String(process.env.ATHENA_ROOT || '').trim();
  const candidates = [
    configured,
    'C:\\Users\\ACER\\Desktop\\Assistance\\Back Up\\Athena',
    path.resolve(__dirname, '..', 'Back Up', 'Athena')
  ].filter(Boolean);
  return candidates.find(candidate => require('node:fs').existsSync(path.join(candidate, 'core', 'stt.py'))) || '';
}

function athenaPython(root) {
  const candidates = [
    process.env.ATHENA_PYTHON,
    root && path.join(root, '.venv', 'Scripts', 'python.exe'),
    root && path.join(root, 'venv', 'Scripts', 'python.exe'),
    'python'
  ].filter(Boolean);
  return candidates.find(candidate => candidate === 'python' || require('node:fs').existsSync(candidate)) || 'python';
}

function athenaWhisperAvailable(root) {
  if (!root) return false;
  const fs = require('node:fs');
  return [
    path.join(root, '.venv', 'Lib', 'site-packages', 'faster_whisper'),
    path.join(root, 'venv', 'Lib', 'site-packages', 'faster_whisper'),
    path.join(root, '.venv', 'lib', 'site-packages', 'faster_whisper'),
    path.join(root, 'venv', 'lib', 'site-packages', 'faster_whisper')
  ].some(candidate => fs.existsSync(candidate));
}

async function currentVoiceConfig() {
  let content = '';
  try { content = await readFile(path.join(app.getPath('userData'), '.env.local'), 'utf8'); } catch {}
  return { key: envValue(content, 'GEMINI_VOICE_API_KEY'), root: athenaRoot() };
}

function rejectAthenaVoiceRequests(error) {
  for (const [, request] of athenaVoiceRequests) request.reject(error);
  athenaVoiceRequests.clear();
}

async function ensureAthenaVoiceBridge() {
  if (athenaVoiceProcess && !athenaVoiceProcess.killed) return { ok: true };
  const config = await currentVoiceConfig();
  if (!config.root) return { ok: false, message: 'ไม่พบ runtime ของ Athena ในเครื่องนี้' };
  const unpackedBridge = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'athena-live-bridge.py');
  const bridge = require('node:fs').existsSync(unpackedBridge) ? unpackedBridge : path.join(__dirname, 'athena-live-bridge.py');
  if (!require('node:fs').existsSync(bridge)) return { ok: false, message: 'ไม่พบไฟล์ Athena Voice Bridge' };
  const child = spawn(athenaPython(config.root), [bridge], {
    cwd: config.root,
    env: {
      ...process.env,
      ATHENA_ROOT: config.root,
      STUDYFLOW_GEMINI_VOICE_API_KEY: config.key
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  athenaVoiceProcess = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    athenaVoiceBuffer += chunk;
    const lines = athenaVoiceBuffer.split(/\r?\n/);
    athenaVoiceBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const result = JSON.parse(line);
        const pending = athenaVoiceRequests.get(result.id);
        if (!pending) continue;
        athenaVoiceRequests.delete(result.id);
        if (result.ok) pending.resolve(result);
        else pending.reject(new Error(result.error || 'Athena Voice Bridge ทำงานไม่สำเร็จ'));
      } catch {}
    }
  });
  child.stderr.on('data', chunk => console.warn(`[Athena Voice] ${String(chunk).trim()}`));
  child.on('error', error => {
    athenaVoiceProcess = undefined;
    rejectAthenaVoiceRequests(error);
  });
  child.on('exit', () => {
    athenaVoiceProcess = undefined;
    rejectAthenaVoiceRequests(new Error('Athena Voice Bridge ปิดตัวลง'));
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  return { ok: true };
}

async function callAthenaVoice(action, payload = {}) {
  const bridge = await ensureAthenaVoiceBridge();
  if (!bridge.ok) throw new Error(bridge.message);
  const id = `voice-${Date.now()}-${++athenaVoiceSequence}`;
  return new Promise((resolve, reject) => {
    athenaVoiceRequests.set(id, { resolve, reject });
    try {
      athenaVoiceProcess.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`);
    } catch (error) {
      athenaVoiceRequests.delete(id);
      reject(error);
    }
  });
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

ipcMain.handle('studyflow:open-voice-browser', async (_event, origin) => {
  try {
    const parsed = new URL(String(origin || ''));
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      return { ok: false, message: 'เปิดโหมดเสียงได้เฉพาะ StudyFlow ที่ทำงานในเครื่องนี้เท่านั้น' };
    }
    parsed.searchParams.set('voice', '1');
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch {
    return { ok: false, message: 'เปิด Chrome/Edge สำหรับโหมดเสียงไม่สำเร็จ' };
  }
});

ipcMain.handle('studyflow:get-voice-capabilities', async () => {
  const config = await currentVoiceConfig();
  const whisper = athenaWhisperAvailable(config.root);
  return {
    native: Boolean(config.root),
    athenaRoot: Boolean(config.root),
    charon: Boolean(config.key),
    whisper: Boolean(config.root)
      && whisper,
    localTranscribe: whisper
  };
});

ipcMain.handle('studyflow:speak-voice', async (_event, text) => {
  try {
    const config = await currentVoiceConfig();
    if (!config.key) return { ok: false, code: 'missing_gemini_voice_key', message: 'ยังไม่ได้ตั้งค่า Gemini API key สำหรับเสียง Athena' };
    const result = await callAthenaVoice('speak', { text: String(text || '').slice(0, 900) });
    return { ok: true, pcm16: result.pcm16, sampleRate: result.sampleRate || 24000 };
  } catch (error) {
    return { ok: false, code: 'voice_bridge_error', message: error?.message || 'เรียกเสียง Athena ไม่สำเร็จ' };
  }
});

ipcMain.handle('studyflow:transcribe-voice', async (_event, pcm16) => {
  try {
    const result = await callAthenaVoice('transcribe', { pcm16: String(pcm16 || '') });
    return { ok: true, text: result.text || '' };
  } catch (error) {
    return { ok: false, code: 'voice_transcription_error', message: error?.message || 'ถอดเสียงไม่สำเร็จ' };
  }
});

// Voice commands may load a file into the existing StudyFlow picker, but they
// must never execute a shell command or modify the filesystem. Keep this
// bridge read-only and limited to study-material formats/size.
const STUDY_FILE_LIMIT = 50 * 1024 * 1024;
const STUDY_FILE_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VOICE_FOLDER_ALIASES = {
  'ดาวน์โหลด': 'Downloads', 'ดาวโหลด': 'Downloads', 'download': 'Downloads', 'downloads': 'Downloads',
  'เดสก์ท็อป': 'Desktop', 'เดสท็อป': 'Desktop', 'desktop': 'Desktop',
  'เอกสาร': 'Documents', 'document': 'Documents', 'documents': 'Documents'
};
function cleanVoicePath(value) {
  return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[.,，。]+$/g, '').trim();
}
async function findStudyFileForVoice(filePath) {
  const raw = cleanVoicePath(filePath);
  if (!raw) throw new Error('ไม่ได้ระบุชื่อหรือที่อยู่ไฟล์');
  const normalized = raw.replace(/^ไฟล์\s*/i, '').trim();
  const home = os.homedir();
  const candidates = [];
  const addCandidate = value => { if (value && !candidates.includes(value)) candidates.push(value); };
  if (path.isAbsolute(normalized)) addCandidate(normalized);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) || normalized;
  const folderToken = parts.length > 1 ? parts.at(-2) : '';
  const folderName = VOICE_FOLDER_ALIASES[folderToken.toLowerCase()] || folderToken;
  if (folderName) addCandidate(path.join(home, folderName, name));
  ['Downloads', 'Desktop', 'Documents'].forEach(folder => addCandidate(path.join(home, folder, name)));
  let chosen = null;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) { chosen = candidate; break; }
    } catch {}
  }
  if (!chosen) throw new Error(`หาไฟล์ “${name}” ไม่พบในโฟลเดอร์ที่ระบุ`);
  const info = await stat(chosen);
  if (info.size > STUDY_FILE_LIMIT) throw new Error('ไฟล์ต้องมีขนาดไม่เกิน 50 MB');
  if (!STUDY_FILE_EXTENSIONS.has(path.extname(chosen).toLowerCase())) throw new Error('ชนิดไฟล์นี้ยังไม่อยู่ในขอบเขตห้องติว');
  const data = await readFile(chosen);
  return { name: path.basename(chosen), path: chosen, size: info.size, data: data.toString('base64') };
}
ipcMain.handle('studyflow:load-study-file', async (_event, filePath) => {
  try { return { ok: true, file: await findStudyFileForVoice(filePath) }; }
  catch (error) { return { ok: false, message: error?.message || 'อ่านไฟล์ไม่สำเร็จ' }; }
});

ipcMain.handle('studyflow:save-api-config', async (_event, payload) => {
  const provider = ['qwen','deepseek','openai'].includes(String(payload?.provider||'').toLowerCase())?String(payload.provider).toLowerCase():'qwen';
  const key = String(payload?.apiKey || '').trim();
  // Accept legacy fields when an older settings page sends them, but do not
  // require OAuth credentials from a new installation.
  const googleClientId = String(payload?.googleClientId || '').trim() || BUNDLED_GOOGLE_CLIENT_ID;
  const googleClientSecret = String(payload?.googleClientSecret || '').trim();
  const geminiVoiceKey = String(payload?.geminiVoiceKey || '').trim();
  if (key.length < 20) return { ok: false, message: 'AI API key ไม่ครบถ้วน' };
  const configPath = path.join(app.getPath('userData'), '.env.local');
  let content = '';
  try { content = await readFile(configPath, 'utf8'); } catch {}
  const existingSecret = content.match(/^GOOGLE_CLIENT_SECRET=(.*)$/m)?.[1]?.trim() || '';
  const effectiveSecret = googleClientSecret || existingSecret;
  const existingGeminiVoiceKey = envValue(content, 'GEMINI_VOICE_API_KEY');
  const effectiveGeminiVoiceKey = geminiVoiceKey || existingGeminiVoiceKey;
  content = upsertEnvValue(content, 'AI_PROVIDER', provider);
  if(provider==='qwen'){content=upsertEnvValue(content,'QWEN_API_KEY',key);content=upsertEnvValue(content,'QWEN_MODEL','qwen3.7-plus');content=upsertEnvValue(content,'QWEN_BASE_URL','https://dashscope-intl.aliyuncs.com/compatible-mode/v1')}
  else if(provider==='deepseek'){content=upsertEnvValue(content,'DEEPSEEK_API_KEY',key);content=upsertEnvValue(content,'DEEPSEEK_MODEL','deepseek-v4-flash')}
  else{content=upsertEnvValue(content,'OPENAI_API_KEY',key);content=upsertEnvValue(content,'OPENAI_MODEL','gpt-4.1-mini')}
  content = upsertEnvValue(content, 'GOOGLE_CLIENT_ID', googleClientId);
  content = upsertEnvValue(content, 'GOOGLE_CLIENT_SECRET', effectiveSecret);
  content = upsertEnvValue(content, 'GOOGLE_REDIRECT_URI', 'http://127.0.0.1:4173/oauth/callback');
  if (effectiveGeminiVoiceKey) content = upsertEnvValue(content, 'GEMINI_VOICE_API_KEY', effectiveGeminiVoiceKey);
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(configPath, content, { encoding: 'utf8', mode: 0o600 });
  // Apply the replacement immediately; the server reads these values per request.
  process.env.AI_PROVIDER = provider;
  if(provider==='qwen'){process.env.QWEN_API_KEY=key;process.env.QWEN_MODEL='qwen3.7-plus';process.env.QWEN_BASE_URL='https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}
  else if(provider==='deepseek'){process.env.DEEPSEEK_API_KEY=key;process.env.DEEPSEEK_MODEL='deepseek-v4-flash'}
  else{process.env.OPENAI_API_KEY=key;process.env.OPENAI_MODEL='gpt-4.1-mini'}
  process.env.GOOGLE_CLIENT_ID = googleClientId;
  process.env.GOOGLE_CLIENT_SECRET = effectiveSecret;
  process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1:4173/oauth/callback';
  process.env.GEMINI_VOICE_API_KEY = effectiveGeminiVoiceKey;
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
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone' || permission === 'audioCapture');
  });
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
app.on('before-quit', () => {
  try { athenaVoiceProcess?.kill(); } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !appBooting && !setupWindowActive) app.quit(); });
