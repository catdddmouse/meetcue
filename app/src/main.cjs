'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, screen, systemPreferences, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transcript } = require('./transcript.cjs');
const { loadIntents, INTENTS, LOOKBACKS, DEFAULT_SHORTCUTS, DISPLAY_RULE, intent, lookback } = require('./intents.cjs');
const { Ocr } = require('./ocr.cjs');
const { CicadaSource } = require('./cicada.cjs');

app.setName('MeetCue');
app.setPath('userData', path.join(app.getPath('appData'), 'Meeting Prompter'));
if (!app.requestSingleInstanceLock()) { app.quit(); }
const bridge = require('./bridge.cjs');

const ROOT = path.resolve(__dirname, '..');
const OCR_BIN = fs.existsSync(path.join(process.resourcesPath || '', 'prompter-ocr')) ? path.join(process.resourcesPath, 'prompter-ocr') : path.join(ROOT, 'build/prompter-ocr');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = { preferredPartner: '', windowApp: '', source: 'ocr', targetId: '', targetLabel: '', windowTitle: '', region: null, intervalMs: 1200, lookbackKey: '3', hideFromShare: true, bounds: null };
let settings = { ...defaults };
function loadSettings() { try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...defaults }; } }
function saveSettings() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 }); }

const transcript = new Transcript();
const ocr = new Ocr(OCR_BIN);
const cicada = new CicadaSource(transcript);
let win, selector, targets = [], session = { active: false, windowId: null, startedAt: null }, inflight = null, shortcutResults = {};
let lastAsk = null;

