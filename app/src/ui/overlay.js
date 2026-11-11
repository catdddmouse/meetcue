'use strict';
const $ = id => document.getElementById(id);
const api = window.prompter;
let meta, current = null, timerHandle = null, noticeHandle = null, lastAnswer = '', pairTimer = null, collapsed = false;

const KEYNAME = { 'Control': 'control', 'Alt': 'option', 'Shift': 'shift', 'Escape': 'esc' };
const pretty = acc => acc.split('+').map(k => KEYNAME[k] || k).join(' + ');

function fit() { requestAnimationFrame(() => api.call('resize', { height: Math.ceil($('shell').getBoundingClientRect().height) + 2 })); }
new ResizeObserver(fit).observe(document.body);

function notice(text, level = 'primary', ms = 4000) {
  const n = $('notice'); n.textContent = text; n.className = level; n.hidden = false; fit();
  clearTimeout(noticeHandle); if (ms) noticeHandle = setTimeout(() => { n.hidden = true; fit(); }, ms);
}

function showCard() { collapsed = false; $('panel').classList.remove('collapsed'); $('btnCollapse').style.transform = ''; $('card').hidden = false; fit(); }

function startTimer(startedAt) {
  clearInterval(timerHandle);
  const tick = () => { $('cardTimer').textContent = Math.round((Date.now() - startedAt) / 1000) + ' 秒'; };
  tick(); timerHandle = setInterval(tick, 500);
}

api.on('notice', d => notice(d.text, d.level));
api.on('ask-start', d => {
  current = d; collapsed = false;
  $('cardIntent').textContent = d.intent;
  $('cardMeta').textContent = `问 ${d.partner} · 回看 ${d.lookback} · ${d.lines} 行`;
  $('answer').className = 'waiting'; $('answer').textContent = '正在发给伙伴…';
  $('btnCancel').hidden = false; $('dot').className = 'dot wait';
  startTimer(d.startedAt); showCard();
});
api.on('ask-state', d => { if (current?.id === d.id) $('answer').textContent = d.state === 'accepted' ? `「${current.partner}」已收到，正在想…` : '正在发给伙伴…'; });
api.on('answer', d => {
  clearInterval(timerHandle); current = null; collapsed = false;
  $('cardIntent').textContent = d.intent;
  $('cardMeta').textContent = `${d.partner} · 回看 ${d.lookback}${d.reused ? ' · 与上次相同，未重复发送' : ''}`;
  $('cardTimer').textContent = d.reused ? '' : (d.ms / 1000).toFixed(1) + ' 秒';
  $('answer').className = ''; $('answer').textContent = lastAnswer = d.answer;
  $('btnCancel').hidden = true; refresh(); showCard();
});
api.on('ask-error', d => {
  clearInterval(timerHandle); if (current?.id === d.id || !current) current = null;
  $('answer').className = 'error'; $('answer').textContent = d.error;
  $('btnCancel').hidden = true; $('card').hidden = false; refresh(); fit();
});

async function refresh() {
  const s = await api.call('status'); if (!s.ok) return;
  $('chipPartner').textContent = s.target.label || '未选伙伴';
  $('chipLookback').textContent = '回看 ' + s.lookback.label;
  $('chipSource').textContent = s.source === 'cicada' ? '知了 ' + s.lines + ' 句' : '已读 ' + s.chars + ' 字' + (s.idleSec > 45 ? ' · ' + s.idleSec + ' 秒无新字' : '');
  if (!current) {
    const err = s.session.active && (s.source === 'cicada' ? s.cicada.lastError : (!s.capturing ? s.ocr.lastError : s.idleSec > 45 ? s.idleSec + ' 秒没有新文字' : null));
    $('dot').className = 'dot ' + (err ? 'err' : s.session.active ? 'live' : 'idle');
    $('dot').title = err || (s.session.active ? '本场进行中' : '未开始');
  }
  for (const b of document.querySelectorAll('#sourceSeg button')) b.classList.toggle('on', b.dataset.source === s.source);
  $('ocrBox').hidden = s.source !== 'ocr'; $('cicadaBox').hidden = s.source !== 'cicada';
  $('regionState').textContent = s.settings.region ? '已框选' : '未框选（会读整个窗口，噪声多）';
  $('permState').textContent = '屏幕录制权限：' + ({ granted: '已允许', denied: '未允许', 'not-determined': '未请求', restricted: '受限' }[s.screenPermission] || s.screenPermission);
  const o = s.ocr;
  if (s.source === 'cicada') {
    const c = s.cicada;
    $('cicadaState').textContent = c.lastError ? c.lastError : c.title ? `正在读：${c.title}` : (s.session.active ? '等待知了记录…' : '');
    $('ocrState').textContent = s.session.active ? '读取中' : '';
  } else {
    $('ocrState').textContent = s.session.active ? (o.lastError ? '⚠ ' + o.lastError : `读取中 · 每帧 ${o.frameMs ?? '-'} ms`) : (o.ready ? '' : '识别模型预热中…');
  }
  $('recent').textContent = s.recent.length ? s.recent.join('\n') : (s.session.active ? '还没读到文字' : '未开始');
  $('chkShare').checked = !!s.settings.hideFromShare;
  return s;
}

