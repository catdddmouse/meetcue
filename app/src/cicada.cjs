'use strict';
// 读取知了 Cicada 正在进行的会议记录（不改 Cicada，只读它每 1.5 秒落盘的 session.json）
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.join(os.homedir(), 'Library/Application Support/LiveSubs/Sessions');

function liveSession(root = ROOT) {
  let best = null;
  let dirs; try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, 'session.json');
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
  }
  return best;
}

function speakerName(line, s) {
  if (line.speaker === 'me') return '我';
  if (line.voice != null) return s.voiceNames?.[String(line.voice)] || `对方${line.voice + 1}`;
  return line.via === 'room' ? '现场' : '对方';
}

class CicadaSource {
  constructor(transcript, root = ROOT) { this.t = transcript; this.root = root; this.timer = null; this.file = null; this.mtime = 0; this.lastError = null; this.lastRead = null; this.title = null; }
  start(sinceMs = Date.now()) {
    this.stop(); this.since = sinceMs;
    const tick = () => { try { this.read(); this.lastError = null; } catch (e) { this.lastError = e.message; } };
    tick(); this.timer = setInterval(tick, 1000);
  }
  read() {
    const live = liveSession(this.root);
    if (!live) throw Error('没找到知了的会议记录，请先在知了里开始收听');
    if (live.file === this.file && live.mtimeMs === this.mtime) return;
    const s = JSON.parse(fs.readFileSync(live.file, 'utf8'));
    this.file = live.file; this.mtime = live.mtimeMs; this.lastRead = Date.now(); this.title = s.title;
    if (s.endedAt) this.lastError = '知了这场已结束';
    const start = Date.parse(s.startedAt);
    for (const l of s.lines || []) {
      const at = start + (Number(l.t) || 0) * 1000;
      if (at < this.since - 10 * 60_000) continue; // 只取开始本场前 10 分钟以内
      this.t.upsert('cicada:' + s.id + ':' + l.id, `${speakerName(l, s)}：${l.src}`, at, 'cicada');
    }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  status() { return { running: !!this.timer, file: this.file, title: this.title, lastRead: this.lastRead, lastError: this.lastError }; }
}
module.exports = { CicadaSource, liveSession, ROOT };
