// Scripted interaction test for the Analog Attic storefront (headless Chrome via CDP).
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9900 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = require(path.join(__dirname, '..', '..', 'src', 'data', 'products.json')).products;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-ix-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const kill = () => { try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {} };
  let fails = 0;
  const check = (ok, label, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { await sleep(250); } }
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map(); let errors = [];
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '')); });
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const go = async (url, w = 1440) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: w === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: w === 390 }); await send('Page.navigate', { url: BASE + url }); await sleep(900); };
    await send('Page.enable'); await send('Runtime.enable');

    // --- cart from a product page
    await go('/'); await ev('localStorage.clear()');
    await go('/products/twin-bell-alarm-clock/');
    await ev("document.querySelector('[data-add-main]').click()"); await sleep(500);
    let cart = JSON.parse(await ev("localStorage.getItem('aa_cart_v1')") || 'null');
    const badge = await ev("document.querySelector('[data-cart-count]').textContent");
    check(JSON.stringify(cart).includes('twin-bell-alarm-clock') && badge === '1', 'Add to cart on product page stores item and shows badge 1', `badge=${badge}`);
    check(await ev("document.querySelector('#cart-drawer').getAttribute('aria-hidden')") === 'false', 'Cart drawer opens after adding');
    const lineTitle = await ev("document.querySelector('#cart-drawer [data-cart-body]').innerText");
    check(/Twin-Bell Alarm Clock/.test(lineTitle) && /\$34\.99/.test(lineTitle), 'Cart line shows title and $34.99');
    await ev("document.querySelector('[data-line-inc]').click()"); await sleep(300);
    const footer = await ev("document.querySelector('[data-cart-footer]').innerText");
    check(/\$69\.98/.test(footer), 'Quantity +1 gives subtotal $69.98', footer.replace(/\s+/g, ' ').slice(0, 60));
    await ev("document.querySelector('[data-line-remove]').click()"); await sleep(300);
    check(/empty/i.test(await ev("document.querySelector('#cart-title').textContent")), 'Removing the line empties the cart');

    // --- quick add from home card, persistence across navigation
    await go('/');
    await ev("document.querySelector('[data-quick-add=\"classic-cassette-boombox\"]').click()"); await sleep(500);
    await go('/collections/audio/');
    check(await ev("document.querySelector('[data-cart-count]').textContent") === '1', 'Cart badge persists after navigating to another page');

    // --- collection filtering and sorting
    await go('/collections/all/');
    const total = await ev("document.querySelectorAll('[data-grid] .card').length");
    check(total === 10, 'Shop All lists 10 products', `got ${total}`);
    await ev("(()=>{const i=document.querySelector('[data-price-min]');i.value='40';i.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(400);
    const expectMin = P.filter((p) => p.price >= 40).length;
    const visible = await ev("[...document.querySelectorAll('[data-grid] .card')].filter(c=>!c.hidden&&getComputedStyle(c).display!=='none').length");
    check(visible === expectMin, `Price filter >= $40 shows ${expectMin} products`, `got ${visible}`);
    await ev("document.querySelector('[data-clear-filters]').click()"); await sleep(300);
    await ev("document.querySelector('[data-sort-value=\"price-asc\"]').click()"); await sleep(400);
    const first = await ev("[...document.querySelectorAll('[data-grid] .card')].filter(c=>getComputedStyle(c).display!=='none')[0].dataset.handle");
    const cheapest = [...P].sort((a, b) => a.price - b.price)[0].handle;
    check(first === cheapest, `Sort price low to high puts ${cheapest} first`, `got ${first}`);
    await ev("document.querySelector('[data-sort-value=\"price-desc\"]').click()"); await sleep(400);
    const firstD = await ev("[...document.querySelectorAll('[data-grid] .card')].filter(c=>getComputedStyle(c).display!=='none')[0].dataset.handle");
    check(firstD === [...P].sort((a, b) => b.price - a.price)[0].handle, 'Sort price high to low puts the priciest first', `got ${firstD}`);

    // --- search modal
    await go('/');
    await ev("document.querySelector('.header__search--desktop').click()"); await sleep(400);
    await ev("(()=>{const i=document.querySelector('#search-input');i.value='cassette';i.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(500);
    const hits = await ev("[...document.querySelectorAll('[data-search-results] a')].map(a=>a.innerText.trim().split('\\n')[0]).filter(Boolean)");
    check(hits.some((h) => /Classic Cassette Boombox/.test(h)) && hits.some((h) => /Handheld Cassette Recorder/.test(h)), "Search 'cassette' finds the boombox and the recorder", JSON.stringify(hits).slice(0, 90));
    await ev("(()=>{const i=document.querySelector('#search-input');i.value='clock';i.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(500);
    const hits2 = await ev("[...document.querySelectorAll('[data-search-results] a')].map(a=>a.innerText.trim().split('\\n')[0]).filter(Boolean)");
    check(hits2.some((h) => /Walnut Mantel Clock/.test(h)) && hits2.some((h) => /Twin-Bell Alarm Clock/.test(h)), "Search 'clock' finds both clocks", JSON.stringify(hits2).slice(0, 90));
    await ev("(()=>{const i=document.querySelector('#search-input');i.value='dog';i.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(500);
    const hits3 = await ev("[...document.querySelectorAll('[data-search-results] a')].length");
    check(hits3 === 0, "Search 'dog' (another shop's word) finds nothing", `got ${hits3}`);

    // --- newsletter
    await go('/');
    await ev("(()=>{const f=document.querySelector('[data-signup]');f.querySelector('input').value='test@example.com';f.requestSubmit()})()"); await sleep(500);
    const msg = await ev("document.querySelector('.signup-form__msg').textContent");
    check(/is on the list/.test(msg), 'Newsletter signup confirms the address is on the list', msg);

    // --- phone menu
    await go('/', 390);
    await ev("document.querySelector('.header__menu').click()"); await sleep(500);
    check(await ev("document.querySelector('#menu-drawer').getAttribute('aria-hidden')") === 'false', 'Phone menu drawer opens');
    check(errors.length === 0, 'No uncaught JavaScript exceptions during the whole session', errors.join(' | ').slice(0, 200));
    ws.close();
  } finally { kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll interaction checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