async function loadBridge() {
  const b = await api.call('bridge-status');
  $('bridgeState').textContent = b.connected ? '已连接 Cindy' : (b.message || '未连接');
  $('btnConnect').hidden = !!b.connected;
  if (b.connected) await loadTargets();
}
async function loadTargets() {
  const r = await api.call('targets');
  const sel = $('selTarget'); sel.innerHTML = '';
  if (!r.ok) { $('bridgeState').textContent = r.error; return; }
  for (const t of r.targets) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; o.selected = t.id === r.selected; sel.append(o); }
  refresh();
}
async function loadWindows() {
  const r = await api.call('windows');
  const sel = $('selWindow'); sel.innerHTML = '';
  if (!r.ok) { const o = document.createElement('option'); o.textContent = r.error; sel.append(o); return; }
  if (!r.windows.length) { const o = document.createElement('option'); o.textContent = '没有找到飞书窗口'; sel.append(o); }
  for (const w of r.windows) { const o = document.createElement('option'); o.value = w.windowId; o.dataset.title = w.title; o.textContent = `${w.title || '(无标题)'} · ${Math.round(w.width)}×${Math.round(w.height)}${w.onScreen ? '' : ' · 不在当前屏幕'}`; sel.append(o); }
  const pick = [...sel.options].find(o => o.dataset.title && o.dataset.title === r.selectedTitle) || sel.options[0]; if (pick) pick.selected = true;
}
const selectedWindowId = () => Number($('selWindow').value) || undefined;