ocr.on('frame', m => { if (ocrFailing) { ocrFailing = false; diag('capture-ok', {}); } if (session.active) { const j = transcript.stats.jumps; transcript.ingest(m.lines || [], m.at); if (transcript.stats.jumps > j) diag('jump', {}); } });
// 诊断日志：只记事件和计数，不记会议文字；下次开始本场时清空
function diag(type, extra) { if (!session.active) return; try { fs.appendFileSync(path.join(app.getPath('userData'), 'diag.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, ...extra }) + '\n'); } catch {} }
let ocrFailing = false, staleWarned = false;
ocr.on('ocr-error', m => { if (!ocrFailing) { ocrFailing = true; diag('capture-error', { message: m.message }); send('notice', { level: 'warning', text: '读不到飞书窗口（' + m.message + '），正在自动重试；窗口别最小化、别切到别的桌面' }); } });
ocr.on('tick', () => { if (ocrFailing) { ocrFailing = false; diag('capture-ok', {}); send('notice', { level: 'success', text: '已恢复读取' }); } });
ocr.on('window', m => diag('window-changed', { windowId: m.windowId }));
setInterval(() => {
  if (!session.active || settings.source !== 'ocr') return;
  const last = transcript.stats.lastChangeAt || session.startedAt, idle = Date.now() - last;
  if (idle > 45000 && !staleWarned) { staleWarned = true; diag('stale', { idleSec: Math.round(idle / 1000), capturing: !ocrFailing }); send('notice', { level: 'warning', text: ocrFailing ? '读不到飞书窗口，正在重试' : '45 秒没有新文字：确认妙记还在录音转写、窗口没有被往上滚动' }); }
  if (idle < 45000 && staleWarned) { staleWarned = false; diag('resume', {}); }
}, 3000);
ocr.on('stopped', m => send('notice', { level: 'danger', text: '字幕读取已停止：' + (m.reason || '未知原因') }));

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send('prompter:' + ch, data); }

function status() {
  const lb = lookback(settings.lookbackKey);
  const recent = [transcript.recent(240)];
  return {
    session: { ...session }, source: settings.source, ocr: ocr.status(), cicada: cicada.status(), lines: transcript.entries.length, chars: transcript.text.length, merge: transcript.stats, idleSec: session.active && settings.source === 'ocr' ? Math.round((Date.now() - (transcript.stats.lastChangeAt || session.startedAt)) / 1000) : null, capturing: !ocrFailing, recent,
    lookback: lb, target: { id: settings.targetId, label: settings.targetLabel },
    inflight: inflight ? { intent: inflight.intent.label, startedAt: inflight.startedAt, state: inflight.state } : null,
    shortcuts: shortcutResults, settings: { windowTitle: settings.windowTitle, region: settings.region, intervalMs: settings.intervalMs, hideFromShare: settings.hideFromShare },
    screenPermission: systemPreferences.getMediaAccessStatus('screen')
  };
}

async function refreshTargets() {
  const r = await bridge.targets();
  targets = (r.targets || []).filter(t => t.kind === 'bot');
  if (!settings.targetId || !targets.some(t => t.id === settings.targetId)) {
    const pick = (settings.preferredPartner && targets.find(t => t.label.includes(settings.preferredPartner))) || targets[0];
    if (pick) { settings.targetId = pick.id; settings.targetLabel = pick.label; saveSettings(); }
  }
  return targets;
}

async function findWindow() {
  const r = await ocr.call('list');
  const wins = r.windows || [];
  if (session.windowId && wins.some(w => w.windowId === session.windowId)) return session.windowId;
  const byTitle = settings.windowTitle && wins.find(w => w.title === settings.windowTitle && (!settings.windowApp || w.app === settings.windowApp));
  return (byTitle || wins[0] || {}).windowId || null;
}

// 飞书妙记「实时转写」窗口：左侧是转写正文，右侧是实时总结，默认只读左侧
const PRESETS = { '实时转写': { x: 0.03, y: 0.21, w: 0.44, h: 0.62 } };
async function rememberWindow(id) {
  const r = await ocr.call('list'); const w = (r.windows || []).find(x => x.windowId === id);
  if (w) {
    if (w.title !== settings.windowTitle && !settings.regionByTitle?.[w.title]) settings.region = PRESETS[w.title] || null;
    settings.windowTitle = w.title; settings.windowApp = w.app; saveSettings();
  }
}
ocr.on('window', m => { session.windowId = m.windowId; });
async function startSession(windowId) {
  if (session.active) await endSession();
  transcript.clear(); ocrFailing = false; staleWarned = false;
  try { fs.rmSync(path.join(app.getPath('userData'), 'diag.jsonl'), { force: true }); } catch {}
  if (settings.source === 'cicada') {
    cicada.start(Date.now());
    session = { active: true, windowId: null, startedAt: Date.now() };
    return status();
  }
  const id = windowId || await findWindow();
  if (!id) throw Error('没有找到飞书窗口，请先打开飞书会议');
  await rememberWindow(id);
  await ocr.start(id, settings.region, settings.intervalMs, settings.windowTitle, settings.windowApp);
  session = { active: true, windowId: id, startedAt: Date.now() };
  diag('start', { windowTitle: settings.windowTitle });
  return status();
}
async function endSession() {
  await ocr.stop(); cicada.stop(); cancelAsk(); transcript.clear(); lastAsk = null;
  session = { active: false, windowId: null, startedAt: null };
  return status();
}

function cancelAsk() { if (inflight) { inflight.ctl.abort(); inflight = null; } }

async function ask(intentKey) {
  const it = intent(intentKey); if (!it) return;
  showWindow(false);
  if (inflight) { send('notice', { level: 'warning', text: `「${inflight.intent.label}」还在等伙伴回复；option + esc 可取消` }); return; }
  if (!settings.targetId) { send('notice', { level: 'danger', text: '还没选伙伴：先在设置里连接 Cindy 并选择伙伴' }); return; }
  const lb = lookback(settings.lookbackKey);
  const entries = transcript.since(lb.ms);
  const text = transcript.format(entries, lb.maxChars);
  if (!entries.length) { send('notice', { level: 'danger', text: session.active ? `最近 ${lb.label} 没有读到字幕，确认飞书字幕面板开着并在框选区域内` : '还没开始本场：先点「开始本场」读取飞书字幕，或手动粘贴一段' }); return; }
  const question = it.question + DISPLAY_RULE;
  const signature = crypto.createHash('sha256').update(JSON.stringify([settings.targetId, text, question])).digest('hex');
  if (lastAsk?.signature === signature && lastAsk.answer) { send('answer', { ...lastAsk.payload, reused: true }); return; }
  const id = 'mp-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const ctl = new AbortController();
  inflight = { id, intent: it, startedAt: Date.now(), state: 'sending', ctl };
  const meta = { id, intent: it.label, intentKey: it.key, partner: settings.targetLabel, lookback: lb.label, lines: entries.length, chars: text.length, startedAt: inflight.startedAt };
  send('ask-start', meta);
  try {
    const r = await bridge.ask({ id, targetId: settings.targetId, transcript: text, question, signal: ctl.signal,
      onState: s => { if (inflight?.id === id) { inflight.state = s.state; send('ask-state', { id, state: s.state }); } } });
    if (inflight?.id !== id) return;
    const payload = { ...meta, answer: r.answer, partner: r.label || meta.partner, ms: r.ms, timing: r.timing };
    lastAsk = { signature, answer: r.answer, payload };
    send('answer', payload);
    log({ at: new Date().toISOString(), intent: it.key, lookback: lb.key, lines: entries.length, chars: text.length, ms: r.ms, timing: r.timing });
  } catch (e) {
    if (inflight?.id === id || !inflight) send('ask-error', { id, error: e.message });
  } finally { if (inflight?.id === id) inflight = null; }
}

function log(obj) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'ask-log.jsonl'), JSON.stringify(obj) + '\n'); } catch {} }

