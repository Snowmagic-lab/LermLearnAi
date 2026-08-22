/* StudyFlow shell interactions. Feature logic stays in app.js. */
(() => {
  const body = document.body;
  const sidebar = document.querySelector('#app-sidebar');
  const navScrim = document.querySelector('#nav-scrim');
  const sidebarToggle = document.querySelector('#sidebar-toggle');
  const sidebarClose = document.querySelector('#sidebar-close');
  const palette = document.querySelector('#command-palette');
  const paletteInput = document.querySelector('#command-input');
  const paletteList = document.querySelector('#command-list');
  const pageContext = document.querySelector('#page-context');
  const mobileQuery = window.matchMedia('(max-width: 720px)');

  const pageMeta = {
    dashboard: ['พื้นที่วางแผนการเรียนที่จัดระเบียบให้คุณทีละวงโคจร', 'ภาพรวม'],
    tasks: ['รวมงานที่กำลังขยับ งานที่เสร็จแล้ว และกำหนดส่งไว้ในคิวเดียว', 'งานทั้งหมด'],
    calendar: ['มองเห็น deadline, เวลาติว และช่วงลงมือทำในสัปดาห์เดียว', 'ปฏิทินการเรียน'],
    classroom: ['เปิดดูห้อง งาน ประกาศ ไฟล์ และการส่งงานในพื้นที่เดียว', 'ศูนย์ห้องเรียน'],
    study: ['เปลี่ยนเนื้อหาจาก Classroom ให้กลายเป็นเส้นทางการเรียนที่เข้าใจง่าย', 'ห้องติว'],
    settings: ['ควบคุมการเชื่อมต่อ การพักผ่อน และวิธีที่ StudyFlow ช่วยคุณ', 'ตั้งค่า']
  };

  const commands = [
    { id: 'dashboard', label: 'เปิดภาพรวม', hint: 'กลับไปที่ Orbit dashboard', icon: '◈', view: 'dashboard' },
    { id: 'tasks', label: 'ดูงานทั้งหมด', hint: 'ตรวจคิวงานและสถานะ', icon: '☷', view: 'tasks' },
    { id: 'calendar', label: 'เปิดปฏิทิน', hint: 'วางแผนเวลาทั้งสัปดาห์', icon: '▦', view: 'calendar' },
    { id: 'classroom', label: 'เปิดศูนย์ห้องเรียน', hint: 'ดูงาน ประกาศ และส่งงานจาก Classroom', icon: '▤', view: 'classroom' },
    { id: 'study', label: 'เข้าห้องติว', hint: 'เลือกวิชาและบทเรียนจาก Classroom', icon: '✺', view: 'study' },
    { id: 'focus', label: 'เริ่ม focus sprint', hint: 'เริ่มโหมดโฟกัส 25 นาที', icon: '◎', action: () => document.querySelector('#start-focus')?.click() },
    { id: 'add', label: 'เพิ่มงานใหม่', hint: 'ใส่งานที่ต้องทำด้วยตัวเอง', icon: '+', action: () => document.querySelector('#quick-add')?.click() },
    { id: 'sync', label: 'ซิงก์ข้อมูลล่าสุด', hint: 'ดึงงานจาก Classroom และ Calendar อีกครั้ง', icon: '↻', action: () => { document.dispatchEvent(new CustomEvent('studyflow:sync')); document.dispatchEvent(new CustomEvent('studyflow:toast', { detail: 'กำลังซิงก์ข้อมูลล่าสุด' })); } }
  ];

  const isMobile = () => mobileQuery.matches;

  const setPageMeta = (page) => {
    const meta = pageMeta[page] || pageMeta.dashboard;
    if (pageContext) pageContext.textContent = meta[0];
    body.dataset.page = page;
  };

  const currentPage = () => document.querySelector('.view.active-view')?.id?.replace(/-view$/, '') || 'dashboard';

  const closeMobileNav = () => {
    body.classList.remove('mobile-nav-open');
    sidebarToggle?.setAttribute('aria-expanded', 'false');
  };

  const toggleShell = () => {
    if (isMobile()) {
      const open = body.classList.toggle('mobile-nav-open');
      sidebarToggle?.setAttribute('aria-expanded', String(open));
      return;
    }
    const collapsed = body.classList.toggle('sidebar-collapsed');
    sidebarToggle?.setAttribute('aria-expanded', String(!collapsed));
  };

  sidebarToggle?.addEventListener('click', toggleShell);
  sidebarClose?.addEventListener('click', closeMobileNav);
  navScrim?.addEventListener('click', closeMobileNav);
  window.addEventListener('resize', () => {
    if (!isMobile()) closeMobileNav();
    sidebarToggle?.setAttribute('aria-expanded', isMobile() ? String(body.classList.contains('mobile-nav-open')) : String(!body.classList.contains('sidebar-collapsed')));
  });

  document.addEventListener('click', (event) => {
    const viewTrigger = event.target.closest?.('[data-view]');
    if (viewTrigger) {
      window.setTimeout(() => {
        setPageMeta(currentPage());
        if (isMobile()) closeMobileNav();
      }, 0);
    }
    const commandTrigger = event.target.closest?.('[data-command]');
    if (commandTrigger) runCommand(commandTrigger.dataset.command);
  });

  const renderCommands = (query = '') => {
    const normalized = query.trim().toLowerCase();
    const matches = commands.filter(command => !normalized || `${command.label} ${command.hint}`.toLowerCase().includes(normalized));
    paletteList.innerHTML = matches.length ? matches.map(command => `<button class="command-item" type="button" data-palette-command="${command.id}"><span aria-hidden="true">${command.icon}</span><span><strong>${command.label}</strong><small>${command.hint}</small></span></button>`).join('') : '<div class="command-empty">ไม่พบคำสั่งที่ตรงกัน</div>';
  };

  const openPalette = () => {
    if (!palette) return;
    renderCommands();
    palette.hidden = false;
    paletteInput?.focus();
  };

  const closePalette = () => {
    if (!palette) return;
    palette.hidden = true;
    paletteInput.value = '';
  };

  const runCommand = (id) => {
    const command = commands.find(item => item.id === id);
    if (!command) return;
    closePalette();
    if (command.view) document.querySelector(`.nav-item[data-view="${command.view}"]`)?.click();
    if (command.action) command.action();
  };

  document.querySelector('#command-center')?.addEventListener('click', openPalette);
  paletteInput?.addEventListener('input', () => renderCommands(paletteInput.value));
  paletteList?.addEventListener('click', event => {
    const item = event.target.closest?.('[data-palette-command]');
    if (item) runCommand(item.dataset.paletteCommand);
  });
  palette?.addEventListener('click', event => { if (event.target === palette) closePalette(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
    if (event.key === 'Escape') { closePalette(); if (isMobile()) closeMobileNav(); }
  });

  document.querySelectorAll('button').forEach(button => {
    button.addEventListener('pointerdown', () => button.classList.add('btn-press'));
    ['pointerup', 'pointerleave', 'blur'].forEach(type => button.addEventListener(type, () => button.classList.remove('btn-press')));
  });
  document.addEventListener('pointerdown', event => event.target.closest?.('button')?.classList.add('btn-press'));
  document.addEventListener('pointerup', event => event.target.closest?.('button')?.classList.remove('btn-press'));

  const sleepStart = document.querySelector('#sleep-start');
  const sleepEnd = document.querySelector('#sleep-end');
  try {
    const savedSleep = JSON.parse(localStorage.getItem('studyflow.sleepWindow') || 'null');
    if (savedSleep?.start && sleepStart) sleepStart.value = savedSleep.start;
    if (savedSleep?.end && sleepEnd) sleepEnd.value = savedSleep.end;
  } catch {}
  const saveSleepWindow = () => {
    if (!sleepStart?.value || !sleepEnd?.value) return;
    localStorage.setItem('studyflow.sleepWindow', JSON.stringify({ start: sleepStart.value, end: sleepEnd.value }));
    document.dispatchEvent(new CustomEvent('studyflow:toast', { detail: `บันทึกเวลานอน ${sleepStart.value} – ${sleepEnd.value} แล้ว` }));
  };
  [sleepStart, sleepEnd].forEach(input => input?.addEventListener('change', saveSleepWindow));
  document.querySelectorAll('.switch input').forEach(input => input.addEventListener('change', () => document.dispatchEvent(new CustomEvent('studyflow:toast', { detail: input.checked ? 'เปิดการแจ้งเตือนสรุปแล้ว' : 'ปิดการแจ้งเตือนสรุปแล้ว' }))));

  const reveal = () => {
    document.querySelectorAll('.reveal:not(.is-visible)').forEach(node => node.classList.add('is-visible'));
  };
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add('is-visible'); }), { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
  } else reveal();

  setPageMeta(currentPage());
})();

// Keep top-level page navigation reversible without interfering with feature-level
// back buttons, modals, or Classroom course navigation.
(() => {
  const backButton = document.querySelector('#global-back');
  if (!backButton) return;
  const history = ['dashboard'];
  let replaying = false;
  const sync = () => {
    const canGoBack = history.length > 1;
    backButton.disabled = !canGoBack;
    backButton.setAttribute('aria-disabled', String(!canGoBack));
  };
  document.addEventListener('click', event => {
    const nav = event.target.closest?.('.nav-item[data-view]');
    if (!nav) return;
    const page = nav.dataset.view;
    if (!replaying && history[history.length - 1] !== page) {
      history.push(page);
      if (history.length > 30) history.shift();
    }
    sync();
  });
  backButton.addEventListener('click', () => {
    if (history.length <= 1) return;
    history.pop();
    const page = history[history.length - 1] || 'dashboard';
    replaying = true;
    document.querySelector(`.nav-item[data-view="${page}"]`)?.click();
    replaying = false;
    sync();
  });
  sync();
})();
