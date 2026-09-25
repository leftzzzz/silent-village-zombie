// Headless screenshot + console capture for visual verification.
// usage: node tools/shot.mjs <url> <out.png> [waitMs] [evalJs]
import { chromium } from 'playwright-core';
const [url, out = 'shot.png', wait = '4000', evalJs] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(parseInt(wait));
if (evalJs) {
  try { const r = await page.evaluate(evalJs); if (r !== undefined) logs.push('[eval] ' + JSON.stringify(r)); }
  catch (e) { logs.push('[eval-error] ' + e.message); }
  await page.waitForTimeout(1500);
}
console.log(logs.slice(-60).join('\n'));
try { await page.screenshot({ path: out, timeout: 90000 }); } catch (e) { console.log('[screenshot-failed] ' + e.message.split('\n')[0]); }
await browser.close();