function setLookback(key) { settings.lookbackKey = lookback(key).key; saveSettings(); showWindow(false); send('notice', { level: 'primary', text: '回看时长：' + lookback(key).label }); }

function cyclePartner() {
  if (!targets.length) { send('notice', { level: 'warning', text: '伙伴名单还没加载，先连接 Cindy' }); return; }
  const i = targets.findIndex(t => t.id === settings.targetId);
  const next = targets[(i + 1) % targets.length];
  settings.targetId = next.id; settings.targetLabel = next.label; saveSettings();
  showWindow(false); send('notice', { level: 'primary', text: '提问对象：' + next.label });
}

let keyTest = false;
function registerShortcuts() {
  globalShortcut.unregisterAll(); shortcutResults = {};
  const labelOf = acc => { const k = acc.split('+').pop(); const it = INTENTS.find(i => acc === `${DEFAULT_SHORTCUTS.intentPrefix}+${i.key}`); return it ? it.label : ({ [DEFAULT_SHORTCUTS.lookbackCycle]: '切换回看时长', [DEFAULT_SHORTCUTS.toggle]: '显示 / 隐藏浮窗', [DEFAULT_SHORTCUTS.cyclePartner]: '切换伙伴', [DEFAULT_SHORTCUTS.cancel]: '取消等待' })[acc] || k; };
  const reg = (acc, fn) => { let ok = false; try { ok = globalShortcut.register(acc, () => { if (keyTest) { showWindow(false); send('keytest', { acc, label: labelOf(acc), at: Date.now() }); return; } fn(); }); } catch { ok = false; } shortcutResults[acc] = ok; };
  for (const it of INTENTS) reg(`${DEFAULT_SHORTCUTS.intentPrefix}+${it.key}`, () => void ask(it.key));
  reg(DEFAULT_SHORTCUTS.lookbackCycle, () => { const i = LOOKBACKS.findIndex(l => l.key === settings.lookbackKey); setLookback(LOOKBACKS[(i + 1) % LOOKBACKS.length].key); });
  reg(DEFAULT_SHORTCUTS.toggle, () => { if (win?.isVisible()) win.hide(); else showWindow(false); });
  reg(DEFAULT_SHORTCUTS.cyclePartner, cyclePartner);
  reg(DEFAULT_SHORTCUTS.cancel, () => { if (inflight) { const id = inflight.id; cancelAsk(); send('ask-error', { id, error: '已取消等待（伙伴那边已开始的回答可能仍会在 Cindy 里出现）' }); } });
}

