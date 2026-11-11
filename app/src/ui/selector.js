'use strict';
const q = new URLSearchParams(location.search);
const W = Number(q.get('w')), H = Number(q.get('h'));
const img = document.getElementById('img'), box = document.getElementById('box'), info = document.getElementById('info');
img.src = q.get('img') + '?t=' + Date.now(); img.width = W; img.height = H;
let region = null; try { region = JSON.parse(q.get('region')); } catch {}
function draw() {
  if (!region) { box.style.display = 'none'; info.textContent = '未框选'; return; }
  Object.assign(box.style, { display: 'block', left: region.x * W + 'px', top: region.y * H + 'px', width: region.w * W + 'px', height: region.h * H + 'px' });
  info.textContent = `已选 ${Math.round(region.w * 100)}% × ${Math.round(region.h * 100)}%`;
}
draw();
let start = null;
img.addEventListener('dragstart', e => e.preventDefault());
document.getElementById('wrap').addEventListener('mousedown', e => { const r = img.getBoundingClientRect(); start = { x: e.clientX - r.left, y: e.clientY - r.top }; });
window.addEventListener('mousemove', e => {
  if (!start) return; const r = img.getBoundingClientRect();
  const x = Math.max(0, Math.min(W, e.clientX - r.left)), y = Math.max(0, Math.min(H, e.clientY - r.top));
  region = { x: Math.min(x, start.x) / W, y: Math.min(y, start.y) / H, w: Math.abs(x - start.x) / W, h: Math.abs(y - start.y) / H }; draw();
});
window.addEventListener('mouseup', () => { start = null; if (region && (region.w < 0.02 || region.h < 0.02)) { region = null; draw(); } });
document.getElementById('btnAll').onclick = () => { region = null; draw(); };
document.getElementById('btnSave').onclick = async () => {
  const r = await window.prompter.call('save-region', { region });
  if (!r.ok) info.textContent = r.error;
};
