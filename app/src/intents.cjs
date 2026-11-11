'use strict';
// 快捷键：option + 1~5 = 问题类型，option + 0 = 切换回看时长

// 默认问题；可在用户数据目录的 intents.json 里按 key 覆盖或增加（见 README）
const INTENTS = [
  { key: '1', label: '怎么回答', question: '刚才有人在问我（或 @ 我），我现在可以怎么回答？' },
  { key: '2', label: '追问澄清', question: '我现在应该追问或澄清什么？给一两个可以直接问出口的问题。' },
  { key: '3', label: '刚才在说什么', question: '刚才大家在讨论什么？用两三句话帮我快速跟上，并点出现在悬而未决的点。' },
  { key: '4', label: '进度与决策', question: '结合项目的进度和既有承诺，现在我该给出什么进度说明或决策建议？' },
  { key: '5', label: '关键建议', question: '针对当前议题，现在最关键的一条建议是什么？' }
];

const LOOKBACKS = [
  { key: '1', label: '1 分钟', ms: 60_000, maxChars: 3000 },
  { key: '3', label: '3 分钟', ms: 180_000, maxChars: 6000 },
  { key: '5', label: '5 分钟', ms: 300_000, maxChars: 9000 },
  { key: '0', label: '本场全部', ms: 0, maxChars: 18000 }
];

const DEFAULT_SHORTCUTS = {
  intentPrefix: 'Alt',      // option + 1~5
  lookbackCycle: 'Alt+0',   // option + 0：1 → 3 → 5 分钟 → 全场 循环
  toggle: 'Alt+H',
  cyclePartner: 'Alt+P',
  cancel: 'Alt+Escape'
};

const DISPLAY_RULE = '\n会中显示要求：先给 2—3 句能直接说出口的话（总共不超过 100 字）；依据或不确定点最多一句。';

function loadIntents(file) {
  try {
    const custom = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    if (!Array.isArray(custom)) return;
    for (const c of custom) {
      if (!/^[1-9]$/.test(String(c?.key)) || typeof c.question !== 'string' || !c.question.trim()) continue;
      const i = INTENTS.findIndex(x => x.key === String(c.key)); const v = { key: String(c.key), label: String(c.label || c.key).slice(0, 20), question: c.question.slice(0, 1000) };
      if (i >= 0) INTENTS[i] = v; else INTENTS.push(v);
    }
    INTENTS.sort((a, b) => a.key.localeCompare(b.key));
  } catch {}
}
function intent(key) { return INTENTS.find(i => i.key === key); }
function lookback(key) { return LOOKBACKS.find(l => l.key === key) || LOOKBACKS[1]; }

module.exports = { loadIntents, INTENTS, LOOKBACKS, DEFAULT_SHORTCUTS, DISPLAY_RULE, intent, lookback };
