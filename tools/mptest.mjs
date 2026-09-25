// Two-client multiplayer smoke test against wrangler dev.
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:8788';
const out = process.argv[3] || '/tmp';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = { A: [], B: [] };
async function open(tag) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const p = await ctx.newPage();
  p.on('console', (m) => { const t = m.text(); if (!t.includes('Pointer Lock')) logs[tag].push(`[${m.type()}] ${t}`); });
  p.on('pageerror', (e) => { if (!e.message.includes('Pointer Lock')) logs[tag].push(`[pageerror] ${e.message} ${(e.stack || '').split('\n')[1] || ''}`); });
  await p.goto(`${base}/?autojoin=1&room=mp${Date.now() % 100000}`.replace(/mp\d+/, 'mptest'), { waitUntil: 'load' });
  await p.waitForFunction(() => window.__game && window.__game.local, null, { timeout: 90000 });
  await p.evaluate(() => { window.__input.locked = true; });
  return p;
}
const state = (p) => p.evaluate(() => { const g = window.__game; return { id: g.net.id, host: g.isHost, online: g.net.online, phase: g.mode.phase, timer: +g.mode.timer.toFixed(1), n: g.actors.size, me: [g.local.pos.x.toFixed(1), g.local.pos.z.toFixed(1), g.local.cls, g.local.alive], others: [...g.actors.values()].filter(a => !a.isBot && a !== g.local).map(a => a.name + '@' + a.pos.x.toFixed(1) + ',' + a.pos.z.toFixed(1) + ' ' + a.cls) }; });
const A = await open('A');
await A.waitForTimeout(2000);
const B = await open('B');
await B.waitForTimeout(4000);
console.log('A', JSON.stringify(await state(A)));
console.log('B', JSON.stringify(await state(B)));
// B walks forward for 2s
await B.evaluate(() => window.__input.keys.add('KeyW'));
await B.waitForTimeout(2000);
await B.evaluate(() => window.__input.keys.delete('KeyW'));
await A.waitForTimeout(800);
console.log('after B moves:');
console.log('A', JSON.stringify(await state(A)));
console.log('B', JSON.stringify(await state(B)));
await B.screenshot({ path: out + '/mpB.png' });
// host leaves → B should take over
await A.context().close();
await B.waitForTimeout(3000);
console.log('after A left:');
console.log('B', JSON.stringify(await state(B)));
await B.waitForTimeout(20000);
console.log('B later', JSON.stringify(await state(B)));
console.log('--- logs A'); console.log(logs.A.filter(l => !l.includes('[vite]')).slice(-12).join('\n'));
console.log('--- logs B'); console.log(logs.B.filter(l => !l.includes('[vite]')).slice(-12).join('\n'));
await browser.close();
