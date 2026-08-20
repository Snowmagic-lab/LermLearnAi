import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { PDFParse } from 'pdf-parse';
const root = fileURLToPath(new URL('.', import.meta.url));
const defaultDataRoot = process.platform === 'win32' && process.env.APPDATA
  ? join(process.env.APPDATA, 'studyflow')
  : join(homedir(), '.studyflow');
const dataRoot = process.env.STUDYFLOW_DATA_DIR || defaultDataRoot;
const port = Number(process.env.PORT || 4173);
let activePort = port;
const tokenPath = join(dataRoot, 'google-token.json');
const oauthRequests = new Map();
let oauthLastError = null;
const demoCourses = [];
// OAuth client IDs identify the app and are safe to ship in a desktop build.
// Secrets and provider API keys must remain outside the installer.
const bundledGoogleClientId = '658472864580-mp1kghp3n1i2p9mtojocmaf36v5q9uus.apps.googleusercontent.com';

async function loadEnv(){for(const envPath of [join(dataRoot,'.env.local'),join(root,'.env.local')]){try{const text=await readFile(envPath,'utf8');for(const line of text.split(/\r?\n/)){const m=line.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'')}}catch{}}}
async function readToken(){try{return JSON.parse(await readFile(tokenPath,'utf8'))}catch{return null}}
async function saveToken(token){await mkdir(dataRoot,{recursive:true});await writeFile(tokenPath,JSON.stringify(token,null,2),'utf8')}
await loadEnv();
await mkdir(dataRoot,{recursive:true});
const json=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload))};
const redirect=(res,url)=>{res.writeHead(302,{Location:url});res.end()};
const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return raw?JSON.parse(raw):{}};
const b64url=value=>Buffer.from(value).toString('base64url');
function oauthConfig(){
  const configured=String(process.env.GOOGLE_REDIRECT_URI||'').trim();
  let redirectUri=configured||`http://127.0.0.1:${activePort}/oauth/callback`;
  // A desktop build may move to a nearby free port when the default port is
  // already occupied. Keep localhost callbacks aligned with the live server.
  try{
    const parsed=new URL(redirectUri);
    if(['127.0.0.1','localhost'].includes(parsed.hostname)&&parsed.pathname==='/oauth/callback')redirectUri=`http://127.0.0.1:${activePort}/oauth/callback`;
  }catch{redirectUri=`http://127.0.0.1:${activePort}/oauth/callback`}
  return{clientId:process.env.GOOGLE_CLIENT_ID||bundledGoogleClientId,redirectUri};
}
function googleScopes(){return['openid','email','profile','https://www.googleapis.com/auth/classroom.courses.readonly','https://www.googleapis.com/auth/classroom.coursework.me','https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly','https://www.googleapis.com/auth/classroom.announcements.readonly','https://www.googleapis.com/auth/classroom.topics.readonly','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/calendar.events.readonly'].join(' ')}
async function refreshToken(token){if(!token?.refresh_token||!token.expires_at||Date.now()<token.expires_at-60000)return token;const cfg=oauthConfig();const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:cfg.clientId,grant_type:'refresh_token',refresh_token:token.refresh_token})});if(!r.ok)throw new Error(`Google token refresh ${r.status}`);const next=await r.json();const updated={...token,...next,expires_at:Date.now()+Number(next.expires_in||3600)*1000};await saveToken(updated);return updated}
const classroomContentCache=new Map();
const waitMs=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function googleFetch(url,token){const fresh=await refreshToken(token);for(let attempt=0;attempt<3;attempt++){const r=await fetch(url,{headers:{Authorization:`Bearer ${fresh.access_token}`}});if(r.ok)return r.json();const detail=await r.text();const parsed=(()=>{try{return JSON.parse(detail)}catch{return{}}})();const message=parsed.error?.message||parsed.error?.status||detail.slice(0,180);if((r.status===429||r.status>=500)&&attempt<2){const retryAfter=Number(r.headers.get('retry-after')||0);await waitMs(Math.min(3000,retryAfter>0?retryAfter*1000:500*(attempt+1)));continue}throw new Error(`Google API ${r.status}: ${message}`)}}
async function googleApi(path,token){return googleFetch(`https://classroom.googleapis.com/v1/${path}`,token)}
async function getCourses(token){const data=await googleApi('courses?courseStates=ACTIVE&pageSize=100',token);const courses=[];for(const course of data.courses||[]){let topics=[];try{const topicData=await googleApi(`courses/${course.id}/topics?pageSize=100`,token);topics=(topicData.topic||[]).map(x=>x.name)}catch{};try{const work=await googleApi(`courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,token);topics.push(...(work.courseWork||[]).map(x=>x.title).filter(Boolean))}catch{};courses.push({id:String(course.id),name:course.name,teacher:'Google Classroom',subjects:[{id:String(course.id),name:course.name,topics:[...new Set(topics)].slice(0,20)}]})}return courses}
async function getClassroomTasks(token){const courseData=await googleApi('courses?courseStates=ACTIVE&pageSize=100',token);const candidates=[];for(const course of courseData.courses||[]){try{const work=await googleApi(`courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,token);for(const item of work.courseWork||[])candidates.push({course,item})}catch{}}const weekStart=new Date();weekStart.setHours(0,0,0,0);weekStart.setDate(weekStart.getDate()-((weekStart.getDay()+6)%7));const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+7);const tasks=[];for(let i=0;i<candidates.length;i+=8){const batch=await Promise.all(candidates.slice(i,i+8).map(async({course,item})=>{let state='NEW',submittedAt=null;try{const submission=await googleApi(`courses/${course.id}/courseWork/${item.id}/studentSubmissions?userId=me&pageSize=10`,token);const record=submission.studentSubmissions?.[0];state=record?.state||'NEW';submittedAt=record?.updateTime||null}catch{}const done=['TURNED_IN','RETURNED'].includes(state);if(done){const submittedDate=submittedAt?new Date(submittedAt):null;if(!submittedDate||submittedDate<weekStart||submittedDate>=weekEnd)return null}else{const dueAt=item.dueDate?new Date(Date.UTC(item.dueDate.year,item.dueDate.month-1,item.dueDate.day,item.dueTime?.hours||0,item.dueTime?.minutes||0)):null;if(dueAt&&dueAt<weekStart)return null}const dueAt=item.dueDate?Date.UTC(item.dueDate.year,item.dueDate.month-1,item.dueDate.day,item.dueTime?.hours||0,item.dueTime?.minutes||0):null;const due=dueAt?new Date(dueAt).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'}):'ยังไม่กำหนด';return{id:String(item.id),title:item.title||'งานจาก Google Classroom',meta:`${course.name} · Google Classroom`,tag:course.name,type:'bio-tag',deadline:due,done,submittedAt,link:item.alternateLink||null}}));tasks.push(...batch.filter(Boolean))}return tasks}
const MAX_STUDY_CONTEXT_CHARS=24000;
const MAX_STUDY_FILE_BYTES=50*1024*1024;
const studyProgress=new Map();
const studyResultCache=new Map();
const studyVariationHistory=new Map();
function setStudyProgress(id,patch){if(!id)return;const key=String(id),current=studyProgress.get(key)||{id:key,percent:0,status:'starting',message:'กำลังเตรียมไฟล์…',detail:''};studyProgress.set(key,{...current,...patch,id:key,updatedAt:Date.now()})}
function getStudyProgress(id){const key=String(id||'');const item=studyProgress.get(key);if(item&&Date.now()-Number(item.updatedAt||0)>15*60*1000){studyProgress.delete(key);return null}return item||null}
const truncateStudyText=(value,max=MAX_STUDY_CONTEXT_CHARS)=>{const text=String(value||'').trim();return text.length>max?`${text.slice(0,max)}\n[ตัดข้อความส่วนเกินเพื่อความปลอดภัยและความเร็ว]`:text};
const thaiToday=()=>new Intl.DateTimeFormat('th-TH',{dateStyle:'full',timeZone:'Asia/Bangkok'}).format(new Date());
const cleanBase64=value=>String(value||'').replace(/^data:[^,]+,/,'').replace(/\s/g,'');
const legacyThaiGlyphs={'\uf702':'ี','\uf705':'่','\uf706':'้','\uf70a':'่','\uf70b':'้','\uf70e':'์','\uf710':'ั','\uf712':'็'};
function normalizeExtractedStudyText(value){return String(value||'').replace(/[\uf702\uf705\uf706\uf70a\uf70b\uf70e\uf710\uf712]/g,character=>legacyThaiGlyphs[character]||character).normalize('NFC').replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim()}
async function extractPdfTextLocally(buffer){let parser;try{parser=new PDFParse({data:buffer});const result=await parser.getText();return normalizeExtractedStudyText(result?.text||'')}catch{return ''}finally{try{await parser?.destroy()}catch{}}}
function extractOfficeTextLocally(buffer,mime){return new Promise(resolve=>{if(!['application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime))return resolve('');const script="import io,sys,zipfile,re,html\nsys.stdout.reconfigure(encoding='utf-8')\ndata=sys.stdin.buffer.read()\nwith zipfile.ZipFile(io.BytesIO(data)) as z:\n names=[n for n in z.namelist() if (n.startswith('ppt/slides/slide') or n.startswith('ppt/notesSlides/notesSlide') or n in ('word/document.xml','word/footnotes.xml','word/endnotes.xml')) and n.endswith('.xml')]\n names.sort()\n out=[]\n for n in names:\n  raw=z.read(n).decode('utf-8','ignore')\n  raw=re.sub(r'<w:tab[^>]*/>', ' ', raw)\n  raw=re.sub(r'</(?:a:p|w:p)>', '\\n', raw)\n  raw=re.sub(r'<[^>]+>', '', raw)\n  text=html.unescape(raw).strip()\n  if text: out.append(text)\n print('\\n\\n'.join(out))";let output='';let child;try{child=spawn(process.platform==='win32'?'python':'python3',['-c',script],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}})}catch{return resolve('')}child.stdout.on('data',chunk=>{if(output.length<220000)output+=chunk.toString('utf8')});const timer=setTimeout(()=>{try{child.kill()}catch{}resolve('')},15000);child.on('error',()=>{clearTimeout(timer);resolve('')});child.on('close',code=>{clearTimeout(timer);resolve(code===0?normalizeExtractedStudyText(output):'')});child.stdin.end(buffer)})}
const studyExtractionCache=new Map();
async function extractStudyTextCached(buffer,mime){
  if(!['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime))return '';
  const cacheKey=createHash('sha1').update(mime).update(buffer).digest('hex');
  if(studyExtractionCache.has(cacheKey))return studyExtractionCache.get(cacheKey);
  const text=mime==='application/pdf'?await extractPdfTextLocally(buffer):await extractOfficeTextLocally(buffer,mime);
  studyExtractionCache.set(cacheKey,text);
  if(studyExtractionCache.size>8)studyExtractionCache.delete(studyExtractionCache.keys().next().value);
  return text;
}
const aiMeta=(result,input)=>({...result,action:input.action||'summary',sources:Array.isArray(input.sources)?input.sources:[],contextAvailable:Boolean(input.contextAvailable||input.fileData||(input.fileParts||[]).length)});
function tutorPrompt(input){
  const settings=input.studySettings||{},depth=settings.depth||'standard',difficulty=settings.difficulty||'medium',count=Math.max(1,Math.min(50,Number(settings.count)|| (input.action==='quiz'?10:input.action==='flashcards'?12:1))),time=settings.time?`${Number(settings.time)} นาที`:'ไม่ได้กำหนดเวลา',preference=String(settings.preference||'').trim();
  const kind=input.action==='quiz'?`ข้อสอบจำนวน ${count} ข้อพร้อมตัวเลือกและเฉลย`:input.action==='flashcards'?`แฟลชการ์ดจำนวน ${count} ใบพร้อมคำอธิบาย` : input.action==='chat'?'คำตอบสำหรับคำถามของผู้ใช้':'สรุปเนื้อหาแบบเข้าใจง่ายพร้อมหัวข้อสำคัญ';
  const difficultyRule=difficulty==='easy'?'ง่าย: ถามความจำและการระบุข้อมูลตรงจากเอกสาร':difficulty==='hard'?'ยาก: ต้องใช้การวิเคราะห์ความสัมพันธ์ เหตุผล ลำดับขั้น หรือสถานการณ์ประยุกต์จากข้อมูลในเอกสาร ตัวเลือกต้องใกล้เคียงกันแต่มีคำตอบที่ถูกเพียงหนึ่งเดียว ห้ามใช้คำถามจำคำนิยามตรง ๆ':'ปานกลาง: ให้เชื่อมโยงข้อมูลอย่างน้อยสองส่วนหรืออธิบายเหตุและผล ไม่ใช่การคัดลอกหัวข้ออย่างเดียว';
  const source=truncateStudyText(input.referenceContent||input.classroomContext);
  const sourceLabel=input.referenceContent?'เนื้อหาที่อ่านจากไฟล์และสรุปไว้ก่อนหน้านี้':'ข้อมูลจากไฟล์/แหล่งเรียนรู้ที่ผู้ใช้แนบ';
  const sourceBlock=source?`${sourceLabel}:\n---\n${source}\n---`:'ยังไม่มีข้อความจากไฟล์ที่อ่านได้';
  const strict=input.forceStrict?'ห้ามมีข้อความเกริ่นนำหรือบทสรุปนอกแม่แบบโดยเด็ดขาด\n':'';
  const formatRule=input.action==='quiz'?`ห้ามสรุปแทนข้อสอบ ใช้เฉพาะข้อมูลที่ยืนยันได้จากแหล่งข้อมูลด้านล่าง สร้างไม่เกิน ${count} ข้อ (ถ้าอ่านได้ไม่พอให้สร้างเท่าที่มีและบอกจำนวนที่ทำได้) แต่ละข้อห้ามซ้ำกัน และต้องมีตัวเลือกครบ 4 ตัวเลือกที่แตกต่างกันเสมอ: ก) ข) ค) ง) ห้ามส่งเพียง 2 ตัวเลือก ใช้แม่แบบ: "ข้อ n. คำถาม" แล้วตามด้วย "ระดับความยาก: ${difficulty}", ตัวเลือก ก) ข) ค) ง), "เฉลย: ...", "เหตุผล: ..." และ "แหล่งอ้างอิง: ..." โดยแหล่งอ้างอิงต้องคัดข้อความจริงแบบคำต่อคำอย่างน้อย 12 ตัวอักษรจากประโยคหรือหัวข้อในแหล่งข้อมูล ห้ามถอดความและห้ามสร้างเลขหน้า ถ้าไม่มีเลขหน้าให้ใช้คำว่า "ตำแหน่งในข้อความที่อ่านได้: ..." ระดับความยากที่ต้องใช้คือ ${difficultyRule} ระดับความลึก ${depth} และเวลาทำรวม ${time}`:input.action==='flashcards'?`ห้ามสรุปเป็นย่อหน้า ใช้เฉพาะข้อมูลที่ยืนยันได้จากแหล่งข้อมูลด้านล่าง สร้างไม่เกิน ${count} ใบ (ถ้าอ่านได้ไม่พอให้สร้างเท่าที่มีและบอกจำนวนที่ทำได้) แต่ละใบต้องไม่ซ้ำ ใช้แม่แบบ: "แฟลชการ์ด n" ต่อด้วย "ด้านหน้า: ...", "ระดับความยาก: ${difficulty}", "ด้านหลัง: ...", "เหตุผล/คำอธิบาย: ..." และ "แหล่งอ้างอิง: ..." โดยแหล่งอ้างอิงต้องคัดข้อความจริงแบบคำต่อคำอย่างน้อย 12 ตัวอักษรจากประโยคหรือหัวข้อในแหล่งข้อมูล ห้ามถอดความและห้ามสร้างเลขหน้า ถ้าไม่มีเลขหน้าให้ใช้คำว่า "ตำแหน่งในข้อความที่อ่านได้: ..." ระดับความยากที่ต้องใช้คือ ${difficultyRule} และระดับความลึก ${depth}`:input.action==='chat'?`ตอบคำถามของผู้ใช้โดยใช้ไฟล์เป็นบริบทหลัก หากไฟล์ไม่มีคำตอบ ให้ตอบจากความรู้ทั่วไปของโมเดลได้ และบอกชัดเจนว่าส่วนใดเป็นความรู้เพิ่มเติมนอกไฟล์ วันที่ปัจจุบันของระบบคือ ${thaiToday()} ห้ามตอบวันที่จากความจำเดิม ห้ามอ้างว่าค้นเว็บแบบเรียลไทม์หากไม่ได้ค้นจริง`:'สรุปอย่างละเอียดจากเนื้อหาที่อ่านได้จริง แบ่งเป็นหัวข้อย่อย คำสำคัญ ความสัมพันธ์ ตัวอย่าง และข้อควรจำ ห้ามสร้างข้อสอบหรือแฟลชการ์ด ห้ามใช้แม่แบบ "ข้อ n", "แฟลชการ์ด n", "เฉลย", "ด้านหน้า" หรือ "ด้านหลัง"';
  const avoidItems=Array.isArray(input.avoidItems)?input.avoidItems.map(item=>String(item||'').trim()).filter(Boolean).slice(0,36):[];
  const variationRule=avoidItems.length&&['quiz','flashcards'].includes(input.action)?`นี่เป็นชุดใหม่ ห้ามคัดลอกคำถามหรือด้านหน้าต่อไปนี้แบบเดิมจาก 3 ชุดล่าสุด: ${avoidItems.map((item,index)=>`${index+1}) ${item}`).join(' | ')} ให้เปลี่ยนมุมถาม ใช้ประเด็นอื่น หรือเชื่อมโยงเหตุผลจากเอกสารแทน หากเนื้อหามีจำกัดจริง ๆ ให้ยอมซ้ำได้เฉพาะรายการที่เก่าที่สุดหลังพยายามใช้ประเด็นใหม่แล้ว และห้ามซ้ำรายการใดภายในชุดเดียวกัน`:'หากเป็นการสร้างครั้งแรก ให้กระจายคำถามไปยังประเด็นสำคัญหลายส่วนของเอกสาร ห้ามทำซ้ำภายในชุดเดียวกัน';
  return `คุณคือ Athena ติวเตอร์ภาษาไทยสำหรับนักเรียน สร้าง${kind} เรื่อง "${input.topic||'เนื้อหาที่แนบ'}" วิชา ${input.subject||'ไม่ระบุวิชา'} ตอบเป็นภาษาไทย อ่านง่าย มีหัวข้อชัดเจน\nคำถามของผู้ใช้: ${input.message||''}\nความต้องการเพิ่มเติมของผู้ใช้สำหรับการสรุป: ${preference||'ไม่ได้ระบุ ใช้ขอบเขตที่เหมาะสมกับเนื้อหาทั้งหมด'}\n${strict}รูปแบบที่ต้องใช้: ${formatRule}\n${variationRule}\n\n${sourceBlock}\n\nกติกาความถูกต้อง: สำหรับข้อสอบและแฟลชการ์ดให้ยึดเฉพาะข้อมูลในไฟล์ ห้ามแต่งชื่อบท ตัวเลข หรือเนื้อหาที่ไม่มีหลักฐาน หากข้อมูลบางส่วนไม่พอ ให้สร้างเฉพาะส่วนที่ยืนยันได้และบอกข้อจำกัดอย่างตรงไปตรงมา ห้ามเปลี่ยนโหมดข้อสอบหรือแฟลชการ์ดเป็นบทสรุป`;
}
const driveApiEnableUrl='https://console.cloud.google.com/apis/library/drive.googleapis.com?project=gen-lang-client-0900748339';
function unavailableMaterial(meta,message,extra={}){return{title:meta?.name||'ไฟล์จาก Classroom',url:meta?.webViewLink||'',unavailable:message,...extra}}
async function getDriveMaterial(fileId,token){
  const fresh=await refreshToken(token),encoded=encodeURIComponent(fileId);
  let meta;
  try{meta=await googleFetch(`https://www.googleapis.com/drive/v3/files/${encoded}?fields=id,name,mimeType,size,webViewLink`,fresh)}catch(error){
    const message=String(error?.message||'');
    if(/SERVICE_DISABLED|Drive API has not been used|drive\.googleapis\.com/i.test(message))return unavailableMaterial(null,'Google Drive API ยังไม่ได้เปิดในโปรเจกต์ของแอป', {setupUrl:driveApiEnableUrl,providerError:'drive_api_disabled'});
    throw error;
  }
  const mime=meta.mimeType||'application/octet-stream';
  const googleExport={'application/vnd.google-apps.document':'text/plain','application/vnd.google-apps.presentation':'text/plain','application/vnd.google-apps.spreadsheet':'text/csv'}[mime];
  if(googleExport){const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encoded}/export?mimeType=${encodeURIComponent(googleExport)}`,{headers:{Authorization:`Bearer ${fresh.access_token}`}});if(response.ok)return{text:truncateStudyText(await response.text()),title:meta.name||'เอกสารจาก Classroom',url:meta.webViewLink||'',mimeType:googleExport};return unavailableMaterial(meta,`อ่านไฟล์ Google ${mime==='application/vnd.google-apps.presentation'?'สไลด์':mime==='application/vnd.google-apps.document'?'เอกสาร':'ชีต'} ไม่สำเร็จ (${response.status})`,{providerError:`drive_export_${response.status}`})}
  const size=Number(meta.size||0);if(size>MAX_STUDY_FILE_BYTES)return unavailableMaterial(meta,'ไฟล์มีขนาดใหญ่เกิน 50 MB');
  if(/^text\//.test(mime)||['application/json','application/rtf'].includes(mime)){const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encoded}?alt=media`,{headers:{Authorization:`Bearer ${fresh.access_token}`}});if(response.ok)return{text:truncateStudyText(await response.text()),title:meta.name||'เอกสารจาก Classroom',url:meta.webViewLink||'',mimeType:mime};return unavailableMaterial(meta,`ดาวน์โหลดไฟล์ข้อความไม่สำเร็จ (${response.status})`,{providerError:`drive_download_${response.status}`})}
  if(['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword','image/png','image/jpeg','image/webp','image/gif','image/bmp','image/tiff'].includes(mime)){const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encoded}?alt=media`,{headers:{Authorization:`Bearer ${fresh.access_token}`}});if(response.ok){const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length<=MAX_STUDY_FILE_BYTES){if(mime==='application/pdf'){const text=await extractPdfTextLocally(buffer);if(text)return{text:truncateStudyText(text),title:meta.name||'ไฟล์จาก Classroom',url:meta.webViewLink||'',mimeType:'text/plain',localExtracted:true}}if(mime.includes('openxmlformats-officedocument')){const text=await extractOfficeTextLocally(buffer,mime);if(text)return{text:truncateStudyText(text),title:meta.name||'ไฟล์จาก Classroom',url:meta.webViewLink||'',mimeType:'text/plain',localExtracted:true}}return{title:meta.name||'ไฟล์จาก Classroom',url:meta.webViewLink||'',filePart:{mimeType:mime,data:buffer.toString('base64')}}}return unavailableMaterial(meta,'ไฟล์มีขนาดใหญ่เกิน 50 MB')}return unavailableMaterial(meta,`ดาวน์โหลดไฟล์เพื่อให้ AI อ่านไม่สำเร็จ (${response.status})`,{providerError:`drive_download_${response.status}`})}
  return unavailableMaterial(meta,'ชนิดไฟล์นี้ยังอ่านเนื้อหาอัตโนมัติไม่ได้');
}
function isStudyContentItem(item){
  const title=String(item?.title||'');
  const explicitTask=/(จัดทำ|ส่ง|งาน|ใบงาน|แบบฝึกหัด|คะแนน|สอบ|รายงาน|โครงงาน|ชิ้นงาน|กำหนดส่ง)/i.test(title);
  const contentHint=/(สื่อ|เอกสาร|slide|สไลด์|บท|lesson|lecture|เนื้อหา|material|video|คลิป|ใบความรู้|การเรียนรู้|กิจกรรมออนไลน์|กิจกรรมการเรียน)/i.test(title);
  const hasMaterial=Array.isArray(item?.materials)&&item.materials.length>0;
  return !explicitTask && (hasMaterial||!item?.dueDate||contentHint);
}
function extractGoogleDriveId(value){const text=String(value||'');return (text.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/(?:document|presentation|spreadsheets)\/d\/)([a-zA-Z0-9_-]+)/i)||[])[1]||''}
async function collectClassroomStudyContext(courseId,topic,token,focus={}){
  const data=await getClassroomCourseContentFast(courseId,token),needle=String(topic||'').toLowerCase();
  const allWork=data.coursework||[],exactWork=focus.courseWorkId?allWork.filter(item=>String(item.courseWorkId)===String(focus.courseWorkId)):[],topicWork=focus.topicId?allWork.filter(item=>String(item.topicId)===String(focus.topicId)):[],textWork=allWork.filter(item=>`${item.title} ${item.description} ${(item.materials||[]).map(material=>material.driveFile?.driveFile?.title||material.link?.title||material.youtubeVideo?.title||'').join(' ')}`.toLowerCase().includes(needle));
  const selected=exactWork.length?exactWork.slice(0,6):(focus.topicId?topicWork.filter(isStudyContentItem).slice(0,6):textWork.filter(isStudyContentItem).slice(0,6)),lines=[`ห้องเรียน: ${data.course?.name||''}`,`หัวข้อที่ผู้ใช้เลือก: ${topic||''}`,`ขอบเขตแหล่งข้อมูล: เฉพาะโพสต์/ไฟล์ที่ผูกกับหัวข้อนี้เท่านั้น`],sources=[],fileParts=[];
  let readable=false,textReadable=false;
  if(!selected.length)lines.push('ไม่พบสื่อการเรียนรู้ที่อ่านได้ในหัวข้อนี้ จึงไม่ดึงงานหรือโพสต์จากหัวข้ออื่นมารวมแทน');
  for(const item of selected){lines.push(`โพสต์ที่เลือก: ${item.title||''}`);sources.push({title:item.title||'โพสต์จาก Classroom',url:item.alternateLink||'',type:'classroom-post',status:'readable'});if(item.description){lines.push(`รายละเอียดจากโพสต์: ${item.description}`);readable=true;textReadable=true}for(const material of item.materials||[]){const drive=material.driveFile?.driveFile||material.driveFile,linkedId=material.link?.url?extractGoogleDriveId(material.link.url):'',label=drive?.title||material.link?.title||material.youtubeVideo?.title||'ไฟล์แนบจาก Classroom';const fileId=drive?.id||linkedId;if(fileId){try{const extracted=await getDriveMaterial(fileId,token);const source={title:label,url:extracted.url||drive?.alternateLink||material.link?.url||'',type:'classroom-file',status:extracted.unavailable?'unavailable':'readable',setupUrl:extracted.setupUrl||''};sources.push(source);if(extracted.text){lines.push(`เนื้อหาไฟล์ ${label}:\n${extracted.text}`);readable=true;textReadable=true}if(extracted.filePart){fileParts.push(extracted.filePart);lines.push(`ไฟล์ ${label} แนบให้ AI อ่านโดยตรง`);readable=true}if(extracted.unavailable)lines.push(`ไฟล์ ${label}: ${extracted.unavailable}${extracted.setupUrl?` กรุณาเปิด ${extracted.setupUrl}`:''}`)}catch(error){if(/429|quota exceeded/i.test(error.message))throw error;const message=String(error?.message||'ไม่สามารถอ่านไฟล์ได้');sources.push({title:label,url:drive?.alternateLink||material.link?.url||'',type:'classroom-file',status:'unavailable'});lines.push(`ไฟล์ ${label}: ${message}`)}}else if(material.link?.url){sources.push({title:label,url:material.link.url,type:'link',status:'unavailable'});lines.push(`ลิงก์ ${label}: ยังไม่ได้อ่านเนื้อหาปลายทาง จึงไม่สรุปจากลิงก์นี้`)}else if(material.youtubeVideo?.alternateLink){sources.push({title:label,url:material.youtubeVideo.alternateLink,type:'youtube',status:'unavailable'});lines.push(`วิดีโอ ${label}: ยังไม่ได้ถอดเสียง จึงไม่สรุปจากวิดีโอนี้`)}}}
  return{contextText:truncateStudyText(lines.join('\n')),sources,fileParts,course:data.course,readable,readableText:textReadable};
}
async function generateWithOpenAI(input){
  const key=process.env.OPENAI_API_KEY;
  if(!key)return{source:'demo',title:input.topic,content:'ยังไม่ได้ตั้งค่า OPENAI_API_KEY สำหรับโหมด AI จริง'};
  setStudyProgress(input.progressId,{percent:86,status:'processing',message:`กำลังให้ ${process.env.OPENAI_MODEL||'OpenAI'} วิเคราะห์เนื้อหา…`,detail:'โมเดลกำลังสร้างผลลัพธ์จากข้อมูลที่อ่านได้'});
  const prompt=tutorPrompt(input);
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',input:prompt})});
  const body=await r.json().catch(()=>({}));
  if(!r.ok){
    const apiError=body.error||{};
    const quota=apiError.code==='insufficient_quota';
    const rateLimited=r.status===429&&!quota;
    const content=quota
      ?'โควตาหรือเครดิตของ OpenAI API ยังไม่พร้อมใช้งาน\\n\\nวิธีแก้: เปิด https://platform.openai.com/settings/organization/billing เพื่อตั้งค่าการเรียกเก็บเงินหรือเติมเครดิต แล้วลองสร้างสรุปใหม่\\n\\nหมายเหตุ: การสมัคร ChatGPT และเครดิต OpenAI API เป็นคนละส่วนกัน'
      :rateLimited
        ?'ส่งคำขอถึง OpenAI เร็วเกินไป (rate limit)\\n\\nวิธีแก้: รอสักครู่แล้วลองใหม่ หลีกเลี่ยงการกดปุ่มซ้ำหลายครั้ง'
        :`OpenAI ตอบกลับสถานะ ${r.status}: ${apiError.message||'ไม่ทราบสาเหตุ'}`;
    return{source:'fallback',title:input.topic,errorCode:apiError.code||`http_${r.status}`,content};
  }
  return{source:'openai',title:input.topic,content:body.output_text||'ไม่พบคำตอบจาก AI'};
}

async function generateWithDeepSeek(input){
  const key=process.env.DEEPSEEK_API_KEY;
  if(!key)return{source:'missing-config',title:input.topic,errorCode:'deepseek_key_missing',content:'ยังไม่ได้ตั้งค่า DeepSeek API key ในเครื่องนี้'};
  const model=process.env.DEEPSEEK_MODEL||'deepseek-v4-flash';
  const outputLimit=input.action==='summary'?4200:input.action==='chat'?1600:Math.min(8000,Math.max(3600,Number(input.studySettings?.count||10)*520));
  setStudyProgress(input.progressId,{percent:86,status:'processing',message:`กำลังให้ ${model} อ่านและวิเคราะห์เอกสาร…`,detail:'โมเดลกำลังเชื่อมโยงแนวคิดจากข้อความจริงก่อนสร้างผลลัพธ์'});
  const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'คุณเป็นติวเตอร์ที่เคร่งครัดกับหลักฐาน อ่านเอกสารทั้งหมดที่ได้รับก่อนตอบ ใช้เฉพาะข้อมูลในเอกสารสำหรับ Summary, Quiz และ Flashcard ห้ามสร้างข้อมูลเติมเอง ทุกข้อสอบและแฟลชการ์ดต้องตรวจย้อนกลับไปยังข้อความจริงได้ ห้ามใช้ Markdown เช่น #, ** หรือ ``` และต้องตอบตามแม่แบบที่ผู้ใช้กำหนดเท่านั้น'},{role:'user',content:tutorPrompt(input)}],stream:false,thinking:{type:'disabled'},temperature:0.08,max_tokens:outputLimit}),signal:AbortSignal.timeout(90000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){const apiError=body.error||{};const message=String(apiError.message||'ไม่ทราบสาเหตุ');return{source:'fallback',title:input.topic,errorCode:apiError.code||`deepseek_http_${response.status}`,content:response.status===401?'DeepSeek API key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน':response.status===402?'บัญชี DeepSeek มีเครดิตไม่เพียงพอ':response.status===429?'DeepSeek มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่':`DeepSeek ตอบกลับสถานะ ${response.status}: ${message}`}}
  const choice=body.choices?.[0]||{},message=choice.message||{},content=normalizeStudyModelFormatting(message.content||'');
  if(!content){const finishReason=String(choice.finish_reason||'unknown'),reasoningLength=String(message.reasoning_content||'').length;return{source:'fallback',title:input.topic,errorCode:'deepseek_empty_content',content:finishReason==='length'?'DeepSeek ใช้โทเคนที่กำหนดครบก่อนส่งคำตอบสุดท้าย กรุณาลดจำนวนข้อแล้วลองใหม่':'DeepSeek ไม่ส่งคำตอบสุดท้ายกลับมา กรุณาลองใหม่',diagnostics:{finishReason,reasoningLength}}}
  return{source:'deepseek',title:input.topic,content,model,finishReason:String(choice.finish_reason||'stop')};
}

function qwenRequestedCount(input){return Math.max(1,Math.min(50,Number(input.studySettings?.count)||(input.action==='quiz'?10:12)))}
function qwenOutputLimit(input){const count=qwenRequestedCount(input);if(input.action==='summary')return 5000;if(input.action==='chat')return 1800;if(input.action==='quiz')return Math.min(6500,Math.max(3600,count*700));return Math.min(6000,Math.max(3000,count*520))}
async function generateWithQwenSingle(input){
  const key=process.env.QWEN_API_KEY;
  if(!key)return{source:'missing-config',title:input.topic,errorCode:'qwen_key_missing',content:'ยังไม่ได้ตั้งค่า Qwen API key ในเครื่องนี้'};
  const model=process.env.QWEN_MODEL||'qwen3.7-plus';
  const baseUrl=String(process.env.QWEN_BASE_URL||'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/,'');
  const outputLimit=qwenOutputLimit(input);
  setStudyProgress(input.progressId,{percent:86,status:'processing',message:`กำลังให้ ${model} อ่านและวิเคราะห์เอกสาร…`,detail:'Qwen กำลังตรวจเนื้อหาจากข้อความจริงก่อนสร้างผลลัพธ์และแหล่งอ้างอิง'});
  const requestOptions=()=>({method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'คุณเป็นติวเตอร์ที่เคร่งครัดกับหลักฐาน อ่านเอกสารทั้งหมดที่ได้รับก่อนตอบ สำหรับ Summary, Quiz และ Flashcard ให้ใช้เฉพาะข้อมูลในเอกสาร ห้ามสร้างหรือเดาข้อมูล ทุกคำตอบต้องตรวจย้อนกลับไปยังข้อความจริงได้ แหล่งอ้างอิงต้องคัดข้อความจากเอกสารแบบคำต่อคำ ห้ามใช้ Markdown เช่น #, ** หรือ ``` และต้องตอบตามแม่แบบที่ผู้ใช้กำหนดเท่านั้น'},{role:'user',content:tutorPrompt(input)}],stream:false,temperature:0.05,top_p:0.85,max_tokens:outputLimit,enable_thinking:false}),signal:AbortSignal.timeout(150000)});
  let activeBaseUrl=baseUrl,response=await fetch(`${activeBaseUrl}/chat/completions`,requestOptions()),body=await response.json().catch(()=>({}));
  if(response.status===401){
    const alternateBaseUrl=activeBaseUrl.includes('dashscope-intl.aliyuncs.com')?'https://dashscope.aliyuncs.com/compatible-mode/v1':'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const alternateResponse=await fetch(`${alternateBaseUrl}/chat/completions`,requestOptions()),alternateBody=await alternateResponse.json().catch(()=>({}));
    if(alternateResponse.ok||alternateResponse.status!==401){activeBaseUrl=alternateBaseUrl;response=alternateResponse;body=alternateBody;process.env.QWEN_BASE_URL=alternateBaseUrl}
  }
  if(!response.ok){const apiError=body.error||{},message=String(apiError.message||body.message||'ไม่ทราบสาเหตุ');return{source:'fallback',title:input.topic,errorCode:apiError.code||`qwen_http_${response.status}`,content:response.status===401?'Qwen API key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน':response.status===402?'บัญชี Qwen มีเครดิตไม่เพียงพอ':response.status===429?'Qwen มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่':`Qwen ตอบกลับสถานะ ${response.status}: ${message}`}}
  const choice=body.choices?.[0]||{},message=choice.message||{},content=normalizeStudyModelFormatting(message.content||'');
  if(!content){const finishReason=String(choice.finish_reason||'unknown');return{source:'fallback',title:input.topic,errorCode:'qwen_empty_content',content:finishReason==='length'?'Qwen ใช้โทเคนที่กำหนดครบก่อนส่งคำตอบสุดท้าย กรุณาลดจำนวนข้อแล้วลองใหม่':'Qwen ไม่ส่งคำตอบสุดท้ายกลับมา กรุณาลองใหม่',diagnostics:{finishReason}}}
  return{source:'qwen',title:input.topic,content,model,finishReason:String(choice.finish_reason||'stop')};
}
async function generateWithQwen(input){
  const action=input.action,count=qwenRequestedCount(input);
  // Large interactive sets are more reliable as several grounded requests.
  // Each batch receives the same extracted source; only the requested item
  // count changes, so batching cannot introduce outside material.
  const batchSize=action==='flashcards'?4:3;
  if(!['quiz','flashcards'].includes(action)||count<=batchSize)return generateWithQwenSingle(input);
  const batches=[];
  const total=Math.ceil(count/batchSize);
  for(let offset=0;offset<count;offset+=batchSize){
    const batchCount=Math.min(batchSize,count-offset),batchNumber=batches.length+1;
    setStudyProgress(input.progressId,{percent:86+Math.round(offset/count*6),status:'processing',message:`กำลังสร้าง${action==='flashcards'?'แฟลชการ์ด':'ข้อสอบ'}ชุดที่ ${batchNumber}/${total}…`,detail:`อ่านและตรวจหลักฐานจากไฟล์เดิม ชุดละ ${batchCount} รายการ`});
    const result=await generateWithQwenSingle({...input,studySettings:{...(input.studySettings||{}),count:batchCount}});
    if(!result||['fallback','missing-config','blocked'].includes(result.source))return result||{source:'fallback',title:input.topic,errorCode:'qwen_batch_failed',content:'Qwen ไม่สามารถสร้างผลลัพธ์ครบทุกชุดได้ กรุณาลองใหม่'};
    batches.push(result);
  }
  return{...batches[0],content:batches.map(result=>result.content).join('\n\n'),batchCount:total,batchSize};
}

// Kept as a compatibility shim for the existing chat toggle. StudyFlow no
// longer calls Gemini. The selected provider can still answer from its model knowledge, but
// the app must not claim that a live web search happened when no search
// provider is configured.
async function searchWebWithGemini(){
  return{
    content:'ไม่ได้ค้นเว็บแบบสด เนื่องจาก StudyFlow ยังไม่ได้ตั้งค่าผู้ให้บริการค้นเว็บแยกต่างหาก',
    sources:[],
    error:'live_web_search_not_configured'
  };
}

async function generateWithOllama(input){
  if(['summary','quiz','flashcards'].includes(input.action)&&!studyTextAvailable(input))return null;
  const context=String(input.classroomContext||'').trim(),imageParts=[];
  // PDF/Office files are extracted by the Classroom/Drive layer first. Keep
  // that text even when another attachment is not supported by the local model.
  // Only image attachments are forwarded as vision input to Ollama.
  for(const filePart of input.fileParts||[]){if(/^image\//.test(filePart.mimeType||''))imageParts.push(cleanBase64(filePart.data))}
  if(input.fileData){const mime=input.fileMimeType||'';if(/^image\//.test(mime))imageParts.push(cleanBase64(input.fileData))}
  if(!context&&!imageParts.length)return null;
  const preferred=imageParts.length?(process.env.OLLAMA_VISION_MODEL||'llava:latest'):(process.env.OLLAMA_MODEL||'qwen3:8b');
  let model=preferred;
  try{const tags=await fetch('http://127.0.0.1:11434/api/tags').then(response=>response.ok?response.json():null);const names=(tags?.models||[]).map(item=>String(item.name));if(!names.includes(model)){const fallback=imageParts.length?'llava:latest':'llama3.1:8b';if(names.includes(fallback))model=fallback}}catch{}
  setStudyProgress(input.progressId,{percent:86,status:'processing',message:`กำลังให้ ${model} วิเคราะห์เนื้อหา…`,detail:'โมเดลกำลังสร้างผลลัพธ์จากข้อมูลที่อ่านได้'})
  // Keep the local prompt within a practical context window while retaining
  // the beginning of the grounded Classroom material and its headings.
  const localContext=truncateStudyText(context,20000);
  const userMessage={role:'user',content:tutorPrompt({...input,classroomContext:localContext||'ใช้ภาพไฟล์แนบเป็นแหล่งข้อมูลหลัก'})};if(imageParts.length)userMessage.images=imageParts;
  try{const outputLimit=input.action==='chat'?420:input.action==='summary'?2200:input.action==='quiz'?Math.min(3200,Math.max(1200,Number(input.studySettings?.count||10)*230)):Math.min(3200,Math.max(1400,Number(input.studySettings?.count||12)*180));const response=await fetch('http://127.0.0.1:11434/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'คุณเป็นติวเตอร์ภาษาไทย ใช้เฉพาะแหล่งข้อมูลที่ได้รับ อ่านเนื้อหาให้ครบก่อนตอบ ห้ามแต่งข้อมูล หากอ่านไม่ชัดให้บอกตรง ๆ',},userMessage],stream:false,think:false,options:{temperature:0.12,num_predict:outputLimit,top_p:0.9}})});if(!response.ok)return null;const body=await response.json().catch(()=>({}));const content=String(body.message?.content||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();return content?{source:'ollama-local',title:input.topic,content,localModel:model}:null}catch{return null}
}

function studySummaryValid(input,content){if(input.action!=='summary')return true;const text=String(content||'').trim();if(text.length<80)return false;if(/^\s*(?:ข้อ\s*\d+|แฟลชการ์ด\s*\d+|Q\s*:|คำถาม\s*:)/im.test(text))return false;if(/(?:^|\n)\s*(?:เฉลย|ด้านหน้า|ด้านหลัง)\s*:/im.test(text))return false;return !/ยังไม่ได้ตั้งค่า|โควตาเต็ม|ตอบกลับสถานะ|เรียก AI ไม่สำเร็จ|ระบบยังสร้าง/i.test(text)}
function normalizeStudyModelFormatting(content){return String(content||'').replace(/\r/g,'').replace(/^\s*#{1,6}\s*/gm,'').replace(/\*\*/g,'').replace(/^\s*[-*]\s+(?=(?:ข้อ\s*\d+|แฟลชการ์ด\s*\d+|ระดับความยาก|[กขคง]\s*[.)]|เฉลย|เหตุผล|คำอธิบาย|แหล่งอ้างอิง|ด้านหน้า|ด้านหลัง))/gm,'').replace(/^\s*ข้อ\s*(\d+)[.)]\s*คำถาม\s*\n\s*/gm,'ข้อ $1. ').trim()}
function expectedDifficulty(input){return String(input.studySettings?.difficulty||'medium').toLowerCase()}
function difficultyMatches(input,block,question){const expected=expectedDifficulty(input),marker=block.match(/ระดับความยาก\s*:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase()||'';const actual=/hard|ยาก/.test(marker)?'hard':/easy|ง่าย/.test(marker)?'easy':/medium|ปานกลาง/.test(marker)?'medium':'';if(!actual||actual!==expected)return false;if(expected==='hard'&&!/(วิเคราะห์|เหตุผล|หาก|สถานการณ์|เปรียบเทียบ|ความสัมพันธ์|ลำดับ|ประยุกต์|เพราะ|แตกต่าง|สรุปผล)/i.test(question))return false;if(expected==='medium'&&question.length<18)return false;return true}
function studyFormatValid(input,content){const text=String(content||'').replace(/\r/g,'').trim();const requested=Math.max(1,Math.min(50,Number(input.studySettings?.count)|| (input.action==='quiz'?10:12)));if(input.action==='quiz'){const blocks=text.split(/(?=^\s*(?:ข้อ\s*)?\d+[.)])/im).map(x=>x.trim()).filter(block=>/^(?:ข้อ\s*)?\d+[.)]/i.test(block));if(!blocks.length||blocks.length>requested||/^\s*(?:สรุป|บทสรุป|สาระสำคัญ)\s*:/im.test(text))return false;const questions=[];for(const block of blocks){const lines=block.split('\n').map(x=>x.trim()).filter(Boolean),first=lines.find(x=>x&&!/^ระดับความยาก\s*:/i.test(x))||'';const question=first.replace(/^(?:ข้อ\s*)?\d+[.)]?\s*/i,'').trim();const choiceEntries=lines.map(x=>x.match(/^([กขคง])\s*[.)]\s*(.+)$/)).filter(Boolean),choices=choiceEntries.map(x=>x[2].trim()),letters=choiceEntries.map(x=>x[1]);if(!question||!difficultyMatches(input,block,question)||choices.length!==4||new Set(letters).size!==4||new Set(choices.map(x=>x.toLowerCase())).size!==4||!/(?:^|\n)\s*เฉลย\s*:/i.test(block)||!/(?:^|\n)\s*เหตุผล\s*:/i.test(block)||!/(?:^|\n)\s*แหล่งอ้างอิง\s*:/i.test(block))return false;questions.push(question.toLowerCase())}return new Set(questions).size===questions.length}if(input.action==='flashcards'){const blocks=text.split(/(?=^\s*(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+))/im).map(x=>x.trim()).filter(block=>/^(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+)/i.test(block));if(!blocks.length||blocks.length>requested||/^\s*(?:สรุป|บทสรุป|สาระสำคัญ)\s*:/im.test(text))return false;const fronts=[];for(const block of blocks){const front=block.match(/(?:^|\n)\s*(?:ด้านหน้า|front)(?:\s*\([^)]*\))?\s*:\s*([^\n]+)/i)?.[1]?.trim();if(!front||!difficultyMatches(input,block,front)||!/(?:^|\n)\s*(?:ด้านหลัง|back)(?:\s*\([^)]*\))?\s*:/i.test(block)||!/(?:^|\n)\s*(?:เหตุผล|คำอธิบาย)(?:\/คำอธิบาย)?\s*:/i.test(block)||!/(?:^|\n)\s*แหล่งอ้างอิง\s*:/i.test(block))return false;fronts.push(front.toLowerCase())}return new Set(fronts).size===fronts.length}return studySummaryValid(input,text)}
function normalizeStudyGroundingText(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'').replace(/[^\p{L}\p{N}]/gu,'')}
function studyEvidenceFragmentInSource(sourceText,value,minLength=12){
  const evidenceText=normalizeStudyGroundingText(value);
  if(evidenceText.length<minLength)return false;
  if(sourceText.includes(evidenceText))return true;
  const windowSize=Math.min(28,Math.max(14,Math.floor(evidenceText.length*.45)));
  let matched=0,total=0;
  for(let index=0;index+windowSize<=evidenceText.length;index+=Math.max(5,Math.floor(windowSize/2))){total++;if(sourceText.includes(evidenceText.slice(index,index+windowSize)))matched++}
  return total>0&&matched/total>=2/3;
}
function studyEvidenceInSource(source,evidence){
  const sourceText=normalizeStudyGroundingText(source),rawEvidence=String(evidence||'').replace(/^ตำแหน่งในข้อความที่อ่านได้\s*:\s*/i,'').trim();
  if(!sourceText)return false;
  const quoted=[...rawEvidence.matchAll(/["“]([^"”]{12,})["”]/g)].map(match=>match[1]).filter(text=>normalizeStudyGroundingText(text).length>=12);
  if(quoted.length)return quoted.every(text=>studyEvidenceFragmentInSource(sourceText,text));
  const fragments=rawEvidence.split(/\s+(?:และ|รวมทั้ง|พร้อมทั้ง)\s+|\s*[;|]\s*/i).map(text=>text.trim()).filter(text=>normalizeStudyGroundingText(text).length>=8);
  if(fragments.length>1)return fragments.every(text=>studyEvidenceFragmentInSource(sourceText,text,8));
  return studyEvidenceFragmentInSource(sourceText,rawEvidence);
}
function studyReferenceBlocks(content){return [...String(content||'').matchAll(/(?:^|\n)\s*แหล่งอ้างอิง\s*:\s*([\s\S]*?)(?=\n\s*(?:ข้อ\s*\d+[.)]|แฟลชการ์ด\s*(?:ที่\s*)?\d+)|$)/gi)].map(match=>match[1].trim()).filter(Boolean)}
function studyGroundingValid(input,content){if(!['quiz','flashcards'].includes(input.action))return true;const source=input.readableText===false?'':String(input.referenceContent||input.classroomContext||'');if(!studyTextAvailable(input)||source.length<40)return true;const references=studyReferenceBlocks(content),expected=Math.max(1,Math.min(50,Number(input.studySettings?.count)||(input.action==='quiz'?10:12)));if(!references.length||references.length>expected)return false;return references.every(reference=>studyEvidenceInSource(source,reference))}
function studyGroundingChecks(input,content){const source=input.readableText===false?'':String(input.referenceContent||input.classroomContext||'');return studyReferenceBlocks(content).map((reference,index)=>({index:index+1,valid:studyEvidenceInSource(source,reference),preview:reference.slice(0,240)}))}
function studyOutputValid(input,content){return studyFormatValid(input,content)&&studyGroundingValid(input,content)}
function validStudyBlocks(input,content){
  if(!['quiz','flashcards'].includes(input.action))return[];
  const pattern=input.action==='quiz'?/(?=^\s*(?:ข้อ\s*)?\d+[.)])/im:/(?=^\s*(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+))/im;
  const starts=input.action==='quiz'?/^(?:ข้อ\s*)?\d+[.)]/i:/^(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+)/i;
  const singleInput={...input,studySettings:{...(input.studySettings||{}),count:1}};
  return String(content||'').replace(/\r/g,'').split(pattern).map(block=>block.trim()).filter(block=>starts.test(block)&&studyOutputValid(singleInput,block));
}
function renumberStudyBlocks(action,blocks){
  return blocks.map((block,index)=>action==='quiz'
    ? block.replace(/^\s*(?:ข้อ\s*)?\d+[.)]\s*/i,`ข้อ ${index+1}. `)
    : block.replace(/^\s*(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+)\s*/i,`แฟลชการ์ด ${index+1}\n`));
}
function normalizeStudyPairs(input,content){const text=String(content||'').replace(/\r/g,'');const requested=Math.max(1,Math.min(50,Number(input.studySettings?.count)|| (input.action==='quiz'?10:12))),difficulty=expectedDifficulty(input);const pairs=[];const pairPattern=/(?:^|\n)\s*(?:Q|คำถาม|Question)\s*[:：]\s*([\s\S]*?)\n\s*(?:A|คำตอบ|Answer)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Q|คำถาม|Question)\s*[:：]|$)/gi;let match;while((match=pairPattern.exec(text))&&pairs.length<requested){const question=match[1].trim(),answer=match[2].trim();if(question&&answer)pairs.push({question,answer})}if(!pairs.length)return '';if(input.action==='flashcards')return pairs.map((pair,index)=>`แฟลชการ์ด ${index+1}\nด้านหน้า: ${pair.question}\nระดับความยาก: ${difficulty}\nด้านหลัง: ${pair.answer}\nเหตุผล/คำอธิบาย: คำตอบนี้อ้างอิงจากเนื้อหาที่ AI อ่านได้ในไฟล์ที่ผู้ใช้เลือก\nแหล่งอ้างอิง: ตำแหน่งในข้อความที่อ่านได้: ${pair.answer}`).join('\n\n');const answers=[...new Set(pairs.map(pair=>pair.answer))];if(answers.length<4)return '';return pairs.map((pair,index)=>{const options=[pair.answer,...answers.filter(answer=>answer!==pair.answer)].slice(0,4);return`ข้อ ${index+1}. ${pair.question}\nระดับความยาก: ${difficulty}\n${options.map((option,optionIndex)=>`${['ก','ข','ค','ง'][optionIndex]}) ${option}`).join('\n')}\nเฉลย: ก) ${pair.answer}\nเหตุผล: คำตอบนี้อ้างอิงจากเนื้อหาที่ AI อ่านได้ในไฟล์ที่ผู้ใช้เลือก\nแหล่งอ้างอิง: ตำแหน่งในข้อความที่อ่านได้: ${pair.answer}`}).join('\n\n')}
function studySourceFacts(input){const source=input.readableText===false?'':truncateStudyText(input.referenceContent||input.classroomContext||'',20000);const terms=/ภูมิศาสตร์|เครื่องมือ|แผนที่|มาตราส่วน|พิกัด|ละติจูด|ลองจิจูด|ลูกโลก|ภาพถ่าย|ดาวเทียม|รีโมตเซนซิง|remote sensing|gnss|gis|อากาศ|อุณหภูมิ|ความชื้น|ความกดอากาศ|ลม|ฝน|หมายถึง|ได้แก่|แบ่งเป็น|ประกอบด้วย|แสดง|ใช้|ศึกษา/i;const candidates=source.split(/\n{2,}|(?<=[.!?。！？])\s+/).map((item,index)=>({index,text:item.replace(/^[-*#>\s]+/,'').replace(/\*{1,2}/g,'').replace(/^(?:Q|A|คำถาม|คำตอบ)\s*[:：]\s*/i,'').replace(/[ \t]+/g,' ').trim()})).filter(item=>item.text.length>=28&&item.text.length<=700&&!/^(ข้อมูลจาก|ไฟล์ภายนอก|ผู้ใช้อัปโหลดไฟล์|โพสต์ที่เลือก|ไฟล์ .*แนบให้ AI|เนื้อหาที่อ่านจาก|ข้อ\s*\d+|แฟลชการ์ด\s*\d+|เฉลย|เหตุผล|ด้านหน้า|ด้านหลัง)/i.test(item.text)&&!/\.{3,}|เขียนเลขข้อ|ให้นักเรียน|ตรวจสอบความเข้าใจ|ลองทําดู/i.test(item.text));const ranked=candidates.map(item=>({...item,score:(terms.test(item.text)?8:0)+(item.text.length>=55?3:0)+(item.text.length<=360?2:0)-((item.text.match(/\n/g)||[]).length>12?4:0)})).sort((a,b)=>b.score-a.score||a.index-b.index);const facts=[],seen=new Set();for(const item of ranked){const fact=item.text.replace(/\n+/g,' · ').slice(0,520),key=normalizeStudyGroundingText(fact);if(key.length<20||seen.has(key))continue;seen.add(key);facts.push(fact)}return facts;}
function studyFactQuestion(fact,index=0,difficulty='medium'){const match=fact.match(/^(.{3,80}?)\s*(?:คือ|หมายถึง|ได้แก่|:|：)\s*/);if(match&&difficulty!=='hard')return`"${match[1].trim()}" คืออะไรหรือมีความสำคัญอย่างไร`;const snippet=fact.replace(/\s+/g,' ').slice(0,72);return difficulty==='hard'?`หากวิเคราะห์เหตุผลจากข้อความในเอกสารข้อ ${index+1} ที่กล่าวว่า "${snippet}${fact.length>72?'…':''}" ข้อใดสอดคล้องที่สุด`: `จากข้อความในเอกสารข้อ ${index+1} ที่กล่าวว่า "${snippet}${fact.length>72?'…':''}" ข้อใดตรงกับเนื้อหาที่อ่านได้`}
function extractiveSummaryFallback(input){const facts=studySourceFacts(input);if(facts.length<2)return '';const main=facts.slice(0,18);return`สรุปเนื้อหาจากข้อมูลที่อ่านได้\n\nหัวใจของเนื้อหา\n${main.map(item=>`- ${item}`).join('\n')}\n\nข้อควรจำ\n${main.slice(0,Math.min(6,main.length)).map(item=>`- ${item}`).join('\n')}\n\nหมายเหตุ: สรุปนี้เรียบเรียงจากข้อความที่อ่านได้โดยตรง หากไฟล์มีแผนภาพ ตาราง หรือข้อความในภาพที่อ่านไม่ครบ ระบบจะแจ้งข้อจำกัดแทนการเติมข้อมูล`}
function extractiveStudyFallback(input){const facts=studySourceFacts(input),difficulty=expectedDifficulty(input);const requested=Math.max(1,Math.min(50,Number(input.studySettings?.count)|| (input.action==='quiz'?10:12)));if(!facts.length)return '';if(input.action==='quiz'&&facts.length<4)return '';const chosen=facts.slice(0,requested);const limitNote=chosen.length<requested?`ข้อมูลที่อ่านได้ยืนยันได้เพียง ${chosen.length} ประเด็น จึงสร้างเท่านี้โดยไม่เติมข้อมูลที่ไม่มีหลักฐาน`:'',suffix=limitNote?`\n\nหมายเหตุ: ${limitNote}`:'';if(input.action==='flashcards')return chosen.map((fact,index)=>`แฟลชการ์ด ${index+1}\nด้านหน้า: ${studyFactQuestion(fact,index,difficulty)}\nระดับความยาก: ${difficulty}\nด้านหลัง: ${fact}\nเหตุผล/คำอธิบาย: คำตอบนี้สกัดจากข้อเท็จจริงที่อ่านได้โดยตรงจากเนื้อหาที่ผู้ใช้เลือก\nแหล่งอ้างอิง: ตำแหน่งในข้อความที่อ่านได้: ${fact}`).join('\n\n')+suffix;return chosen.map((fact,index)=>{const distractors=facts.filter(item=>item!==fact).slice(0,3);const options=[fact,...distractors];return`ข้อ ${index+1}. ${studyFactQuestion(fact,index,difficulty)}\nระดับความยาก: ${difficulty}\n${options.map((option,optionIndex)=>`${['ก','ข','ค','ง'][optionIndex]}) ${option}`).join('\n')}\nเฉลย: ก) ${fact}\nเหตุผล: คำตอบคัดจากเนื้อหาที่อ่านได้โดยตรง ไม่ได้เติมข้อมูลนอกเนื้อหา\nแหล่งอ้างอิง: ตำแหน่งในข้อความที่อ่านได้: ${fact}`}).join('\n\n')+suffix}
function studyCacheKey(input){if(input.action==='chat')return '';const hash=createHash('sha1'),settings=Object.fromEntries(Object.entries(input.studySettings||{}).sort(([a],[b])=>a.localeCompare(b))),groundedText=normalizeExtractedStudyText(input.referenceContent||input.classroomContext||'').replace(/^ไฟล์ภายนอก:[^\n]*\n/i,'').replace(/\s+/g,' ');hash.update(String(process.env.AI_PROVIDER||'qwen'));hash.update(String(process.env.QWEN_MODEL||process.env.DEEPSEEK_MODEL||process.env.OPENAI_MODEL||''));hash.update(String(input.action||'summary'));hash.update(JSON.stringify(settings));hash.update(groundedText);hash.update(String(input.fileMimeType||''));hash.update(String(input.fileData||''));hash.update(JSON.stringify((input.fileParts||[]).map(part=>({mimeType:part.mimeType||'',data:part.data||''}))));return hash.digest('hex')}
function studyVariationItems(action,content){
  if(!['quiz','flashcards'].includes(action))return[];
  const pattern=action==='quiz'?/(?=^\s*(?:ข้อ\s*)?\d+[.)])/im:/(?=^\s*(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+))/im;
  const starts=action==='quiz'?/^(?:ข้อ\s*)?\d+[.)]/i:/^(?:แฟลชการ์ด\s*(?:ที่\s*)?\d+|flashcard\s*\d+)/i;
  return String(content||'').replace(/\r/g,'').split(pattern).map(block=>block.trim()).filter(block=>starts.test(block)).map(block=>{
    if(action==='flashcards')return block.match(/(?:^|\n)\s*(?:ด้านหน้า|front)(?:\s*\([^)]*\))?\s*:\s*([^\n]+)/i)?.[1]?.trim()||'';
    return block.split('\n').map(line=>line.trim()).find(line=>line&&!/^ระดับความยาก\s*:/i.test(line)&&!/^([กขคง])\s*[.)]/.test(line))?.replace(/^(?:ข้อ\s*)?\d+[.)]?\s*/i,'').trim()||'';
  }).filter(item=>item.length>=8).map(item=>item.slice(0,280));
}
function recentStudyVariationItems(cacheKey){
  return(cacheKey?studyVariationHistory.get(cacheKey):[])?.flatMap(set=>set).slice(-36)||[];
}
function rememberStudyVariation(cacheKey,action,content){
  const items=studyVariationItems(action,content);if(!cacheKey||!items.length)return;
  const history=studyVariationHistory.get(cacheKey)||[];history.push(items);while(history.length>3)history.shift();studyVariationHistory.set(cacheKey,history);
  if(studyVariationHistory.size>24)studyVariationHistory.delete(studyVariationHistory.keys().next().value);
}
function studyResultCacheable(result){return Boolean(result?.content)&&!['fallback','missing-config','blocked'].includes(result.source)}
function studyTextAvailable(input){
  if(input.readableText===false)return false;
  const source=String(input.referenceContent||input.classroomContext||'').trim();
  return source.length>=40&&!/^(?:ผู้ใช้อัปโหลดไฟล์|ผู้ใช้แนบไฟล์|ไฟล์ .*ให้โมเดลอ่านโดยตรง)/i.test(source);
}
function studyBinaryAvailable(input){return Boolean(String(input.fileData||'').trim()||(input.fileParts||[]).some(part=>String(part?.data||'').trim()))}
async function generateWithAI(input){
  input={...input,action:['summary','quiz','flashcards','chat'].includes(input?.action)?input.action:'summary'};
  if(input.readableText===undefined) input={...input,readableText:Boolean(input.referenceContent||/รายละเอียดจากโพสต์|เนื้อหาไฟล์|ไฟล์ภายนอก:/i.test(String(input.classroomContext||''))&&!(input.fileData&&/ผู้ใช้อัปโหลดไฟล์/i.test(String(input.classroomContext||''))))};
  const hasText=studyTextAvailable(input),hasBinary=studyBinaryAvailable(input);
  if(['summary','quiz','flashcards'].includes(input.action)&&!hasText&&!hasBinary)return aiMeta({source:'blocked',title:input.topic,errorCode:'study_source_unreadable',content:'ยังสร้างผลลัพธ์ไม่ได้ เพราะระบบอ่านเนื้อหาจากไฟล์ที่เลือกไม่สำเร็จ จึงไม่แต่งข้อสอบหรือแฟลชการ์ดจากข้อมูลอื่นแทน\n\nตรวจสอบว่าไฟล์ไม่เสียหาย เป็นชนิดที่รองรับ และลองใหม่อีกครั้ง'},input);
  // Quiz and flashcard requests are intentional "new set" actions. Do not
  // return the previous exact set even when file/settings are unchanged.
  const cacheKey=studyCacheKey(input),isNewVariation=Boolean(input.forceNew)||['quiz','flashcards'].includes(input.action),cached=cacheKey?studyResultCache.get(cacheKey):null;
  if(cached&&!isNewVariation)return aiMeta({...cached,cached:true},input);
  if(isNewVariation&&['quiz','flashcards'].includes(input.action))input={...input,avoidItems:recentStudyVariationItems(cacheKey)};
  if(process.env.STUDYFLOW_EXTRACTIVE_ONLY==='true'&&['summary','quiz','flashcards'].includes(input.action)){
    const content=input.action==='summary'?extractiveSummaryFallback(input):extractiveStudyFallback(input);
    const valid=content&&(input.action==='summary'?studySummaryValid(input,content):studyOutputValid(input,content));
    const result=valid?{source:'extractive-local',title:input.topic,content}:{source:'blocked',title:input.topic,errorCode:'study_source_unreadable',content:'ระบบอ่านข้อเท็จจริงจากไฟล์ได้ไม่เพียงพอ จึงหยุดสร้างผลลัพธ์แทนการแต่งข้อมูล'};
    if(cacheKey&&studyResultCacheable(result))studyResultCache.set(cacheKey,result);
    return aiMeta(result,input);
  }
  const configuredProvider=(process.env.AI_PROVIDER||'qwen').toLowerCase(),provider=configuredProvider==='openai'?'openai':configuredProvider==='deepseek'?'deepseek':'qwen',reuseMode=/เนื้อหาที่อ่านแล้ว|สรุปเดิม/i.test(String(input.classroomContext||''));
  const generatePrimary=payload=>provider==='openai'?generateWithOpenAI(payload):provider==='deepseek'?generateWithDeepSeek(payload):generateWithQwen(payload);
  let result;
  try{result=await generatePrimary(input)}catch(error){const errorDetail=`${String(error?.name||'Error')}: ${String(error?.message||'ไม่ทราบสาเหตุ')}`,timedOut=/AbortError|TimeoutError|timed out|timeout/i.test(errorDetail);if(process.env.STUDYFLOW_DEBUG_AI==='true')console.error('[StudyFlow AI request failed]',errorDetail);result={source:'fallback',title:input.topic,errorCode:timedOut?'ai_timeout':reuseMode?'reuse_ai_failed':'ai_request_failed',content:timedOut?'AI ใช้เวลาตอบนานเกินกำหนด กรุณาลองใหม่':'เรียก AI ไม่สำเร็จ กรุณาตรวจสอบคีย์ เครดิต และอินเทอร์เน็ต',diagnostics:process.env.STUDYFLOW_DEBUG_AI==='true'?{requestError:errorDetail}:undefined}}
  if(input.action==='chat'&&result.source==='fallback'&&process.env.AI_LOCAL_FALLBACK!=='false'){const local=await generateWithOllama(input);if(local)result={...local,fallbackFrom:result.errorCode}}
  if((input.action==='quiz'||input.action==='flashcards')&&!['fallback','missing-config','blocked'].includes(result.source)&&!studyOutputValid(input,result.content)){
    const firstSource=result.source;
    let strictCandidate=null;
    setStudyProgress(input.progressId,{percent:91,status:'validating',message:'กำลังตรวจรูปแบบและหลักฐาน…',detail:'ตรวจทุกข้อกับข้อความจริงจากไฟล์'});
    if(['qwen','openai','deepseek'].includes(firstSource)){setStudyProgress(input.progressId,{percent:94,status:'repairing',message:'กำลังแก้รูปแบบผลลัพธ์…',detail:'ขอให้ AI จัดรูปแบบและหลักฐานใหม่อีกหนึ่งรอบ'});const strictResult=await generatePrimary({...input,forceStrict:true});strictCandidate=strictResult;if(strictResult&&studyOutputValid(input,strictResult.content))result={...strictResult,formatRepaired:true,fallbackFrom:firstSource}}
    if(!studyOutputValid(input,result.content)){
      const candidates=[result,strictCandidate].filter(candidate=>candidate&&!['fallback','missing-config','blocked'].includes(candidate.source)).map(candidate=>({candidate,blocks:validStudyBlocks(input,candidate.content)})).sort((a,b)=>b.blocks.length-a.blocks.length),best=candidates[0],requested=Math.max(1,Math.min(50,Number(input.studySettings?.count)||(input.action==='quiz'?10:12)));
      if(best?.blocks.length){const validatedBlocks=renumberStudyBlocks(input.action,best.blocks);result={...best.candidate,content:validatedBlocks.join('\n\n'),partialResult:validatedBlocks.length<requested,validatedCount:validatedBlocks.length,requestedCount:requested,formatRepaired:true,fallbackFrom:firstSource}}
      else{
        const diagnostics={provider:firstSource,formatValid:studyFormatValid(input,result.content),groundingValid:studyGroundingValid(input,result.content),rawLength:String(result.content||'').length,...(process.env.STUDYFLOW_DEBUG_AI==='true'?{evidenceChecks:studyGroundingChecks(input,result.content)}:{})};
        const rejectedPreview=process.env.STUDYFLOW_DEBUG_AI==='true'?String(result.content||'').slice(0,6000):undefined;
        result={source:'blocked',title:input.topic,errorCode:'ungrounded_study_output',diagnostics,rejectedPreview,content:input.action==='quiz'?'ระบบปฏิเสธข้อสอบชุดนี้ เพราะตรวจไม่พบหลักฐานบางข้อในเอกสารที่อัปโหลด กรุณาลองสร้างใหม่ ระบบจะไม่แสดงเนื้อหาที่เดาเพิ่ม':'ระบบปฏิเสธแฟลชการ์ดชุดนี้ เพราะตรวจไม่พบหลักฐานบางใบในเอกสารที่อัปโหลด กรุณาลองสร้างใหม่ ระบบจะไม่แสดงเนื้อหาที่เดาเพิ่ม'};
      }
    }
  }
  if(input.action==='summary'&&!['fallback','missing-config','blocked'].includes(result.source)&&!studySummaryValid(input,result.content)){
    if(['qwen','openai','deepseek'].includes(result.source)){
      const strictResult=await generatePrimary({...input,forceStrict:true});
      if(strictResult&&studySummaryValid(input,strictResult.content))result={...strictResult,formatRepaired:true,fallbackFrom:result.source};
    }
    if(!studySummaryValid(input,result.content)){
      result={source:'blocked',title:input.topic,errorCode:'invalid_summary_format',content:'ระบบยังไม่สามารถสร้างสรุปที่ผ่านการตรวจสอบจากเนื้อหาในเอกสารได้ จึงหยุดไว้แทนการสุ่มหรือเรียงเศษข้อความ กรุณาตรวจสอบการตั้งค่า AI แล้วลองใหม่อีกครั้ง'};
    }
  }
  if(cacheKey&&studyResultCacheable(result)){studyResultCache.set(cacheKey,result);if(studyResultCache.size>24)studyResultCache.delete(studyResultCache.keys().next().value);if(isNewVariation||!studyVariationHistory.has(cacheKey))rememberStudyVariation(cacheKey,input.action,result.content)}
  return aiMeta(result,input);
}
 async function getClassroomTaskDetail(courseId,courseWorkId,token){const item=await googleApi(`courses/${courseId}/courseWork/${courseWorkId}`,token);let submission=null;try{const data=await googleApi(`courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions?userId=me&pageSize=10`,token);submission=data.studentSubmissions?.[0]||null}catch{}return{courseId,courseWorkId,title:item.title||'งานจาก Google Classroom',description:item.description||'',dueDate:item.dueDate||null,dueTime:item.dueTime||null,alternateLink:item.alternateLink||null,materials:item.materials||[],submission}}
async function submitClassroomTask(courseId,courseWorkId,token,link){const data=await googleApi(`courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions?userId=me&pageSize=10`,token);const submission=data.studentSubmissions?.[0];if(!submission)throw new Error('ไม่พบใบส่งงานของนักเรียน');const fresh=await refreshToken(token);if(link){const attach=await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submission.id}:modifyAttachments`,{method:'POST',headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({addAttachments:[{link:{url:link,title:link}}]})});if(!attach.ok)throw new Error(`แนบลิงก์ไม่สำเร็จ (${attach.status})`)}const turnedIn=await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submission.id}:turnIn`,{method:'POST',headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':'application/json'},body:'{}'});if(!turnedIn.ok)throw new Error(`ส่งงานไม่สำเร็จ (${turnedIn.status})`);return{state:'TURNED_IN'}}
async function route(req,res){const url=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&url.pathname==='/api/runtime'){return json(res,200,{app:'studyflow',dataRoot})}
  if(req.method==='GET'&&url.pathname==='/api/classroom/courses'){const token=await readToken();if(token?.access_token){try{return json(res,200,{courses:await getCoursesFast(token),source:'google-classroom'})}catch(e){return json(res,502,{courses:[],source:'google-classroom',error:e.message})}}return json(res,200,{courses:[],source:'demo'})}
  if(req.method==='GET'&&url.pathname==='/api/classroom/tasks'){const token=await readToken();if(token?.access_token){try{return json(res,200,{tasks:await getClassroomTasksWithRefs(token),source:'google-classroom'})}catch(e){return json(res,502,{tasks:[],source:'google-classroom',error:e.message})}}return json(res,200,{tasks:[],source:'demo'})}
  if(req.method==='GET'&&url.pathname==='/api/classroom/course'){const token=await readToken(),courseId=url.searchParams.get('courseId');if(!token?.access_token||!courseId)return json(res,400,{error:'missing_course_reference'});try{return json(res,200,{...(await getClassroomCourseContentFast(courseId,token)),source:'google-classroom'})}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='POST'&&url.pathname==='/api/classroom/task-submit-file'){const token=await readToken(),courseId=url.searchParams.get('courseId'),courseWorkId=url.searchParams.get('courseWorkId');if(!token?.access_token||!courseId||!courseWorkId)return json(res,400,{error:'missing_task_reference'});try{const input=await body(req);if(!input.file?.name||!input.file?.data)return json(res,400,{error:'missing_file'});if(String(input.file.data).length>28*1024*1024)return json(res,413,{error:'file_too_large'});return json(res,200,await submitClassroomFile(courseId,courseWorkId,token,input.file))}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='GET'&&url.pathname==='/api/config'){const token=await readToken(),provider=(process.env.AI_PROVIDER||'qwen').toLowerCase(),ai=provider==='qwen'?Boolean(process.env.QWEN_API_KEY):provider==='deepseek'?Boolean(process.env.DEEPSEEK_API_KEY):Boolean(process.env.OPENAI_API_KEY);return json(res,200,{ai,aiProvider:provider,openai:Boolean(process.env.OPENAI_API_KEY),google:Boolean(oauthConfig().clientId&&token?.access_token),drive:Boolean(token?.access_token),calendar:Boolean(token?.access_token),firebase:Boolean(process.env.FIREBASE_PROJECT_ID),notifications:Boolean(process.env.FCM_SERVER_KEY)})}
  if(req.method==='GET'&&url.pathname==='/api/auth/status'){const token=await readToken();if(!token?.access_token)return json(res,200,{connected:false});try{const fresh=await refreshToken(token),profile=await googleFetch('https://openidconnect.googleapis.com/v1/userinfo',fresh);return json(res,200,{connected:true,email:profile.email,name:profile.name,photo:profile.picture})}catch{return json(res,200,{connected:false,reason:'reauth_required'})}}
  if(req.method==='GET'&&url.pathname==='/api/auth/debug'){return json(res,200,{lastError:oauthLastError})}
  if(req.method==='GET'&&url.pathname==='/api/auth/google'){const cfg=oauthConfig();if(!cfg.clientId)return json(res,503,{error:'google_client_not_configured'});const verifier=b64url(randomBytes(48));const challenge=b64url(createHash('sha256').update(verifier).digest());const state=b64url(randomBytes(24));oauthRequests.set(state,{verifier,createdAt:Date.now()});const params=new URLSearchParams({client_id:cfg.clientId,redirect_uri:cfg.redirectUri,response_type:'code',scope:googleScopes(),access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'});return json(res,200,{url:`https://accounts.google.com/o/oauth2/v2/auth?${params}`})}
  if(req.method==='GET'&&url.pathname==='/oauth/callback'){
    try{
      const state=url.searchParams.get('state'),code=url.searchParams.get('code'),request=oauthRequests.get(state);
      oauthRequests.delete(state);
      if(!request||!code){oauthLastError={stage:'callback',reason:'missing_code_or_expired_state'};return redirect(res,'/?google=error&reason=missing_code')}
      const cfg=oauthConfig();
      const tokenParams={client_id:cfg.clientId,code,code_verifier:request.verifier,grant_type:'authorization_code',redirect_uri:cfg.redirectUri};
      if(process.env.GOOGLE_CLIENT_SECRET)tokenParams.client_secret=process.env.GOOGLE_CLIENT_SECRET;
      let tokenResponse;
      let lastNetworkError;
      for(let attempt=0;attempt<3;attempt++){
        try{
          tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(tokenParams),signal:AbortSignal.timeout(20000)});
          break;
        }catch(error){
          lastNetworkError=error;
          if(attempt<2)await waitMs(700*(attempt+1));
        }
      }
      if(!tokenResponse){
        const message=String(lastNetworkError?.message||'ติดต่อ Google ไม่สำเร็จ').slice(0,220);
        oauthLastError={stage:'token_exchange_network',reason:'google_unreachable',message};
        console.error('Google OAuth token exchange network failure',message);
        return redirect(res,'/?google=error&reason=google_unreachable');
      }
      if(!tokenResponse.ok){
        const errorText=await tokenResponse.text();
        const errorJson=(()=>{try{return JSON.parse(errorText)}catch{return{}}})();
        oauthLastError={stage:'token_exchange',status:tokenResponse.status,reason:errorJson.error||'unknown',description:errorJson.error_description||''};
        console.error('Google OAuth token exchange failed',tokenResponse.status,errorText);
        return redirect(res,`/?google=error&reason=token_${tokenResponse.status}`);
      }
      const token=await tokenResponse.json();
      token.expires_at=Date.now()+Number(token.expires_in||3600)*1000;
      await saveToken(token);
      oauthLastError=null;
      return redirect(res,'/?google=connected');
    }catch(error){
      const message=String(error?.message||error||'ไม่ทราบสาเหตุ').slice(0,220);
      oauthLastError={stage:'callback_exception',reason:'server_exception',message};
      console.error('Google OAuth callback failed',message);
      return redirect(res,'/?google=error&reason=server_exception');
    }
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){try{await writeFile(tokenPath,'{}','utf8')}catch{}return json(res,200,{connected:false})}
  if(req.method==='GET'&&url.pathname==='/api/classroom/task-detail'){const token=await readToken();const courseId=url.searchParams.get('courseId'),courseWorkId=url.searchParams.get('courseWorkId');if(!token?.access_token||!courseId||!courseWorkId)return json(res,400,{error:'missing_task_reference'});try{return json(res,200,await getClassroomTaskDetail(courseId,courseWorkId,token))}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='POST'&&url.pathname==='/api/classroom/task-submit'){const token=await readToken();const courseId=url.searchParams.get('courseId'),courseWorkId=url.searchParams.get('courseWorkId');if(!token?.access_token||!courseId||!courseWorkId)return json(res,400,{error:'missing_task_reference'});try{const input=await body(req);return json(res,200,await submitClassroomTask(courseId,courseWorkId,token,input.link||''))}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='GET'&&url.pathname==='/api/calendar/events'){const token=await readToken();if(token?.access_token){try{return json(res,200,{events:(await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=50',token)).items||[],source:'google-calendar'})}catch{}}return json(res,200,{events:[],source:'demo'})}
  if(req.method==='POST'&&url.pathname==='/api/study/generate'){try{const input=await body(req),token=await readToken();let context={contextText:'',sources:[],fileParts:[],readable:false};if(input.courseId){if(!token?.access_token)return json(res,401,{error:'classroom_not_connected',message:'ยังไม่ได้เชื่อมต่อ Google Classroom'});try{context=await collectClassroomStudyContext(input.courseId,input.topic,token,{topicId:input.topicId,courseWorkId:input.courseWorkId})}catch(error){const quota=/429|quota exceeded/i.test(error.message);return json(res,quota?429:503,{error:quota?'classroom_quota_exceeded':'classroom_unavailable',message:quota?'Google Classroom ใช้งานเกินโควตาชั่วคราว กรุณารอ 1–5 นาทีแล้วลองใหม่ ระบบหยุดการเรียก AI เพื่อไม่ให้สรุปจากข้อมูลไม่ครบ':`อ่านข้อมูล Google Classroom ไม่สำเร็จ: ${error.message}`})}}if(input.courseId&&!context.readable){return json(res,200,{source:'blocked',action:input.action||'summary',title:input.topic||'หัวข้อที่เลือก',contextAvailable:false,sources:context.sources,content:'ยังสรุปเนื้อหานี้ไม่ได้ เพราะไม่พบข้อความหรือไฟล์การเรียนรู้ที่อ่านได้ในหัวข้อที่เลือก\n\nระบบไม่ได้ดึงงานหรือโพสต์จากหัวข้ออื่นมาปนให้แล้ว\n\nถ้าเป็นไฟล์จาก Google Drive ให้เปิด Google Drive API ในโปรเจกต์ Google Cloud และเชื่อมต่อ Google Classroom ใหม่ แล้วลองอีกครั้ง'})}return json(res,200,await generateWithAI({...input,classroomContext:context.contextText,sources:context.sources,fileParts:context.fileParts,contextAvailable:context.readable||!input.courseId}))}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='GET'&&url.pathname==='/api/study/progress'){const id=url.searchParams.get('id');return json(res,200,getStudyProgress(id)||{id,percent:0,status:'unknown',message:'กำลังเริ่มต้น…',detail:'กำลังรอข้อมูลจากไฟล์'})}
  if(req.method==='POST'&&url.pathname==='/api/study/chat'){try{const input=await body(req),message=String(input.message||'').trim();if(!message)return json(res,400,{error:'missing_message'});if(/วันนี้.*(วันอะไร|วันที่|เดือนอะไร)|what\s+(day|date)\s+is\s+(it|today)/i.test(message))return json(res,200,{source:'system',action:'chat',title:'Athena',content:`วันนี้คือ ${thaiToday()} ตามเวลาประเทศไทย`,sources:[],contextAvailable:true});const file=input.file;let classroomContext='ผู้ใช้ไม่ได้แนบไฟล์ในคำถามนี้ ให้ตอบจากความรู้ทั่วไปของโมเดลและแจ้งว่าเป็นข้อมูลเพิ่มเติมนอกไฟล์';let fileData='',fileMimeType='',webSources=[],webSearchError='';if(file?.data){const bytes=Buffer.from(cleanBase64(file.data),'base64');if(bytes.length>MAX_STUDY_FILE_BYTES)return json(res,413,{error:'file_too_large',message:'ไฟล์ต้องมีขนาดไม่เกิน 50 MB'});const mime=file.mimeType||'application/octet-stream';fileMimeType=mime;const textMimes=['text/plain','text/markdown','text/csv','application/json','application/rtf'];const text=textMimes.includes(mime)?truncateStudyText(bytes.toString('utf8')):mime==='application/pdf'?truncateStudyText(await extractPdfTextLocally(bytes)):'';if(text)classroomContext=`ไฟล์ภายนอก: ${file.name}\n${text}`;else{fileData=file.data;classroomContext=`ผู้ใช้แนบไฟล์ ${file.name} ให้โมเดลอ่านโดยตรง หากโมเดลไม่รองรับชนิดไฟล์นี้ให้ตอบจากความรู้ทั่วไปและแจ้งข้อจำกัด`}}if(input.webSearch){const live=await searchWebWithGemini(message);webSources=live.sources||[];webSearchError=live.error||'';classroomContext+=`\n\nข้อมูลเพิ่มเติมจากการค้นเว็บที่ใช้ประกอบคำตอบ:\n${live.content||'ไม่พบข้อมูลจากเว็บ'}`;}const result=await generateWithAI({action:'chat',message,subject:'เนื้อหาที่ผู้ใช้กำลังเรียน',topic:file?.name||'คำถามทั่วไป',classroomContext,fileData,fileMimeType,contextAvailable:true});return json(res,200,{...result,sources:[...(result.sources||[]),...webSources],webSearchUsed:webSources.length>0,webSearchError:webSearchError||null})}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='POST'&&url.pathname==='/api/study/upload'){
    let progressId='';
    try{
      const input=await body(req);progressId=String(input.progressId||'');const file=input.file;
      if(!file?.name||!file?.data){setStudyProgress(progressId,{percent:100,status:'error',message:'ไม่พบไฟล์',detail:'กรุณาเลือกไฟล์แล้วลองใหม่'});return json(res,400,{error:'missing_file'})}
      const bytes=Buffer.from(cleanBase64(file.data),'base64');
      if(bytes.length>MAX_STUDY_FILE_BYTES){setStudyProgress(progressId,{percent:100,status:'error',message:'ไฟล์ใหญ่เกินกำหนด',detail:'ขนาดสูงสุดคือ 50 MB'});return json(res,413,{error:'file_too_large',message:'ไฟล์ต้องมีขนาดไม่เกิน 50 MB'})}
      setStudyProgress(progressId,{percent:60,status:'reading',message:'อัปโหลดเสร็จแล้ว กำลังตรวจไฟล์…',detail:`ได้รับไฟล์ ${file.name} ขนาด ${(bytes.length/1024/1024).toFixed(2)} MB`});
      const mime=file.mimeType||'application/octet-stream';
      const textMimes=['text/plain','text/markdown','text/csv','application/json','application/rtf'];
      const officeMimes=['application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword'];
      const isOffice=officeMimes.includes(mime);
      setStudyProgress(progressId,{percent:65,status:'extracting',message:mime==='application/pdf'?'กำลังอ่านข้อความจาก PDF…':isOffice?'กำลังอ่านข้อความจาก PowerPoint/Word…':'กำลังเตรียมไฟล์ให้โมเดลอ่าน…',detail:mime==='application/pdf'||isOffice?'กำลังอ่านเนื้อหาจากไฟล์จริง':'ไฟล์ชนิดนี้จะถูกส่งเป็นไฟล์ต้นฉบับให้โมเดลที่รองรับ'});
      const text=textMimes.includes(mime)?truncateStudyText(bytes.toString('utf8')):truncateStudyText(await extractStudyTextCached(bytes,mime));
      if(text)setStudyProgress(progressId,{percent:75,status:'extracted',message:'อ่านข้อความจากไฟล์แล้ว',detail:`อ่านได้ ${text.length.toLocaleString('th-TH')} ตัวอักษรจากไฟล์จริง`});
      else setStudyProgress(progressId,{percent:75,status:'prepared',message:'เตรียมไฟล์สำหรับการวิเคราะห์แล้ว',detail:'ยังไม่มีข้อความที่สกัดในเครื่อง จึงส่งไฟล์ต้นฉบับให้โมเดลที่รองรับ'});
      const fileInput=text?{classroomContext:`ไฟล์ภายนอก: ${file.name}\n${text}`,readableText:true,sources:[{title:file.name,type:'uploaded-file',status:'readable'}],contextAvailable:true}:{fileData:file.data,fileMimeType:mime,readableText:false,classroomContext:`ผู้ใช้อัปโหลดไฟล์ ${file.name} ให้ AI อ่านโดยตรง`,sources:[{title:file.name,type:'uploaded-file',status:'readable'}],contextAvailable:true};
      setStudyProgress(progressId,{percent:82,status:'processing',message:'กำลังส่งข้อมูลให้ AI วิเคราะห์…',detail:'กำลังใช้ข้อมูลจากไฟล์ที่เลือกเท่านั้น'});
      const result=await generateWithAI({action:input.action||'summary',subject:'ไฟล์ภายนอก',topic:file.name,progressId,studySettings:input.studySettings,...fileInput});
      const sourceText=text||'',sourceDigest=sourceText?createHash('sha1').update(sourceText).digest('hex'):'';
      setStudyProgress(progressId,{percent:100,status:'complete',message:'ประมวลผลเสร็จแล้ว',detail:'สร้างผลลัพธ์จากไฟล์เรียบร้อย'});return json(res,200,{...result,sourceText,sourceDigest,sourceName:file.name})
    }catch(e){setStudyProgress(progressId,{percent:100,status:'error',message:'ประมวลผลไม่สำเร็จ',detail:String(e?.message||'เกิดข้อผิดพลาด')});return json(res,502,{error:e.message})}
  }
  return null;
}
async function serve(req,res){const pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host}`).pathname);const safe=normalize(join(root,pathname==='/'?'index.html':pathname.slice(1)));if(!safe.startsWith(normalize(root)))return res.writeHead(403).end();try{const info=await stat(safe);if(!info.isFile())throw new Error();const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};res.writeHead(200,{'Content-Type':types[extname(safe)]||'application/octet-stream'});res.end(await readFile(safe))}catch{res.writeHead(404).end('Not found')}}
const httpServer=createServer(async(req,res)=>{try{const handled=await route(req,res);if(handled===null&&!res.writableEnded)await serve(req,res)}catch{if(!res.writableEnded)json(res,500,{error:'server_error'})}});
export function startServer(bindPort=port){return new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(bindPort,'127.0.0.1',()=>{const address=httpServer.address();activePort=Number(address.port);console.log(`StudyFlow server listening on http://127.0.0.1:${address.port}`);resolve(httpServer)})})}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])startServer().catch(error=>{console.error(error);process.exitCode=1});

async function getClassroomCourseContent(courseId,token){const course=await googleApi(`courses/${encodeURIComponent(courseId)}`,token);const [workData,announcementData,topicData]=await Promise.all([googleApi(`courses/${courseId}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,token).catch(()=>({courseWork:[]})),googleApi(`courses/${courseId}/announcements?announcementStates=PUBLISHED&pageSize=100`,token).catch(()=>({announcements:[]})),googleApi(`courses/${courseId}/topics?pageSize=100`,token).catch(()=>({topic:[]}))]);const coursework=await Promise.all((workData.courseWork||[]).map(async item=>{let submission=null;try{const data=await googleApi(`courses/${courseId}/courseWork/${item.id}/studentSubmissions?userId=me&pageSize=10`,token);submission=data.studentSubmissions?.[0]||null}catch{}return{courseId:String(courseId),courseWorkId:String(item.id),title:item.title||'งานจาก Google Classroom',description:item.description||'',state:item.state||'PUBLISHED',dueDate:item.dueDate||null,dueTime:item.dueTime||null,alternateLink:item.alternateLink||null,materials:item.materials||[],submissionState:submission?.state||'NEW',submitted:['TURNED_IN','RETURNED'].includes(submission?.state||'')}}));return{course:{id:String(course.id),name:course.name,section:course.section||'',room:course.room||'',description:course.description||'',alternateLink:course.alternateLink||''},topics:(topicData.topic||[]).map(topic=>({id:String(topic.topicId||topic.id),name:topic.name||''})),coursework,announcements:announcementData.announcements||[],commentsNotice:'ความคิดเห็นใน Classroom เปิดผ่านลิงก์กระทู้ของ Google Classroom ได้โดยตรง'}}
async function uploadDriveFile(token,file){const fresh=await refreshToken(token),boundary=`studyflow-${Date.now()}-${Math.random().toString(16).slice(2)}`,mime=file.mimeType||'application/octet-stream',metadata=JSON.stringify({name:file.name,mimeType:mime}),content=Buffer.from(String(file.data||'').replace(/^data:[^,]+,/,''),'base64');const head=Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),tail=Buffer.from(`\r\n--${boundary}--`);const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body:Buffer.concat([head,content,tail])});if(!response.ok)throw new Error(`อัปโหลดไฟล์ไป Drive ไม่สำเร็จ (${response.status})`);return response.json()}
async function submitClassroomFile(courseId,courseWorkId,token,file){const uploaded=await uploadDriveFile(token,file);const data=await googleApi(`courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions?userId=me&pageSize=10`,token);const submission=data.studentSubmissions?.[0];if(!submission)throw new Error('ไม่พบใบส่งงานของนักเรียน');const fresh=await refreshToken(token),attach=await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submission.id}:modifyAttachments`,{method:'POST',headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({addAttachments:[{driveFile:{driveFile:{id:uploaded.id}}}]})});if(!attach.ok)throw new Error(`แนบไฟล์ใน Classroom ไม่สำเร็จ (${attach.status})`);const turnedIn=await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submission.id}:turnIn`,{method:'POST',headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':'application/json'},body:'{}'});if(!turnedIn.ok)throw new Error(`ส่งงานไม่สำเร็จ (${turnedIn.status})`);return{state:'TURNED_IN',file:uploaded}}
async function getClassroomTasksWithRefs(token){const tasks=await getClassroomTasks(token);return tasks.map(task=>{const match=String(task.link||'').match(/\/c\/([^/]+)\/a\/([^/]+)/);return match?{...task,courseId:match[1],courseWorkId:match[2]}:task})}
async function getCoursesFast(token){const fresh=await refreshToken(token),data=await googleFetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=100',fresh);return Promise.all((data.courses||[]).map(async course=>{const [topicData,workData]=await Promise.all([googleApi(`courses/${course.id}/topics?pageSize=100`,fresh).catch(()=>({topic:[]})),googleApi(`courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,fresh).catch(()=>({courseWork:[]}))]);const topicRefs=[...(topicData.topic||[]).filter(x=>x.name).map(x=>({id:`topic:${x.topicId||x.id}`,name:x.name,kind:'content',topicId:String(x.topicId||x.id)})),...(workData.courseWork||[]).filter(x=>x.title).map(x=>({id:`work:${x.id}`,name:x.title,kind:x.materials?.length&&(!x.dueDate||/สื่อ|เอกสาร|slide|สไลด์|บท|lesson|lecture|เนื้อหา|material|กิจกรรมออนไลน์|กิจกรรมการเรียน|ใบความรู้/i.test(x.title))?'content':'work',courseWorkId:String(x.id),topicId:x.topicId?String(x.topicId):'',hasMaterials:Boolean(x.materials?.length),dueDate:Boolean(x.dueDate)}))];return{id:String(course.id),name:course.name,section:course.section||'',room:course.room||'',description:course.descriptionHeading||course.description||'',alternateLink:course.alternateLink||'',teacher:'Google Classroom',subjects:[{id:String(course.id),name:course.name,topics:topicRefs.map(x=>x.name).slice(0,20),topicRefs:topicRefs.slice(0,20)}]}}))}
async function getClassroomCourseContentFastFresh(courseId,token){const fresh=await refreshToken(token),course=await googleFetch(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}`,fresh),[workData,announcementData,topicData]=await Promise.all([googleApi(`courses/${courseId}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,fresh).catch(error=>{if(/429|quota exceeded/i.test(error.message))throw error;return{courseWork:[]}}),googleApi(`courses/${courseId}/announcements?announcementStates=PUBLISHED&pageSize=100`,fresh).catch(error=>{if(/429|quota exceeded/i.test(error.message))throw error;return{announcements:[]}}),googleApi(`courses/${courseId}/topics?pageSize=100`,fresh).catch(error=>{if(/429|quota exceeded/i.test(error.message))throw error;return{topic:[]}})]);return{course:{id:String(course.id),name:course.name,section:course.section||'',room:course.room||'',description:course.description||'',alternateLink:course.alternateLink||''},topics:(topicData.topic||[]).map(topic=>({id:String(topic.topicId||topic.id),name:topic.name||''})),coursework:(workData.courseWork||[]).map(item=>({courseId:String(courseId),courseWorkId:String(item.id),topicId:item.topicId?String(item.topicId):'',title:item.title||'งานจาก Google Classroom',description:item.description||'',state:item.state||'PUBLISHED',dueDate:item.dueDate||null,dueTime:item.dueTime||null,alternateLink:item.alternateLink||null,materials:item.materials||[],submissionState:'UNKNOWN',submitted:null})),announcements:announcementData.announcements||[],commentsNotice:'เนื้อหา งาน และไฟล์เปิดจาก StudyFlow ได้โดยตรง ส่วนความคิดเห็น Classroom ยังไม่มี API สำหรับฝังเป็นระบบ native'}}
async function getClassroomCourseContentFast(courseId,token){const key=String(courseId),cached=classroomContentCache.get(key);if(cached&&Date.now()-cached.updatedAt<120000)return cached.data;const data=await getClassroomCourseContentFastFresh(courseId,token);classroomContentCache.set(key,{updatedAt:Date.now(),data});return data}
