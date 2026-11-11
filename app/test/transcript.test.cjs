'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Transcript } = require('../src/transcript.cjs');

// 模拟妙记：一段话越说越长、自动换行（每行 14 字），窗口只显示最后 N 行
function frames(full, steps, width = 14, rows = 6) {
  const out = [];
  for (const n of steps) {
    const shown = full.slice(0, n); const lines = [];
    for (let i = 0; i < shown.length; i += width) lines.push(shown.slice(i, i + width));
    out.push(lines.slice(-rows));
  }
  return out;
}
const FULL = '之前说要在运营后台做的这个功能，这个事情现在到底谁在跟？王总那边下周要看结果，我们先过一下进度，然后再讨论新功能为什么值得投入，下个月能拿出什么成果，Alex 你怎么看这个事情。';

test('边说边换行：最终文字完整且不重复', () => {
  const t = new Transcript();
  const steps = []; for (let n = 3; n <= FULL.length; n += 5) steps.push(n); steps.push(FULL.length);
  frames(FULL, steps).forEach((f, i) => t.ingest(f, 1000 + i * 1200));
  assert.strictEqual(t.text, FULL);
});

test('窗口滚动只露出后几行，前面内容不丢', () => {
  const t = new Transcript();
  const steps = []; for (let n = 10; n <= FULL.length; n += 9) steps.push(n); steps.push(FULL.length);
  frames(FULL, steps, 14, 3).forEach((f, i) => t.ingest(f, i * 1000));
  assert.strictEqual(t.text, FULL);
});

test('最后几个字被改写时原地更新', () => {
  const t = new Transcript();
  t.ingest(['我们先过一下记忆这块的进度，然后'], 1);
  t.ingest(['我们先过一下记忆这块的进度，然后看'], 2);
  t.ingest(['我们先过一下记忆这块的进度。然后看下周'], 3);
  assert.strictEqual(t.text, '我们先过一下记忆这块的进度。然后看下周');
});

test('同一帧重复不增加', () => {
  const t = new Transcript();
  const f = ['甲：第一句话内容比较长一些', '乙：第二句话内容也比较长'];
  t.ingest(f, 1); t.ingest(f, 2); t.ingest(f, 3);
  assert.strictEqual(t.text, '甲：第一句话内容比较长一些乙：第二句话内容也比较长');
});

test('说话人行变成换行标记', () => {
  const t = new Transcript();
  t.ingest(['小李 · 00:13', '我们之前的话需要实现两块内容', '王总 · 00:40', '那第一块是什么'], 1);
  assert.strictEqual(t.text, '小李：我们之前的话需要实现两块内容\n王总：那第一块是什么');
});

test('对不上时接在后面并标断点', () => {
  const t = new Transcript();
  t.ingest(['第一段完全不同的内容在这里'], 1);
  t.ingest(['另外一段毫无关系的文字出现了'], 2);
  assert.ok(t.text.includes('第一段') && t.text.includes('\n…另外一段'));
});

test('按回看时长取并截断', () => {
  const t = new Transcript();
  t.ingest(['很久之前说的老内容'], 0);
  t.ingest(['很久之前说的老内容', '刚刚说的新内容在这里'], 200_000);
  const recent = t.format(t.since(60_000, 200_000));
  assert.ok(recent.includes('刚刚说的新内容') && !recent.includes('老内容'));
  assert.ok(t.format(t.since(0), 10).startsWith('……'));
});

test('过滤时间戳和符号噪声', () => {
  const t = new Transcript();
  t.ingest(['10:32', '···', '王总：开始吧'], 1);
  assert.strictEqual(t.text, '王总：开始吧');
});

test('知了记录按 id 更新不重复', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { CicadaSource } = require('../src/cicada.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-')); fs.mkdirSync(path.join(root, 'S1'));
  const write = lines => fs.writeFileSync(path.join(root, 'S1/session.json'), JSON.stringify({ id: 'S1', title: 'x', startedAt: new Date().toISOString(), lines, voiceNames: { '0': '王总' } }));
  const t = new Transcript(); const c = new CicadaSource(t, root);
  write([{ id: 'a', t: 1, speaker: 'them', src: '记忆这块进展如何', voice: 0 }]); c.since = Date.now(); c.read();
  write([{ id: 'a', t: 1, speaker: 'them', src: '记忆这块进展如何？', voice: 0 }, { id: 'b', t: 3, speaker: 'me', src: '我来说一下' }]); c.mtime = 0; c.read();
  assert.deepStrictEqual(t.entries.map(e => e.text), ['王总：记忆这块进展如何？', '我：我来说一下']);
});