function showWindow(focus = true) {
  if (!win || win.isDestroyed()) createWindow();
  if (!win.isVisible()) win.showInactive();
  if (focus) win.focus();
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let b = settings.bounds || { width: 560, height: 160, x: Math.round(wa.x + (wa.width - 560) / 2), y: wa.y + 12 };
  if (b.width < 540) b = { ...b, width: 560 };
  // 显示器换了或分辨率变了：记下的位置不在任何屏幕里就放回主屏顶部居中
  const visible = screen.getAllDisplays().some(d => { const r = d.workArea; return b.x >= r.x - 20 && b.y >= r.y - 20 && b.x + b.width <= r.x + r.width + 20 && b.y + 120 <= r.y + r.height; });
  if (!visible) b = { ...b, x: Math.round(wa.x + (wa.width - b.width) / 2), y: wa.y + 12 };
  win = new BrowserWindow({
    ...b, minWidth: 360, maxWidth: 900, frame: false, transparent: true, resizable: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false, title: 'MeetCue',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(!!settings.hideFromShare);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  const remember = () => { if (win && !win.isDestroyed()) { const { x, y, width } = win.getBounds(); settings.bounds = { x, y, width, height: settings.bounds?.height || 140 }; saveSettings(); } };
  win.on('moved', remember); win.on('resized', remember);
  win.loadFile(path.join(__dirname, 'ui/overlay.html'));
  win.once('ready-to-show', () => win.showInactive());
}

function openSelector(png, size) {
  if (selector && !selector.isDestroyed()) selector.close();
  const wa = screen.getPrimaryDisplay().workArea;
  const scale = Math.min((wa.width * 0.9) / size.width, (wa.height * 0.9 - 60) / size.height, 1);
  const w = Math.round(size.width * scale), h = Math.round(size.height * scale) + 60;
  selector = new BrowserWindow({ width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), title: '框选飞书字幕区域', alwaysOnTop: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  selector.loadFile(path.join(__dirname, 'ui/selector.html'), { query: { img: 'file://' + png, w: String(w), h: String(h - 60), region: JSON.stringify(settings.region || null) } });
}

function guard(event) {
  const ok = [win, selector].some(w => w && !w.isDestroyed() && event.sender === w.webContents);
  if (!ok) throw Error('无效来源');
}
const handle = (name, fn) => ipcMain.handle('prompter:' + name, async (event, arg) => { try { guard(event); return { ok: true, ...(await fn(arg, event)) }; } catch (e) { return { ok: false, error: e.message || '操作失败' }; } });

handle('status', () => status());
handle('meta', () => ({ intents: INTENTS.map(i => ({ key: i.key, label: i.label })), lookbacks: LOOKBACKS.map(l => ({ key: l.key, label: l.label })), shortcuts: DEFAULT_SHORTCUTS }));
handle('resize', arg => { if (win && Number.isFinite(arg?.height)) { const b = win.getBounds(); const h = Math.max(60, Math.min(900, Math.round(arg.height))); if (h !== b.height) win.setBounds({ ...b, height: h }); settings.bounds = { ...b, height: h }; } return {}; });
handle('bridge-status', async () => await bridge.status());
handle('connect', async () => await bridge.connect());
handle('pair-status', async () => { const r = await bridge.pairStatus(); if (r.connected) await refreshTargets().catch(() => {}); return r; });
handle('targets', async () => ({ targets: await refreshTargets(), selected: settings.targetId }));
handle('select-target', arg => { const t = targets.find(x => x.id === arg?.id); if (!t) throw Error('伙伴不在名单里'); settings.targetId = t.id; settings.targetLabel = t.label; saveSettings(); return {}; });
handle('windows', async () => { const r = await ocr.call('list'); return { windows: r.windows || [], selectedTitle: settings.windowTitle }; });
handle('permission', async () => { const r = await ocr.call('request-permission'); return { granted: r.granted, status: systemPreferences.getMediaAccessStatus('screen') }; });
handle('pick-region', async arg => {
  const windowId = arg?.windowId || await findWindow(); if (!windowId) throw Error('没有找到飞书窗口');
  await rememberWindow(windowId);
  const png = path.join(app.getPath('userData'), 'region-snapshot.png');
  const r = await ocr.call('snapshot', { windowId, path: png, title: settings.windowTitle, app: settings.windowApp });
  openSelector(png, { width: r.width, height: r.height });
  return {};
});
handle('save-region', async arg => {
  const r = arg?.region; if (r && !['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k]))) throw Error('区域无效');
  settings.region = r || null; saveSettings();
  if (selector && !selector.isDestroyed()) selector.close();
  fs.rmSync(path.join(app.getPath('userData'), 'region-snapshot.png'), { force: true });
  if (session.active) await ocr.start(session.windowId, settings.region, settings.intervalMs, settings.windowTitle, settings.windowApp);
  const test = await ocr.call('ocr-once', { windowId: session.windowId || await findWindow(), region: settings.region, title: settings.windowTitle, app: settings.windowApp });
  send('notice', { level: 'success', text: `字幕区域已保存，试读到 ${test.lines.length} 行（${test.ms} ms）` });
  return { lines: test.lines.map(l => l.text) };
});
handle('source', arg => { if (!['ocr', 'cicada'].includes(arg?.source)) throw Error('来源无效'); if (session.active) throw Error('先结束本场再切换来源'); settings.source = arg.source; saveSettings(); return {}; });
handle('select-window', async arg => { if (Number.isFinite(arg?.windowId)) await rememberWindow(arg.windowId); return {}; });
handle('start', async arg => await startSession(arg?.windowId));
handle('end', async () => await endSession());
handle('ask', arg => { void ask(String(arg?.key || '1')); return {}; });
handle('cancel', () => { cancelAsk(); return {}; });
handle('lookback', arg => { setLookback(String(arg?.key)); return {}; });
handle('manual', arg => { const t = String(arg?.text || '').slice(0, 8000); if (!t.trim()) throw Error('内容为空'); for (const line of t.split(/\n+/)) transcript.add(line, Date.now(), 'manual'); return { lines: transcript.entries.length }; });
handle('copy', arg => { clipboard.writeText(String(arg?.text || '')); return {}; });
handle('hide-from-share', arg => { settings.hideFromShare = !!arg?.on; saveSettings(); win?.setContentProtection(settings.hideFromShare); return {}; });
handle('key-test', arg => { keyTest = !!arg?.on; return { on: keyTest }; });
handle('hide', () => { win?.hide(); return {}; });
handle('quit', () => { app.quit(); return {}; });

app.on('second-instance', () => showWindow(true));
app.whenReady().then(async () => {
  loadSettings();
  loadIntents(path.join(app.getPath('userData'), 'intents.json'));
  if (process.platform === 'darwin') app.dock?.hide();
  createWindow();
  registerShortcuts();
  ocr.ensure();
  setInterval(async () => {
    const flag = path.join(app.getPath('userData'), 'selftest.json');
    if (fs.existsSync(flag)) {
      let req = {}; try { req = JSON.parse(fs.readFileSync(flag, 'utf8')); } catch {}
      fs.rmSync(flag, { force: true });
      const out = { at: new Date().toISOString() };
      try {
        const l = await ocr.call('list'); out.windows = l.windows;
        const w = req.title ? l.windows.find(x => x.title === req.title) : l.windows[0];
        if (w) {
          out.window = w;
          const t0 = Date.now(); const o = await ocr.call('ocr-once', { windowId: w.windowId, region: req.region ?? settings.region, title: w.title, app: w.app });
          out.ocr = { ms: o.ms, wallMs: Date.now() - t0, lines: o.lines.map(x => ({ y: +x.y.toFixed(3), x: +x.x.toFixed(3), text: x.text })) };
          if (req.watchSec) {
            const wasActive = session.active;
            if (!wasActive) await startSession(w.windowId);
            await new Promise(r => setTimeout(r, req.watchSec * 1000));
            out.watch = { stats: { ...transcript.stats }, chars: transcript.text.length, frameMs: ocr.frameMs, capturing: !ocrFailing, tail: transcript.text.slice(-300) };
            if (!wasActive) await endSession();
          }
          if (req.ask) {
            await startSession(w.windowId);
            await new Promise(r => setTimeout(r, 4000));
            out.sessionLines = transcript.entries.map(e => e.text);
            const t0 = Date.now(); await ask(String(req.ask));
            out.ask = { wallMs: Date.now() - t0, lastAsk: lastAsk?.payload || null };
          }
          if (req.snapshot) { await ocr.call('snapshot', { windowId: w.windowId, path: path.join(app.getPath('userData'), 'selftest-snapshot.png'), title: w.title, app: w.app }); out.snapshot = true; }
        }
      } catch (e) { out.error = e.message; }
      fs.writeFileSync(path.join(app.getPath('userData'), 'selftest-result.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
    }
    try {
      const st = status(); st.bridge = await bridge.status().catch(e => ({ connected: false, message: e.message }));
      st.targets = targets.map(t => t.label); st.lastAsk = lastAsk ? { intent: lastAsk.payload.intent, ms: lastAsk.payload.ms, timing: lastAsk.payload.timing, answer: lastAsk.answer.slice(0, 400) } : null;
      st.writtenAt = new Date().toISOString();
      fs.writeFileSync(path.join(app.getPath('userData'), 'status.json'), JSON.stringify(st, null, 2), { mode: 0o600 });
    } catch {}
  }, 2000);
  bridge.status().then(s => { if (s.connected) refreshTargets().catch(() => {}); }).catch(() => {});
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); ocr.kill(); });
app.on('window-all-closed', e => e.preventDefault?.());
