/**
 * 用 CDP 驱动无头 Edge，在真实 DOM 上跑用例，验证 1.6.0 的收尾时序：
 *   A 常规：初始在第 2 页，第 1 页行序乱（1.3 学习中 / 1.1 已完成 / 1.2 未学习）
 *          → 应先退回第 1 页，再按章节号取第一个未完成 = 1.2
 *   B 兜底：分页控件没有 id，只剩「上一页」文字链接 → 仍应回到第 1 页并选 1.2
 *   C 翻页：第 1 页全部已完成 → 应翻到第 2 页并打开 2.1
 *   D 空转：学时已够但状态没翻 → 不反复开关同一节，转为等结算
 *   E 收尾：达标时正好是上报点 → 停表等上报落地 → 刷新后看到已完成 → 开下一节
 *   F 非整点：达标时不在上报点 → 先补到上报点再停表，不丢尾巴
 *   G 上报丢失：服务端始终没收到 → 靠本地记账顶住，先刷别的课不重开这节
 *   H 只剩等待结算的课：轮询刷新课程表，而不是直接判「全部完成」
 *
 * 可选环境变量：
 *   ONLY=E            只跑名字以 E 开头的用例
 *   EXTRA=video=1     给播放页插一个原生 <video>（覆盖 ensurePlaying 的 video 分支）
 *   SCRIPT=xxx.bak    用另一个脚本文件跑，便于版本对照
 *
 * 静态服务与浏览器驱动写在同一进程（后台起的 python 会被回收）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9336;
const WEB_PORT = 8767;
const PROFILE = path.join(os.tmpdir(), 'gk-cdp-' + Date.now());
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

const SCRIPT_PATH = process.env.SCRIPT
  ? path.resolve(ROOT, process.env.SCRIPT)
  : path.join(ROOT, 'gk-auto-study.user.js');
const SCRIPT_REL = '/' + path.relative(ROOT, SCRIPT_PATH).split(path.sep).join('/');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');
const VER = (SCRIPT_SRC.match(/\/\/\s*@version\s+([\d.]+)/) || [])[1] || '?';

const ARGS = [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--force-device-scale-factor=1',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', 'about:blank'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

class CDP {
  constructor(u) { this.url = u; this.id = 0; this.p = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', rej);
      this.ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.p.has(m.id)) {
          const { res, rej } = this.p.get(m.id);
          this.p.delete(m.id);
          m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

(async () => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${WEB_PORT}`;

  const proc = spawn(EDGE, ARGS, { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const v = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); if (v.webSocketDebuggerUrl) { up = true; break; } } catch (e) { }
  }
  if (!up) { console.log('FAIL: 无头浏览器没起来'); proc.kill(); server.close(); process.exit(1); }

  const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = list.find(t => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function runOnce(url, seconds) {
    const full = url + (url.indexOf('?') >= 0 ? '&' : '?') + (EXTRA ? EXTRA + '&' : '') + 'fresh=1';
    await cdp.send('Page.navigate', { url: BASE + full });
    await sleep(2200);
    // 每个用例从空记录开始，避免上一组的 store 影响本组判断
    await cdp.send('Runtime.evaluate', { expression: `localStorage.removeItem('gk_auto_study_v4');'cleared'`, returnByValue: true });
    const inj = await cdp.send('Runtime.evaluate', {
      expression: `fetch('${BASE}${SCRIPT_REL}').then(r=>r.text()).then(t=>{const s=document.createElement('script');s.textContent=t;document.documentElement.appendChild(s);return 'ver='+window.__GK_AUTO_STUDY__}).catch(e=>'ERR '+e.message)`,
      awaitPromise: true, returnByValue: true
    });
    if (inj.result.value !== 'ver=' + VER) return 'INJECT_FAIL:' + inj.result.value + ' (want ' + VER + ')';

    const seen = [];
    let last = '';
    for (let i = 0; i < seconds; i++) {
      await sleep(1500);
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){var h=document.getElementById('gk-auto-host');return h&&h.shadowRoot?(h.shadowRoot.textContent||''):'';})()`,
        returnByValue: true
      });
      const t = r.result.value || '';
      if (t !== last) {
        last = t;
        for (const m of t.matchAll(/\[(\d\d:\d\d:\d\d)\]\s*([^[]+)/g)) {
          /* 面板里每条日志同时存在于可见列表和「复制」用的隐藏块，去掉尾部的复制按钮文字再按时间去重 */
          const line = m[1] + ' ' + m[2].replace(/全选复制收起/g, '').trim();
          if (!seen.includes(line)) seen.push(line);
        }
      }
    }
    return seen.join('\n');
  }

  async function dumpStore() {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({store:localStorage.getItem('gk_auto_study_v4'),saved:Object.keys(localStorage).filter(k=>k.indexOf('gkmock_saved_')===0).map(k=>k+'='+localStorage.getItem(k))})`,
      returnByValue: true
    });
    console.log('  [store] ' + r.result.value);
  }

  const once = (blob, re) => (blob.match(re) || []).length;
  const ONLY = process.env.ONLY || '';
  const EXTRA = process.env.EXTRA || '';   // 附加查询参数，用来对比「带原生 video」等变体

  const cases = [
    {
      name: 'A 常规：回到第 1 页并按章节号选 1.2',
      url: '/mock/frame.html',
      secs: 12,
      want: [/已回到第 1 页/, /打开任务：1\.2/, /打开任务：1\.3/, /打开任务：2\.1/],
      expect: [true, true, false, false]
    },
    {
      name: 'B 兜底：控件无 id，靠「上一页」文字回退',
      url: '/mock/frame.html?noid=1',
      secs: 12,
      want: [/已回到第 1 页/, /打开任务：1\.2/, /打开任务：2\.1/],
      expect: [true, true, false]
    },
    {
      name: 'C 翻页：第 1 页全完成则翻页开 2.1',
      url: '/mock/frame.html?v=done',
      secs: 14,
      want: [/已回到第 1 页/, /翻到下一页/, /打开任务：2\.1/],
      expect: [true, true, true]
    },
    {
      name: 'D 空转：学时已够但状态没翻，不反复开关同一节',
      url: '/mock/frame.html?v=stale&rep=3',
      secs: 16,
      want: [/打开任务：1\.2/, /打开任务：1\.3/],
      expect: [true, true],
      extra: (blob) => {
        const n = once(blob, /打开任务：1\.2/g);
        const ok = n === 1;
        console.log((ok ? '  PASS ' : '  FAIL ') + '1.2 只被打开 1 次（实际 ' + n + ' 次）');
        return ok;
      }
    },
    {
      name: 'E 收尾：等上报落地再关，刷新后看到已完成并切下一节',
      url: '/mock/frame.html?tiny=1&req=6&rep=3',
      secs: 18,
      want: [/打开任务：1\.2/, /已停表，等站点保存进度/, /打开任务：1\.3/],
      expect: [true, true, true],
      extra: (blob) => {
        const n = once(blob, /打开任务：1\.2/g);
        const ok = n === 1;
        console.log((ok ? '  PASS ' : '  FAIL ') + '1.2 只被打开 1 次（实际 ' + n + ' 次）');
        return ok;
      }
    },
    {
      name: 'F 非整点：达标时不在上报点，先补到上报点再停表',
      url: '/mock/frame.html?tiny=1&req=4&rep=3',
      secs: 20,
      want: [/打开任务：1\.2/, /已停表，等站点保存进度/, /打开任务：1\.3/, /学时已够，等站点结算/],
      expect: [true, true, true, false],
      extra: (blob) => {
        const n = once(blob, /打开任务：1\.2/g);
        const ok = n === 1;
        console.log((ok ? '  PASS ' : '  FAIL ') + '1.2 只被打开 1 次（实际 ' + n + ' 次）');
        return ok;
      }
    },
    {
      name: 'G 上报丢失：靠本地记账顶住，先刷别的课不重开这节',
      url: '/mock/frame.html?tiny=1&req=6&rep=3&norep=1',
      secs: 16,
      want: [/打开任务：1\.2/, /打开任务：1\.3/],
      expect: [true, true],
      extra: (blob) => {
        const n = once(blob, /打开任务：1\.2/g);
        const ok = n === 1;
        console.log((ok ? '  PASS ' : '  FAIL ') + '1.2 只被打开 1 次（实际 ' + n + ' 次）');
        return ok;
      }
    },
    {
      name: 'H 本页只剩等待结算的课：轮询刷新而不是收工',
      url: '/mock/frame.html?v=done&tiny=1&req=6&rep=3&norep=1',
      secs: 18,
      want: [/打开任务：1\.2/, /学时已够，等站点结算/, /全部完成/],
      expect: [true, true, false],
      extra: (blob) => {
        const n = once(blob, /打开任务：1\.2/g);
        const ok = n === 1;
        console.log((ok ? '  PASS ' : '  FAIL ') + '1.2 只被打开 1 次（实际 ' + n + ' 次）');
        return ok;
      }
    }
  ];

  let pass = true;
  for (const c of cases) {
    if (ONLY && c.name.indexOf(ONLY) !== 0) continue;
    console.log('\n--- ' + c.name + ' ---');
    const blob = await runOnce(c.url, c.secs);
    if (String(blob).startsWith('INJECT_FAIL')) { console.log(blob); pass = false; continue; }
    blob.split('\n').forEach(l => console.log('  ' + l));
    await dumpStore();
    for (let i = 0; i < c.want.length; i++) {
      const hit = c.want[i].test(blob);
      const good = c.expect[i] ? hit : !hit;
      if (!good) pass = false;
      console.log((good ? '  PASS ' : '  FAIL ') + c.want[i].source + (c.expect[i] ? '' : '（不该出现）'));
    }
    if (c.extra && !c.extra(blob)) pass = false;
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'mock_result.png'), Buffer.from(shot.data, 'base64'));

  try { cdp.ws.close(); } catch (e) { }
  try { proc.kill(); } catch (e) { }
  server.close();
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.log('ERROR', e.message); process.exit(2); });
