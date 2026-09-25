// Scripted play-test: node tools/play.mjs <url> <outPrefix> <steps.json>
// steps: [{wait:ms} | {shot:name} | {eval:js} | {key:code, down:bool} | {look:[dx,dy]}]
import { chromium } from 'playwright-core';
import fs from 'fs';
const [url, prefix, stepsArg] = process.argv.slice(2);
const steps = JSON.parse(fs.existsSync(stepsArg) ? fs.readFileSync(stepsArg, 'utf8') : stepsArg);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (!m.text().includes('vite') && !m.text().includes('Pointer Lock')) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { if (!e.message.includes('Pointer Lock')) logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`); });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.local, null, { timeout: 90000 });
await page.evaluate(() => { window.__input.locked = true; });
for (const s of steps) {
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.shot) { try { await page.screenshot({ path: `${prefix}-${s.shot}.png`, timeout: 60000 }); } catch (e) { logs.push('[shot-fail] ' + e.message.split('\n')[0]); } }
  if (s.eval) { try { const r = await page.evaluate(s.eval); logs.push('[eval] ' + JSON.stringify(r)); } catch (e) { logs.push('[eval-error] ' + e.message); } }
  if (s.key) await page.evaluate(([c, d]) => { const i = window.__input; if (d) i.keys.add(c); else i.keys.delete(c); if (d && c === 'Space') i.events.add('jump'); }, [s.key, s.down !== false]);
  if (s.look) await page.evaluate(([dx, dy]) => window.__game.look(dx, dy), s.look);
}
console.log(logs.slice(-50).join('\n'));
await browser.close();