$('btnConnect').onclick = async () => {
  const r = await api.call('connect');
  if (!r.ok) { $('bridgeState').textContent = r.error; return; }
  if (r.pending) {
    $('pairBox').hidden = false; $('pairBox').textContent = `请在 Cindy「会议连接」页确认配对，配对码 ${r.code}`; fit();
    clearInterval(pairTimer);
    pairTimer = setInterval(async () => {
      const p = await api.call('pair-status');
      if (p.connected) { clearInterval(pairTimer); $('pairBox').hidden = true; notice('已连接 Cindy', 'success'); loadBridge(); }
      else if (!p.ok || !p.pending) { clearInterval(pairTimer); $('pairBox').textContent = p.error || '配对未完成（' + p.state + '），可重新连接'; }
    }, 1500);
  } else loadBridge();
};
$('btnRefreshTargets').onclick = loadTargets;
$('selTarget').onchange = async e => { await api.call('select-target', { id: e.target.value }); refresh(); };
$('btnRefreshWin').onclick = loadWindows;
$('selWindow').onchange = e => api.call('select-window', { windowId: Number(e.target.value) });
$('btnRegion').onclick = async () => { const r = await api.call('pick-region', { windowId: selectedWindowId() }); if (!r.ok) notice(r.error, 'danger'); };
$('btnPerm').onclick = async () => { const r = await api.call('permission'); notice(r.ok && r.granted ? '屏幕录制权限已允许' : '请在 系统设置 › 隐私与安全性 › 屏幕与系统录音 中允许「会中提词」，然后重开应用', r.granted ? 'success' : 'warning', 8000); refresh(); };
for (const b of document.querySelectorAll('#sourceSeg button')) b.onclick = async () => { const r = await api.call('source', { source: b.dataset.source }); if (!r.ok) notice(r.error, 'warning'); refresh(); };
$('btnStart').onclick = async () => { const r = await api.call('start', { windowId: selectedWindowId() }); if (!r.ok) notice(r.error, 'danger', 8000); else notice('本场开始：正在读取会议文字', 'success'); refresh(); };
$('btnEnd').onclick = async () => { await api.call('end'); notice('本场已结束，临时记录已清空', 'primary'); refresh(); };
$('btnManual').onclick = async () => { const t = $('manual').value; const r = await api.call('manual', { text: t }); if (r.ok) { $('manual').value = ''; notice('已加入本场上下文', 'success'); } else notice(r.error, 'warning'); refresh(); };
$('chkShare').onchange = e => api.call('hide-from-share', { on: e.target.checked });
$('btnSettings').onclick = () => { $('settings').hidden = !$('settings').hidden; if (!$('settings').hidden) { loadBridge(); loadWindows(); refresh(); } fit(); };
$('btnCollapse').onclick = () => { collapsed = !collapsed; $('panel').classList.toggle('collapsed', collapsed); $('btnCollapse').style.transform = collapsed ? 'rotate(-90deg)' : ''; fit(); };
$('btnHide').onclick = () => api.call('hide');
$('btnCopy').onclick = () => { api.call('copy', { text: lastAnswer }); notice('已复制', 'success', 1500); };
$('btnCancel').onclick = () => api.call('cancel').then(() => { current = null; clearInterval(timerHandle); $('answer').className = 'error'; $('answer').textContent = '已取消等待'; $('btnCancel').hidden = true; refresh(); });
$('btnQuit').onclick = () => api.call('quit');
// 按键测试：本窗口内显示按下的是哪个键；全局快捷键只提示不执行
const KEYZH = { Alt: 'option 键（有的键盘写 alt）✓ 就是它', Meta: 'command 键（⌘）', Control: 'control 键', Shift: 'shift 键', CapsLock: '大写锁定键', Escape: 'esc 键', ' ': '空格键', Tab: 'tab 键', Enter: '回车键', Backspace: '删除键' };
let testing = false;
function setKeyTest(on) {
  testing = on; api.call('key-test', { on });
  $('keytest').hidden = !on; if (on) { $('settings').hidden = true; $('ktLocal').textContent = '先点一下这个浮窗，再按键盘上的键'; $('ktGlobal').className = 'ktHint'; $('ktGlobal').textContent = '然后试：按住 option 再按 1'; }
  fit();
}
$('btnKeyTest').onclick = () => setKeyTest(true);
$('btnKtDone').onclick = () => setKeyTest(false);
window.addEventListener('keydown', e => {
  if (!testing) return;
  const name = KEYZH[e.key] || (e.code.startsWith('Digit') ? '数字 ' + e.code.slice(5) : e.code.startsWith('Key') ? '字母 ' + e.code.slice(3) : e.key);
  const mods = [e.altKey && e.key !== 'Alt' ? 'option' : '', e.metaKey && e.key !== 'Meta' ? 'command' : '', e.ctrlKey && e.key !== 'Control' ? 'control' : ''].filter(Boolean);
  $('ktLocal').textContent = (mods.length ? mods.join(' + ') + ' + ' : '') + name;
  e.preventDefault();
});
api.on('keytest', d => { $('ktGlobal').className = 'ktHint hit'; $('ktGlobal').textContent = '✓ 快捷键生效：' + pretty(d.acc) + ' → ' + d.label; fit(); });

(async () => {
  const m = await api.call('meta'); meta = m;
  const k = m.shortcuts, rows = [];
  for (const i of m.intents) rows.push([pretty(k.intentPrefix + '+' + i.key), i.label]);
  rows.push([pretty(k.lookbackCycle), '切换回看时长（1 → 3 → 5 分钟 → 全场）']);
  rows.push([pretty(k.cyclePartner), '切换提问对象'], [pretty(k.toggle), '显示 / 隐藏浮窗'], [pretty(k.cancel), '取消等待']);
  $('keys').innerHTML = ''; for (const [a, b] of rows) { const x = document.createElement('kbd'); x.textContent = a; const y = document.createElement('span'); y.textContent = b; $('keys').append(x, y); }
  for (const i of m.intents) { const b = document.createElement('button'); const k = document.createElement('kbd'); k.textContent = '⌥' + i.key; b.append(i.label, k); b.title = '按住 option 再按 ' + i.key; b.onclick = () => api.call('ask', { key: i.key }); $('intentRow').append(b); }
  const s = await refresh();
  await loadBridge().catch(() => {});
  if (!s?.target?.id || !s.session.active) { $('settings').hidden = false; loadWindows(); }
  fit();
  setInterval(refresh, 1500);
})();
