// RamReply — 하이톡 학부모 메시지 답장 도우미 (윈도우 트레이 앱)
// 숨은 창에 하이톡을 띄워 두고 30초마다 안 읽은 학부모 메시지를 확인한다.
// 새 메시지가 오면 답장 초안을 만들어 카카오톡(중계 서버)과 PC 알림으로 묻고, 승인되면 하이톡으로 보낸다.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

const RELAY = 'https://hitalk-relay.dpfkadpfka.workers.dev';
const HITALK = 'https://www.hiclass.net/hitalk';
const APP_ID = 'kr.yeram.ramreply';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId(APP_ID);

// ===== 저장소 (사용자 폴더의 JSON 파일) =====
const STORE = path.join(app.getPath('userData'), 'store.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch {}
const get = (k, d) => (db[k] === undefined ? d : db[k]);
let saveTimer = null;
function set(o) {
  Object.assign(db, o);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STORE, JSON.stringify(db)), 200);
}

let drafts = null;
function settings() {
  return {
    enabled: true, learnFromPast: true, kakao: true, pcNotify: true, students: false, autoStart: true,
    title: '학부모님', autoTitle: false, rules: drafts.DEFAULT_RULES, fallback: drafts.DEFAULT_FALLBACK,
    ...get('settings', {}),
  };
}

// ===== 중계 서버 =====
async function device() {
  let d = get('device', null);
  if (!d) {
    const r = await fetch(`${RELAY}/api/register`, { method: 'POST' });
    d = await r.json();
    set({ device: d });
  }
  return d;
}
async function relay(p, opt = {}) {
  const d = await device();
  const r = await fetch(`${RELAY}${p}`, {
    ...opt, headers: { 'Content-Type': 'application/json', 'X-Device': d.device, 'X-Secret': d.secret },
  });
  if (r.status === 401) { set({ device: null }); throw new Error('relay unauthorized'); }
  return r.json();
}

// ===== 창 =====
let tray = null, hiWin = null, setWin = null;
const approveWins = {};
const ICON = path.join(__dirname, 'assets', 'icon.png');
const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

function createHitalkWindow() {
  hiWin = new BrowserWindow({
    width: 1200, height: 860, show: false, icon: ICON, title: '하이클래스 (RamReply)',
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:hiclass', backgroundThrottling: false },
  });
  hiWin.webContents.setUserAgent(chromeUA);
  hiWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); hiWin.hide(); } });
  // 로그인 뒤 다른 화면으로 가면 하이톡으로 다시 보냄
  hiWin.webContents.on('did-navigate', (_e, url) => {
    if (/hiclass\.net\/main/.test(url)) setTimeout(() => hiWin.loadURL(HITALK), 800);
    if (/hiclass\.net\/hitalk/.test(url) && get('loginShown', false)) {
      set({ loginShown: false, status: 'ok' });
      setTimeout(() => hiWin.hide(), 1500);
      notify('하이클래스 로그인 완료', '이제 창을 닫아도 뒤에서 하이톡을 확인해요.');
    }
  });
  // 새 창(구글·카카오 로그인 팝업 등)은 같은 세션의 창으로 열기
  hiWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: 'persist:hiclass' } },
  }));
  hiWin.webContents.on('did-create-window', (w) => w.webContents.setUserAgent(chromeUA));
  hiWin.loadURL(HITALK);
}

function showLogin() {
  set({ loginShown: true, status: 'login' });
  hiWin.show();
  hiWin.focus();
}

