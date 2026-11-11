'use strict';
// 管理常驻 OCR 助手进程（Swift，ScreenCaptureKit + Vision）
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

class Ocr extends EventEmitter {
  constructor(bin) { super(); this.bin = bin; this.proc = null; this.pending = new Map(); this.seq = 0; this.ready = false; this.warmupMs = null; this.running = false; this.lastFrame = null; this.lastError = null; this.frameMs = null; }
  ensure() {
    if (this.proc) return;
    const p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p; this.ready = false;
    readline.createInterface({ input: p.stdout }).on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'reply') { const r = this.pending.get(m.id); if (r) { this.pending.delete(m.id); clearTimeout(r.timer); m.ok ? r.resolve(m) : r.reject(Error(m.error || 'OCR 失败')); } return; }
      if (m.type === 'ready') { this.ready = true; this.warmupMs = m.warmupMs; }
      if (m.type === 'frame' || m.type === 'tick') { this.frameMs = m.ms; this.lastFrame = m.at; this.lastError = null; }
      if (m.type === 'error') { this.lastError = m.message; this.emit('ocr-error', m); return; }
      if (m.type === 'window') this.windowId = m.windowId;
      if (m.type === 'stopped') { this.running = false; this.lastError = m.reason; }
      this.emit(m.type, m);
    });
    p.stderr.on('data', d => { this.lastError = String(d).slice(0, 300); });
    p.on('exit', () => { this.proc = null; this.running = false; for (const r of this.pending.values()) r.reject(Error('OCR 进程已退出')); this.pending.clear(); this.emit('exit'); });
  }
  call(cmd, args = {}, timeout = 30000) {
    this.ensure();
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('OCR 响应超时')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }
  async start(windowId, region, intervalMs = 1200, title, app) { await this.call('start', { windowId, region, intervalMs, title, app }); this.running = true; this.lastError = null; }
  async stop() { if (this.proc) await this.call('stop').catch(() => {}); this.running = false; }
  kill() { if (this.proc) this.proc.kill(); }
  status() { return { ready: this.ready, warmupMs: this.warmupMs, running: this.running, lastFrame: this.lastFrame, frameMs: this.frameMs, lastError: this.lastError }; }
}
module.exports = { Ocr };
