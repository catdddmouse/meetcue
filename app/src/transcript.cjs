'use strict';
// 把逐帧 OCR 结果合并成不重复的滚动会议记录。
// 飞书字幕会滚动、会改写最后一句，所以按顺序对齐 + 模糊匹配，而不是简单按文本去重。

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function bigrams(s) {
  const t = s.replace(/\s/g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return { m, n: Math.max(0, t.length - 1), t };
}
function similarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (A.n === 0 || B.n === 0) return A.t === B.t ? 1 : 0;
  let hit = 0;
  for (const [g, c] of A.m) hit += Math.min(c, B.m.get(g) || 0);
  return (2 * hit) / (A.n + B.n);
}
// 一句话在增长（新的是旧的延续）或旧的是新的片段
function grows(oldText, newText) {
  const o = oldText.replace(/\s/g, ''), n = newText.replace(/\s/g, '');
  if (o.length < 4 || n.length < 4) return false;
  return n.startsWith(o.slice(0, Math.min(o.length, 6))) && (n.length >= o.length * 0.8);
}

const NOISE = [/^\d{1,2}:\d{2}(:\d{2})?$/, /^[\p{P}\p{S}\s]+$/u];
function isNoise(t) { return t.length < 2 || NOISE.some(r => r.test(t)); }

// 妙记/字幕的文字会边说边重排换行，所以把每帧拼成一段连续文字，再和已有记录的结尾对齐拼接
const SPEAKER = /^(\S{1,12})\s*[·•・]\s*\d{1,2}:\d{2}(:\d{2})?$/;
function joinFrame(lines) {
  let out = '';
  for (const l of lines) {
    const m = l.match(SPEAKER);
    if (m) { out += (out ? '\n' : '') + m[1] + '：'; continue; }
    out += l; // 自动换行的行直接拼接，不加空格（英文单词可能被折行拆开）
  }
  return out;
}

class Transcript {
  constructor({ maxEntries = 4000, maxChars = 200000 } = {}) { this.maxEntries = maxEntries; this.maxChars = maxChars; this.seq = 0; this.clear(); }
  clear() { this.chunks = []; this.others = []; this.byKey = new Map(); this.stats = { frames: 0, appended: 0, rewritten: 0, jumps: 0, lastChangeAt: null }; }
  get entries() { return [...this.chunks, ...this.others].sort((a, b) => a.firstSeen - b.firstSeen || a.id - b.id); }
  get text() { return this.chunks.map(c => c.text).join(''); }
  add(text, at = Date.now(), source = 'manual') {
    const t = norm(text); if (!t) return null;
    const e = { id: ++this.seq, text: t, firstSeen: at, lastSeen: at, source };
    this.others.push(e); this.trim(); return e;
  }
  // 外部来源（如 Cicada）按稳定 key 写入：同 key 更新文字，不重复
  upsert(key, text, at, source) {
    const t = norm(text); if (!t) return false;
    const e = this.byKey.get(key);
    if (e) { if (e.text === t) return false; e.text = t; e.lastSeen = Date.now(); return true; }
    const n = { id: ++this.seq, key, text: t, firstSeen: at, lastSeen: at, source };
    this.byKey.set(key, n); this.others.push(n); this.trim(); return true;
  }
  trim() {
    if (this.others.length > this.maxEntries) this.others.splice(0, this.others.length - this.maxEntries);
    let total = this.chunks.reduce((n, c) => n + c.text.length, 0);
    while (total > this.maxChars && this.chunks.length > 1) total -= this.chunks.shift().text.length;
  }
  // 把已有记录从字符位置 pos 起换成 tail：只是变长就只追加新增部分；内容被改写就截断后重接
  replaceFrom(pos, tail, at) {
    const removed = this.text.slice(pos);
    let firstSeen = at;
    if (tail.startsWith(removed)) tail = tail.slice(removed.length);
    else {
      let off = 0; const keep = [];
      for (const c of this.chunks) {
        if (off + c.text.length <= pos) keep.push(c);
        else { firstSeen = Math.min(firstSeen, c.firstSeen); if (pos > off) keep.push({ ...c, text: c.text.slice(0, pos - off) }); }
        off += c.text.length;
      }
      this.chunks = keep; this.stats.rewritten++;
    }
    if (tail) { this.chunks.push({ id: ++this.seq, text: tail, firstSeen, lastSeen: at, source: 'ocr' }); this.stats.appended++; this.stats.lastChangeAt = at; }
  }
  ingest(lines, at = Date.now()) {
    const frame = lines.map(l => norm(typeof l === 'string' ? l : l.text)).filter(t => !isNoise(t));
    const F = joinFrame(frame); this.stats.frames++;
    if (!F) return this.stats;
    const A = this.text;
    if (!A) { this.replaceFrom(0, F, at); return this.stats; }
    const L = Math.max(2, Math.min(8, F.length, A.length)), winStart = Math.max(0, A.length - 6000);
    for (let k = 0; k + L <= F.length; k += (k < 60 ? 2 : 6)) {
      const pos = A.lastIndexOf(F.slice(k, k + L));
      if (pos < winStart) continue;
      // 被替换掉的尾巴不能比这一帧还长太多（防止误配到前面重复出现的短语）
      if (A.length - pos > F.length - k + 40) continue;
      const tail = F.slice(k);
      if (A.slice(pos) === tail) return this.stats;
      this.replaceFrom(pos, tail, at); this.trim(); return this.stats;
    }
    // 重叠太短、锚点放不下时：看已有结尾是否正好是这一帧的开头
    for (let j = Math.min(A.length, F.length, 40); j >= 4; j--) {
      if (A.endsWith(F.slice(0, j))) { this.replaceFrom(A.length, F.slice(j), at); this.trim(); return this.stats; }
    }
    // 模糊兜底：已有结尾和这一帧开头大体相同（OCR 错了个别字），用这一帧覆盖结尾
    for (let j = Math.min(A.length, F.length, 60); j >= 6; j--) {
      if (similarity(A.slice(-j), F.slice(0, j)) >= 0.7) { this.replaceFrom(A.length - j, F, at); this.trim(); return this.stats; }
    }
    // 对不上：可能滚动跳得太远或识别差异大，整帧接在后面并标出断点
    this.stats.jumps++;
    this.replaceFrom(A.length, '\n…' + F, at); this.trim();
    return this.stats;
  }
  since(ms, now = Date.now()) {
    const all = this.entries;
    return ms ? all.filter(e => e.lastSeen >= now - ms) : all;
  }
  format(entries, maxChars) {
    const pad = n => String(n).padStart(2, '0');
    const fmt = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    let text = '', lastStamp = 0, lastSrc = '';
    for (const e of entries) {
      if (e.source === 'ocr') {
        if (lastSrc !== 'ocr' || e.firstSeen - lastStamp >= 30000) { text += (text ? '\n' : '') + `[${fmt(e.firstSeen)}] `; lastStamp = e.firstSeen; }
        text += e.text;
      } else { text += (text ? '\n' : '') + `[${fmt(e.firstSeen)}]${e.source === 'manual' ? '（手动）' : ''} ${e.text}`; }
      lastSrc = e.source;
    }
    text = text.replace(/\n{2,}/g, '\n');
    if (maxChars && text.length > maxChars) text = '……' + text.slice(text.length - maxChars);
    return text;
  }
  recent(n = 300) { const t = this.format(this.entries); return t.slice(-n); }
}

module.exports = { Transcript, similarity, norm, joinFrame };
