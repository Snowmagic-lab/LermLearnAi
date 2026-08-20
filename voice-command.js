(() => {
  'use strict';

  const toggle = document.querySelector('#voice-command-toggle');
  const panel = document.querySelector('#voice-command-panel');
  const close = document.querySelector('#voice-command-close');
  const status = document.querySelector('#voice-command-status');
  const transcript = document.querySelector('#voice-command-transcript');
  const browserFallback = document.querySelector('#voice-command-browser');
  if (!toggle || !panel) return;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let handling = false;
  let continuous = false;
  let speaking = false;
  let restartTimer = null;
  let lastAthenaReply = '';
  let nativeCapabilities = { native: false, whisper: false, charon: false };
  let nativeStream = null;
  let nativeAudioContext = null;
  let nativeProcessor = null;
  let nativeChunks = [];
  let nativeSampleRate = 16000;
  let nativeSawSpeech = false;
  let nativeLastVoiceAt = 0;
  let nativeTranscribing = false;
  let nativeAudio = null;

  const setPanel = open => { panel.hidden = !open; };
  const setStatus = (message, kind = '') => {
    status.textContent = message;
    panel.classList.toggle('is-error', kind === 'error');
    panel.classList.toggle('is-success', kind === 'success');
  };
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const notify = message => window.showToast?.(message);
  const setBrowserFallback = visible => { if (browserFallback) browserFallback.hidden = !visible; };
  const pageDate = () => new Intl.DateTimeFormat('th-TH', { dateStyle: 'full' }).format(new Date());

  function pcmToWav(pcm16, sampleRate = 24000) {
    const raw = bytesFromBase64(pcm16);
    const buffer = new ArrayBuffer(44 + raw.length);
    const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + raw.length, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, raw.length, true);
    new Uint8Array(buffer, 44).set(raw);
    return new Blob([buffer], { type: 'audio/wav' });
  }
  async function playNativeAudio(result) {
    if (!result?.pcm16) return;
    if (nativeAudio) { try { nativeAudio.pause(); } catch {} }
    const url = URL.createObjectURL(pcmToWav(result.pcm16, result.sampleRate || 24000));
    nativeAudio = new Audio(url);
    await new Promise(resolve => {
      nativeAudio.onended = nativeAudio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      nativeAudio.play().catch(() => resolve());
    });
  }
  async function speak(message) {
    const text = normalize(message)
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\*_#`]/g, '')
      .replace(/\s*[-–—]\s*/g, ' ')
      .replace(/แหล่งอ้างอิง[^.。]*[.。]?/g, '')
      .replace(/ค่ะ|คะ/g, 'ครับ')
      .slice(0, 900);
    if (!text) return;
    if (nativeCapabilities.charon && window.studyflowDesktop?.speakVoice) {
      window.speechSynthesis?.cancel();
      speaking = true;
      if (nativeStream) stopNativeListening();
      if (recognition && listening) { try { recognition.stop(); } catch {} }
      listening = false;
      const result = await window.studyflowDesktop.speakVoice(text);
      if (result?.ok) {
        await playNativeAudio(result);
        speaking = false;
        if (continuous && !handling) startListening();
        return;
      }
      speaking = false;
      setStatus(result?.message || 'เสียง Athena ใช้งานไม่ได้ จึงใช้เสียงสำรองของระบบ', 'error');
    }
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
    window.speechSynthesis.cancel();
    if (recognition && listening) { try { recognition.stop(); } catch {} }
    listening = false;
    speaking = true;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    utterance.rate = 0.96;
    utterance.pitch = 1;
    return new Promise(resolve => {
      utterance.onend = utterance.onerror = () => {
        speaking = false;
        resolve();
        if (continuous && !handling) { if (nativeCapabilities.whisper) startNativeListening(); else scheduleRestart(); }
      };
      window.speechSynthesis.speak(utterance);
    });
  }
  function clearRestart() { if (restartTimer) window.clearTimeout(restartTimer); restartTimer = null; }
  function scheduleRestart() {
    clearRestart();
    if (!continuous || speaking || handling || !Recognition) return;
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (!continuous || speaking || handling || listening) return;
      recognition = createRecognition();
      try { recognition.start(); } catch { scheduleRestart(); }
    }, 300);
  }
  function stopListening() {
    clearRestart();
    if (recognition) { try { recognition.stop(); } catch {} }
    listening = false;
    toggle.classList.remove('is-listening');
    toggle.setAttribute('aria-pressed', 'false');
  }
  function stopAll() {
    continuous = false;
    window.speechSynthesis?.cancel();
    if (nativeAudio) { try { nativeAudio.pause(); } catch {} }
    speaking = false;
    stopNativeListening();
    stopListening();
  }

  function pcm16Base64(chunks, sourceRate) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const source = new Float32Array(total);
    let offset = 0;
    chunks.forEach(chunk => { source.set(chunk, offset); offset += chunk.length; });
    const ratio = sourceRate / 16000;
    const length = Math.max(1, Math.floor(source.length / ratio));
    const bytes = new Uint8Array(length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < length; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(left + 1, source.length - 1);
      const fraction = position - left;
      const sample = Math.max(-1, Math.min(1, source[left] * (1 - fraction) + source[right] * fraction));
      view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }
  async function transcribeNative(chunks, sourceRate) {
    if (nativeTranscribing || !chunks.length || !window.studyflowDesktop?.transcribeVoice) return;
    nativeTranscribing = true;
    setStatus('กำลังถอดเสียงด้วยระบบเสียงของ Athena…');
    try {
      const result = await window.studyflowDesktop.transcribeVoice(pcm16Base64(chunks, sourceRate));
      if (!result?.ok) throw new Error(result?.message || 'ถอดเสียงไม่สำเร็จ');
      if (result.text?.trim()) await handleFinal(result.text.trim());
      else setStatus('ยังฟังคำสั่งไม่ชัด ลองพูดใหม่อีกครั้ง', 'error');
    } catch (error) {
      setStatus(error?.message || 'ถอดเสียงไม่สำเร็จ', 'error');
      notify(error?.message || 'ถอดเสียงไม่สำเร็จ');
    } finally {
      nativeTranscribing = false;
      if (continuous && !speaking && !nativeStream) startNativeListening();
    }
  }
  async function startNativeListening() {
    if (!nativeCapabilities.whisper || !window.studyflowDesktop?.transcribeVoice) return false;
    try {
      nativeStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      nativeAudioContext = new AudioContext();
      nativeSampleRate = nativeAudioContext.sampleRate;
      const source = nativeAudioContext.createMediaStreamSource(nativeStream);
      nativeProcessor = nativeAudioContext.createScriptProcessor(4096, 1, 1);
      nativeChunks = []; nativeSawSpeech = false; nativeLastVoiceAt = 0;
      nativeProcessor.onaudioprocess = event => {
        if (!continuous || !nativeStream) return;
        const data = new Float32Array(event.inputBuffer.getChannelData(0));
        let energy = 0;
        for (const sample of data) energy += sample * sample;
        const rms = Math.sqrt(energy / Math.max(1, data.length));
        nativeChunks.push(data);
        const now = performance.now();
        if (rms > 0.014) { nativeSawSpeech = true; nativeLastVoiceAt = now; }
        if (!nativeSawSpeech && nativeChunks.length > 35) nativeChunks.splice(0, nativeChunks.length - 10);
        if (nativeSawSpeech && now - nativeLastVoiceAt > 850 && !nativeTranscribing) {
          const utterance = nativeChunks;
          nativeChunks = [];
          nativeSawSpeech = false;
          transcribeNative(utterance, nativeSampleRate);
        }
      };
      source.connect(nativeProcessor); nativeProcessor.connect(nativeAudioContext.destination);
      listening = true; toggle.classList.add('is-listening'); toggle.setAttribute('aria-pressed', 'true');
      setStatus(nativeCapabilities.charon ? 'กำลังฟังต่อเนื่องด้วย Athena… พูดคำสั่งได้เลย' : 'กำลังฟังด้วยระบบเสียงของ Athena… พูดคำสั่งได้เลย', 'success');
      setBrowserFallback(false);
      return true;
    } catch (error) {
      stopNativeListening();
      setStatus(error?.message || 'ขอสิทธิ์ใช้ไมโครโฟนใน Desktop ไม่สำเร็จ', 'error');
      return false;
    }
  }
  function stopNativeListening() {
    if (nativeProcessor) { try { nativeProcessor.disconnect(); } catch {} nativeProcessor = null; }
    if (nativeAudioContext) { try { nativeAudioContext.close(); } catch {} nativeAudioContext = null; }
    nativeStream?.getTracks?.().forEach(track => track.stop());
    nativeStream = null; nativeChunks = []; nativeSawSpeech = false; nativeTranscribing = false;
    listening = false; toggle.classList.remove('is-listening'); toggle.setAttribute('aria-pressed', 'false');
  }
  function mimeFor(name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    return ({ pdf:'application/pdf', ppt:'application/vnd.ms-powerpoint', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' })[ext] || 'application/octet-stream';
  }
  function bytesFromBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async function putFileInStudyPicker(file) {
    const input = document.querySelector('#study-file-input');
    if (!input) throw new Error('กรุณาเปิดหน้าห้องติวก่อนสั่งให้อัปโหลดไฟล์');
    if (!window.studyflowDesktop?.loadStudyFileFromPath) throw new Error('คำสั่งเลือกไฟล์ด้วยเสียงใช้ได้ในโปรแกรม Desktop เท่านั้น');
    const loaded = await window.studyflowDesktop.loadStudyFileFromPath(file);
    if (!loaded?.ok || !loaded.file) throw new Error(loaded?.message || 'อ่านไฟล์จากเสียงไม่สำเร็จ');
    const source = loaded.file;
    const blob = new File([bytesFromBase64(source.data)], source.name, { type: mimeFor(source.name), lastModified: Date.now() });
    const transfer = new DataTransfer();
    transfer.items.add(blob);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    window.studyflowLastStudyFile = null;
    return source;
  }
  function openView(name) {
    const button = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (!button) throw new Error(`ไม่พบหน้า${name}`);
    button.click();
  }
  async function waitFor(selector, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const node = document.querySelector(selector);
      if (node) return node;
      await sleep(100);
    }
    return null;
  }
  function sendToAthena(message, search = false) {
    const toggleChat = document.querySelector('#athena-chat-toggle');
    if (!toggleChat) throw new Error('Athena พร้อมใช้งานเฉพาะเมื่อเปิดหน้าห้องติว');
    const panelChat = document.querySelector('#athena-chat-panel');
    if (panelChat?.hidden) toggleChat.click();
    const input = document.querySelector('#athena-chat-input');
    const web = document.querySelector('#athena-web-search');
    if (!input) throw new Error('ไม่พบช่องสนทนา Athena');
    if (web) web.checked = search;
    window.studyflowVoiceAwaitingAthena = true;
    input.value = message;
    document.querySelector('#athena-chat-form')?.requestSubmit();
  }
  async function openClassroom(courseQuery = '') {
    openView('classroom');
   if (!courseQuery) return 'เปิดศูนย์ห้องเรียนให้แล้วครับ';
    const grid = await waitFor('.classroom-course-grid', 8000);
   if (!grid) return 'เปิดศูนย์ห้องเรียนให้แล้ว แต่รายวิชายังโหลดไม่เสร็จ';
    const card = [...grid.querySelectorAll('[data-classroom-course-index]')].find(node => normalize(node.textContent).toLowerCase().includes(courseQuery.toLowerCase()));
   if (!card) return `เปิดศูนย์ห้องเรียนให้แล้ว แต่ยังไม่พบวิชา ${courseQuery}`;
    card.click();
   return `เปิดห้องเรียนวิชา ${courseQuery} ให้แล้วครับ`;
  }
  async function openWorkCalendar(andPlan = false, routine = '') {
    openView('calendar');
    await sleep(140);
    document.querySelector('[data-calendar="work"]')?.click();
    await sleep(160);
     if (!andPlan) return 'เปิดปฏิทินการทำงานให้แล้วครับ';
    const input = document.querySelector('#routine-input');
    if (input && routine) input.value = routine;
    const planner = document.querySelector('#generate-plan');
     if (!planner) return 'เปิดปฏิทินการทำงานให้แล้ว แต่ยังไม่พบปุ่มจัดแผน';
    planner.click();
     return routine || input?.value.trim() ? 'เปิดปฏิทินการทำงานและจัดแผนใหม่ให้แล้วครับ' : 'เปิดปฏิทินการทำงานให้แล้วครับ บอกกิจวัตรของคุณก่อน แล้วฉันจะช่วยจัดแผนให้ครับ';
  }
  async function runVoiceCommand(raw) {
    const text = normalize(raw);
    if (!text) return '';
    transcript.textContent = text;
    setStatus('กำลังทำตามคำสั่ง…');
    if (/^(หยุด|ยกเลิก|cancel|stop|ปิดโหมดเสียง)/i.test(text)) { continuous = false; stopListening(); return 'ปิดโหมดสั่งงานด้วยเสียงแล้ว'; }
    if (/วันนี้(?:คือ)?วันอะไร|วันที่เท่าไหร่|วันอะไรวันนี้/i.test(text)) return `วันนี้คือ ${pageDate()}`;
    if (/เปิดปฏิทินการทำงาน|ปฏิทินการทำงาน|บริหารปฏิทิน|จัดการปฏิทิน|จัดตารางการทำงาน/i.test(text)) {
      const routine = text.match(/(?:ด้วยกิจวัตร|กิจวัตร|ตารางชีวิต)\s*(.+)$/i)?.[1]?.trim() || '';
      return openWorkCalendar(/จัด|วางแผน|บริหาร|ปรับ/.test(text), routine);
    }
     if (/เปิด\s*(?:ปฏิทิน|ปฏิธิน|ปะติทิน)|ไป\s*(?:ปฏิทิน|ปฏิธิน|ปะติทิน)|จัดตาราง/i.test(text)) { openView('calendar'); return 'เปิดปฏิทินให้แล้วครับ'; }
    if (/เข้าคลาสรูม|ไปคลาสรูม|เปิดคลาสรูม|เข้าห้องเรียน|เปิดห้องเรียน|ไปห้องเรียน|ศูนย์ห้องเรียน|ชั้นเรียน/i.test(text)) {
      const course = text.replace(/.*?(?:คลาสรูม|ห้องเรียน|ชั้นเรียน)\s*/i, '').replace(/^(?:วิชา|ชื่อ)\s*/i, '').trim();
      return openClassroom(course && !/^(ทั้งหมด|ทุกวิชา)$/i.test(course) ? course : '');
    }
     if (/เปิดห้องติว|ไปห้องติว|ห้องติว/i.test(text)) { openView('study'); return 'เปิดห้องติวให้แล้วครับ'; }
     if (/เปิดตั้งค่า|ไปตั้งค่า|ตั้งค่า/i.test(text)) { openView('settings'); return 'เปิดหน้าตั้งค่าให้แล้วครับ'; }
     if (/เปิดงานทั้งหมด|ไปหน้างาน|แสดงงานทั้งหมด/i.test(text)) { openView('tasks'); return 'เปิดหน้างานทั้งหมดให้แล้วครับ'; }
     if (/เริ่มโฟกัส|โหมดโฟกัส/i.test(text)) { document.querySelector('#start-focus')?.click(); return 'เริ่มโหมดโฟกัสให้แล้ว ตั้งใจทำทีละก้าวได้เลย'; }
     if (/ซิงก์|รีเฟรชข้อมูล|อัปเดตข้อมูล/i.test(text)) { document.dispatchEvent(new CustomEvent('studyflow:sync')); return 'กำลังซิงก์ข้อมูลล่าสุดให้แล้วครับ'; }
    const taskMatch = text.match(/(?:เปิด|ดู)(?:รายละเอียด)?งาน\s+(.+)/i);
    if (taskMatch) {
      const query = normalize(taskMatch[1]).toLowerCase();
      const row = [...document.querySelectorAll('.task-row')].find(node => normalize(node.textContent).toLowerCase().includes(query));
      if (row) { row.querySelector('.task-detail-btn')?.click(); return `เปิดรายละเอียดงาน ${taskMatch[1]} แล้ว`; }
      return `ไม่พบงานชื่อ ${taskMatch[1]}`;
    }
    const uploadPhrase = text.split(/\s+(?:แล้ว|จากนั้น)\s+/i)[0].trim();
    const uploadMatch = uploadPhrase.match(/(?:อัปโหลด|อัพโหลด|โหลด|เปิดไฟล์)\s*(?:ไฟล์)?\s*(?:pdf|pptx?|docx?|txt)?\s*(?:ชื่อ\s*)?(.+?)(?:\s+จาก(?:โฟลเดอร์)?\s+(.+))?$/i);
    const wantsQuiz = /ข้อสอบ|quiz/i.test(text), wantsFlash = /แฟลชการ์ด|flashcard/i.test(text), wantsSummary = /สรุป|summary/i.test(text);
    if (uploadMatch && /อัปโหลด|อัพโหลด|โหลด|เปิดไฟล์/i.test(text)) {
      const filePath = uploadMatch[2] ? `${normalize(uploadMatch[2])}\\${normalize(uploadMatch[1])}` : normalize(uploadMatch[1]);
      const source = await putFileInStudyPicker(filePath);
      const action = wantsQuiz ? 'quiz' : wantsFlash ? 'flashcards' : 'summary';
      if (wantsSummary || wantsQuiz || wantsFlash) { await sleep(120); window.generateFileStudy?.(action); }
       return `เลือกไฟล์ ${source.name} ให้แล้ว${wantsQuiz || wantsFlash || wantsSummary ? ' และเริ่มประมวลผลให้' : ''}`;
    }
    if (wantsQuiz || wantsFlash || wantsSummary) {
      if (!document.querySelector('#study-file-input')?.files?.[0]) throw new Error('ยังไม่มีไฟล์ในห้องติว กรุณาอัปโหลดไฟล์ก่อน');
      window.generateFileStudy?.(wantsQuiz ? 'quiz' : wantsFlash ? 'flashcards' : 'summary');
       return `เริ่ม${wantsQuiz ? 'สร้างข้อสอบ' : wantsFlash ? 'สร้างแฟลชการ์ด' : 'สรุปเนื้อหา'}จากไฟล์ที่เลือกให้แล้วนะ`;
    }
    if (/อ่านสรุป|อ่านเนื้อหา|อ่านข้อความ/i.test(text)) {
      const body = document.querySelector('#study-result .result-body')?.textContent || document.querySelector('#study-result')?.textContent;
      return body ? body.slice(0, 700) : 'ยังไม่มีเนื้อหาสำหรับอ่าน';
    }
    if (/หาข้อมูล|ถาม Athena|ถามเอเธน่า|ค้นเว็บ|ค้นหา/i.test(text)) {
      const message = text.replace(/^(ช่วย)?\s*(หาข้อมูล|ถาม Athena|ถามเอเธน่า|ค้นเว็บ|ค้นหา)\s*/i, '').trim() || text;
      sendToAthena(message, /ค้นเว็บ|หาข้อมูล|ค้นหา/i.test(text));
      setStatus('ส่งคำถามให้ Athena แล้ว รอคำตอบด้วยเสียง…');
      return 'ส่งคำถามให้ Athena แล้ว';
    }
    throw new Error('ยังจับคำสั่งไม่ชัดครับ ลองพูดว่า “เปิดปฏิทินการทำงาน” หรือ “เข้าคลาสรูม วิชาชีวะ”');
  }
  async function handleFinal(text) {
    if (handling) return;
    handling = true;
    try {
      const response = await runVoiceCommand(text);
      if (response && !window.studyflowVoiceAwaitingAthena) { setStatus(response, 'success'); await speak(response); }
    } catch (error) {
      setStatus(error?.message || 'ทำคำสั่งไม่สำเร็จ', 'error');
      notify(error?.message || 'ทำคำสั่งไม่สำเร็จ');
      await speak(error?.message || 'ทำคำสั่งไม่สำเร็จ');
    } finally {
      handling = false;
      if (continuous && !speaking) {
        if (nativeCapabilities.whisper && !nativeStream) startNativeListening();
        else if (!nativeCapabilities.whisper) scheduleRestart();
      }
    }
  }
  function createRecognition() {
    if (!Recognition) return null;
    const instance = new Recognition();
    instance.lang = 'th-TH'; instance.continuous = false; instance.interimResults = true; instance.maxAlternatives = 1;
    instance.onstart = () => { listening = true; toggle.classList.add('is-listening'); toggle.setAttribute('aria-pressed', 'true'); setStatus('กำลังฟังต่อเนื่อง… พูดคำสั่งได้เลย'); };
    instance.onresult = event => { const text = [...event.results].map(result => result[0]?.transcript || '').join(''); transcript.textContent = text || 'กำลังฟัง…'; if (event.results[event.results.length - 1].isFinal) handleFinal(text); };
    instance.onerror = event => {
      if (event.error === 'not-allowed') { continuous = false; setBrowserFallback(false); setStatus('ยังไม่ได้รับสิทธิ์ใช้ไมโครโฟน กรุณาอนุญาตในหน้าต่างแอป', 'error'); }
      else if (event.error === 'network') { continuous = false; setBrowserFallback(true); setStatus('บริการรู้จำเสียงของ Electron ใช้งานไม่ได้ จึงไม่ใช่ปัญหาที่ไมโครโฟนของคุณ', 'error'); }
      else setStatus(`ไมโครโฟนไม่พร้อม: ${event.error}`, 'error');
      stopListening();
    };
    instance.onend = () => { listening = false; toggle.classList.remove('is-listening'); toggle.setAttribute('aria-pressed', 'false'); if (continuous && !handling && !speaking) scheduleRestart(); };
    return instance;
  }
  async function startListening() {
    if (nativeCapabilities.whisper) {
      const started = await startNativeListening();
      if (started) return;
    }
    if (!Recognition) { setStatus('Electron รุ่นนี้ไม่มีบริการรู้จำเสียงในตัว ให้เปิดโหมดเสียงใน Chrome/Edge', 'error'); setBrowserFallback(true); return; }
    recognition = createRecognition();
    try { recognition.start(); } catch (error) { setStatus(error?.message || 'เริ่มไมโครโฟนไม่สำเร็จ', 'error'); scheduleRestart(); }
  }
  toggle.addEventListener('click', () => {
    setPanel(true);
    if (continuous) { stopAll(); setStatus('ปิดโหมดสั่งงานต่อเนื่องแล้ว'); return; }
    continuous = true; setBrowserFallback(false); startListening();
  });
  close?.addEventListener('click', () => { stopAll(); setPanel(false); });
  browserFallback?.addEventListener('click', async () => {
    const result = await window.studyflowDesktop?.openVoiceBrowser?.(window.location.origin);
    if (result?.ok) setStatus('เปิด StudyFlow ใน Chrome/Edge แล้ว ให้กดปุ่มเสียงในหน้าต่างใหม่', 'success');
    else setStatus(result?.message || 'เปิดโหมดเสียงสำรองไม่สำเร็จ', 'error');
  });
  const athenaObserver = new MutationObserver(() => {
    if (!window.studyflowVoiceAwaitingAthena) return;
    const log = document.querySelector('#athena-chat-log');
    if (log?.querySelector('.athena-message.is-pending')) return;
    const reply = normalize([... (log?.querySelectorAll('.athena-message.bot') || [])].at(-1)?.textContent || '');
    if (!reply || reply === lastAthenaReply) return;
    lastAthenaReply = reply; window.studyflowVoiceAwaitingAthena = false;
    setStatus('Athena ตอบแล้ว กำลังอ่านคำตอบให้ฟัง', 'success'); speak(reply);
  });
  athenaObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.studyflowVoice = { run: handleFinal, stop: stopAll, open: () => setPanel(true), speak };
  window.studyflowDesktop?.getVoiceCapabilities?.().then(capabilities => {
    nativeCapabilities = { ...nativeCapabilities, ...(capabilities || {}) };
    if (nativeCapabilities.whisper) setStatus(nativeCapabilities.charon ? 'พร้อมใช้เสียง Athena ใน Desktop' : 'พร้อมรับเสียงใน Desktop · ตั้ง Gemini key เพื่อใช้เสียง Charon');
  }).catch(() => {});
})();