function openSettings() {
  if (setWin) { setWin.show(); setWin.focus(); return; }
  setWin = new BrowserWindow({
    width: 820, height: 900, icon: ICON, title: 'RamReply 설정', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  setWin.loadFile('settings.html');
  setWin.on('closed', () => { setWin = null; });
}

function openApprove(id) {
  if (approveWins[id]) { approveWins[id].show(); approveWins[id].focus(); return; }
  const w = new BrowserWindow({
    width: 460, height: 620, icon: ICON, title: '답장 확인', autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  w.loadFile('approve.html', { query: { id } });
  w.on('closed', () => delete approveWins[id]);
  approveWins[id] = w;
}

function notify(title, body, onClick) {
  const n = new Notification({ title, body, icon: ICON });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ===== 하이톡 창 안에서 실행 =====
const INJECT = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
async function ht(call) {
  if (!hiWin || hiWin.webContents.isLoading()) return null;
  if (!/hiclass\.net\/hitalk/.test(hiWin.webContents.getURL())) return { login: true };
  await hiWin.webContents.executeJavaScript(INJECT);
  return hiWin.webContents.executeJavaScript(`window.__ht.${call}`);
}

// ===== 새 메시지 처리 =====
let notReady = 0;
async function tick() {
  const s = settings();
  if (!s.enabled || !hiWin) return;
  try {
    const url = hiWin.webContents.getURL();
    if (!/hiclass\.net/.test(url)) { hiWin.loadURL(HITALK); return; }
    const r = await ht('scan()');
    if (!r) return;
    if (r.login) {
      if (get('status') !== 'login') {
        set({ status: 'login' });
        if (!get('lastScan', 0)) showLogin();
        else notify('하이클래스 로그인이 필요해요', '눌러서 로그인해 주세요.', showLogin);
        relayNotice('⚠️ RamReply: 하이클래스 로그인이 풀렸어요. 컴퓨터에서 로그인해 주세요.');
      }
      if (!/hiclass\.net\/(login|signin|member|auth)/i.test(url) && !/hitalk/.test(url)) hiWin.loadURL(HITALK);
      return;
    }
    if (r.notReady) {
      notReady++;
      if (notReady >= 4) { notReady = 0; hiWin.loadURL(HITALK); }
      return;
    }
    notReady = 0;
    if (r.rooms) {
      set({ lastScan: Date.now(), status: 'ok' });
      await onScan(r.rooms, s);
      if (!get('learnedOnce', false)) { set({ learnedOnce: true }); learnNow().catch(() => {}); }
    }
  } catch (e) { console.warn('tick', e); }
  await pollRelay();
}

async function relayNotice(text) {
  try { await relay('/api/items', { method: 'POST', body: JSON.stringify({ room: '알림', msg: text, draft: '', notify: text }) }); } catch {}
}

async function onScan(rooms, s) {
  const seen = get('seen', null);
  const next = { ...(seen || {}) };
  const fresh = [];
  for (const r of rooms) {
    if (seen && r.unread && seen[r.room] !== r.preview && (s.students || /학부모/.test(r.room))) fresh.push(r);
    next[r.room] = r.preview;
  }
  set({ seen: next });
  if (!seen) return;
  for (const r of fresh) await handleIncoming(r, s);
}

async function handleIncoming(r, s) {
  const examples = s.learnFromPast ? get('examples', []) : [];
  const { draft, label } = drafts.draftFromExamples(r.room, r.preview, examples, s) || drafts.makeDraft(r.room, r.preview, s);
  const notifyText = s.kakao
    ? `📩 ${r.room}\n"${r.preview.slice(0, 70)}${r.preview.length > 70 ? '…' : ''}"${r.count > 1 ? ` 외 ${r.count - 1}개` : ''}\n\n이렇게 답장할까요?\n${draft}`
    : '';
  let item = null;
  try {
    item = await relay('/api/items', { method: 'POST', body: JSON.stringify({ room: r.room, msg: r.preview, draft, notify: notifyText }) });
  } catch (e) { console.warn(e); }
  const id = item?.id || 'local-' + Date.now();
  const pending = get('pending', {});
  pending[id] = { room: r.room, msg: r.preview, draft, label, created: Date.now(), test: !!r.test };
  set({ pending });
  addLog({ room: r.room, msg: r.preview, label });
  if (s.pcNotify) notify(`📩 ${r.room}`, `${r.preview.slice(0, 80)}\n→ ${draft.slice(0, 100)}\n(눌러서 확인)`, () => openApprove(id));
}

function addLog(o) {
  const log = get('log', []);
  log.unshift({ t: Date.now(), ...o });
  set({ log: log.slice(0, 50) });
}

function addExamples(room, pairs) {
  const { given } = drafts.parseRoom(room);
  const ex = get('examples', []);
  const seen = new Set(ex.map((e) => e.msg + '|' + e.reply));
  for (const p of pairs) {
    if (p.reply.length > 220 || p.msg.length > 300) continue;
    const k = p.msg + '|' + p.reply;
    if (seen.has(k)) continue;
    seen.add(k);
    ex.unshift({ msg: p.msg, reply: p.reply, given, label: drafts.labelOf(p.msg), t: Date.now() });
  }
  set({ examples: ex.slice(0, 500) });
}

async function doSend(id, room, text) {
  const pending = get('pending', {});
  const p = pending[id];
  let res;
  if (p?.test || room.endsWith('(테스트)')) {
    res = { ok: true, note: 'test' };
    notify('테스트 성공', '[보내기] 신호를 받았어요. 테스트라서 하이톡으로 실제로 보내지는 않았어요.');
  } else {
    res = (await ht(`send(${JSON.stringify(room)}, ${JSON.stringify(text)})`)) || { ok: false, note: '하이톡 창 응답 없음' };
    if (res.login) res = { ok: false, note: '하이클래스 로그인 필요' };
  }
  if (res.ok && p?.msg && !p.test) addExamples(room, [{ msg: p.msg, reply: text }]);
  delete pending[id];
  const seen = get('seen', {});
  if (!p?.test) seen[room] = text;
  set({ pending, seen });
  addLog({ room, msg: text, label: res.ok ? '보냄' : '실패' });
  if (!res.ok) notify('하이톡 전송 실패', `${room}: ${res.note || ''}\n하이톡에서 직접 보내 주세요.`);
  return res;
}

async function pollRelay() {
  try {
    const { items } = await relay('/api/poll');
    for (const it of items || []) {
      const res = await doSend(it.id, it.room, it.final);
      await relay('/api/done', { method: 'POST', body: JSON.stringify({ id: it.id, ok: res.ok, note: res.note }) });
      if (approveWins[it.id]) approveWins[it.id].close();
    }
  } catch (e) { console.warn('poll', e); }
}

async function learnNow() {
  const r = (await ht('learn(60)')) || [];
  if (Array.isArray(r)) for (const x of r) addExamples(x.room, x.pairs);
  return { ok: true, rooms: Array.isArray(r) ? r.length : 0, examples: get('examples', []).length };
}

// ===== 설정 화면·확인 창과 주고받기 =====
ipcMain.handle('api', async (_e, msg) => {
  switch (msg.type) {
    case 'info': {
      let kakao = false;
      try { kakao = !!(await relay('/api/status')).kakao; } catch {}
      return { kakao, lastScan: get('lastScan', 0), status: get('status', ''), log: get('log', []), examples: get('examples', []).length };
    }
    case 'getSettings': return settings();
    case 'setSettings': {
      set({ settings: { ...get('settings', {}), ...msg.patch } });
      if ('autoStart' in msg.patch) applyAutoStart();
      return { ok: true };
    }
    case 'defaults': return { rules: drafts.DEFAULT_RULES, fallback: drafts.DEFAULT_FALLBACK };
    case 'kakaoLogin': { const { url } = await relay('/api/kakao/link', { method: 'POST' }); shell.openExternal(url); return { ok: true }; }
    case 'kakaoLogout': await relay('/api/kakao/unlink', { method: 'POST' }); return { ok: true };
    case 'openHitalk': hiWin.show(); hiWin.focus(); return { ok: true };
    case 'learnNow': return learnNow();
    case 'test': {
      await handleIncoming({ room: '홍길동 학부모(테스트)', preview: '선생님, 길동이가 열이 나서 오늘 병원 들렀다가 3교시쯤 등교하려고 합니다.', count: 1, test: true }, settings());
      return { ok: true };
    }
    case 'getPending': return get('pending', {})[msg.id] || null;
    case 'approve': {
      const p = get('pending', {})[msg.id];
      if (!p) return { ok: false, note: '이미 처리된 메시지예요' };
      const res = await doSend(msg.id, p.room, msg.text);
      if (!msg.id.startsWith('local-')) relay('/api/local', { method: 'POST', body: JSON.stringify({ id: msg.id, status: res.ok ? 'sent' : 'failed', final: msg.text }) }).catch(() => {});
      return res;
    }
    case 'reject': {
      const pending = get('pending', {});
      delete pending[msg.id];
      set({ pending });
      if (!msg.id.startsWith('local-')) relay('/api/local', { method: 'POST', body: JSON.stringify({ id: msg.id, status: 'rejected' }) }).catch(() => {});
      return { ok: true };
    }
    case 'version': return app.getVersion();
  }
});

function applyAutoStart() {
  app.setLoginItemSettings({ openAtLogin: settings().autoStart, args: ['--hidden'] });
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('RamReply · 하이톡 답장 도우미');
  const menu = () => Menu.buildFromTemplate([
    { label: '설정 · 답장 틀', click: openSettings },
    { label: '하이톡 화면 보기', click: () => { hiWin.show(); hiWin.focus(); } },
    { label: '지금 확인하기', click: () => tick() },
    { type: 'separator' },
    { label: '컴퓨터 켤 때 자동 시작', type: 'checkbox', checked: settings().autoStart,
      click: (i) => { set({ settings: { ...get('settings', {}), autoStart: i.checked } }); applyAutoStart(); } },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', openSettings);
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

app.on('second-instance', openSettings);
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  drafts = await import(pathToFileURL(path.join(__dirname, 'drafts.mjs')).href);
  buildTray();
  applyAutoStart();
  createHitalkWindow();
  const first = !get('started', false);
  set({ started: true });
  if (first || !process.argv.includes('--hidden')) openSettings();
  // 새 버전 자동 업데이트 (깃허브 릴리스)
  const checkUpdate = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  if (app.isPackaged) { setTimeout(checkUpdate, 60 * 1000); setInterval(checkUpdate, 6 * 3600 * 1000); }
  setTimeout(tick, 8000);
  setInterval(tick, 30000);
  // 오래 켜 두면 화면이 굳는 것을 막으려고 20분마다 새로 불러옴
  setInterval(() => { if (!hiWin.isVisible()) hiWin.loadURL(HITALK); }, 20 * 60 * 1000);
});
