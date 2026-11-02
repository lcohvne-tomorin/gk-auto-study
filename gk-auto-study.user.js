// ==UserScript==
// @name         高校考试网 · 自动刷课助手
// @name:zh-CN   高校考试网 自动刷课助手（视频学时）
// @namespace    https://github.com/lcohvne-tomorin/gk-auto-study
// @version      1.6.0
// @description  自动完成「我的课程」里的视频学习任务：从 1.1 起按章节顺序找第一个未完成的课，静音播放、达标后先把进度存住再切下一节，支持自动翻页；内置前台伪装，切到后台/最小化也能继续计时。
// @description:zh-CN  自动完成高校考试网「我的课程」视频任务：按章节顺序选课、静音播放、学时达标后先存进度再切下一节、自动翻页；切到后台也能计时。
// @author       lcohvne
// @license      MIT
// @homepageURL  https://github.com/lcohvne-tomorin/gk-auto-study
// @supportURL   https://github.com/lcohvne-tomorin/gk-auto-study/issues
// @downloadURL  https://raw.githubusercontent.com/lcohvne-tomorin/gk-auto-study/main/gk-auto-study.user.js
// @updateURL    https://raw.githubusercontent.com/lcohvne-tomorin/gk-auto-study/main/gk-auto-study.user.js
// @match        http://www.gaoxiaokaoshi.com/*
// @match        https://www.gaoxiaokaoshi.com/*
// @match        http://gaoxiaokaoshi.com/*
// @match        https://gaoxiaokaoshi.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
 * ── 这个站点的计时机制（2026-11-02 实测）────────────────────
 *
 * 播放页 LibraryStudy.aspx 里是这么写的：
 *
 *   player.on('play',  function(){ myload(); });     // 点火：起一条 1 秒一跳的链
 *   player.on('pause', function(){ stopLoop(); });   // 停表
 *   player.on('ended', function(){ stopLoop(); });   // 停表
 *
 *   function startclock(){
 *     timeCount++;
 *     var offset = now - (startTime + timeCount*1000);
 *     nextTime = 1000 - offset;      // 自校准，但只能纠正「延迟多少毫秒」
 *     m_time++;
 *     if (m_time % 60 == 0) 上报 updateTime.ashx?pTime=m_time
 *     ...
 *   }
 *
 *   document.addEventListener('visibilitychange', function(){
 *     if (document.hidden) player.pause(); else player.play();
 *   });
 *
 * 结论：学时 = play 之后的挂机秒数 m_time，和视频播到第几分钟无关；
 *      停表只有一个入口 —— 那条 visibilitychange 监听。
 *
 * ── 收尾时序────────────────────────────────────
 *
 * 站点只在 m_time 是 60 的整数倍时才追加上报脚本：
 *
 *   if (m_time % 60 == 0) <script src="updateTime.ashx?pTime=m_time&...">
 *
 * 这是动态 script（JSONP 式），请求挂在播放页这个 document 上。
 * 若一达标就立刻 easyDialog.close() + ExamView.src='about:blank'，
 * 最后那条上报会被一起 abort 掉 —— 服务端只记到上一个整点，
 * 刷新后这节课还「不完整」，于是又被选中、从头再刷一遍（m_time 归零，纯浪费）。
 *
 * 现在分两步收尾：
 *   settling  保持播放，把 m_time 推到 60 的整数倍（最多等 reportAlignMs）
 *   flushing  停表后原地等 reportFlushMs，让最后一条上报落地，再关弹层
 * 另外把「本地刷到的学时」记进 store.credit：课程表还没跟上时先等结算，
 * 不重开同一节课。
 * ──────────────────────────────────────────────────────────
 *
 * ── 选课规则────────────────────────────────────
 *
 * 每次页面加载后的第一次扫描，先把课程列表退回第 1 页，然后按章节号升序
 * （1.1 → 1.2 → … → 2.1）找「状态」列不是「已完成」的第一门课开刷；
 * 本页全部完成才翻到下一页，翻页后同样按章节号取第一个未完成的。
 * 判断依据只有站点自己的状态列，本地记录只用于「刷不动就跳过」的防死循环。
 * ──────────────────────────────────────────────────────────
 *
 * ── 前台伪装（切后台/最小化照样计时）────────────────────────
 *
 * 停表只有一个入口：那条 visibilitychange 监听。让它永远不发生：
 *   1. 可见性伪装：把 Document.prototype 的 hidden / visibilityState 改成恒返回「可见」，
 *      并在 window 捕获阶段拦掉 visibilitychange（早于 document 上的监听，站点那行不执行）
 *   2. 暂停屏蔽：自动模式期间把 video.pause / player.pause 变空操作，
 *      挡掉播放器自己「切后台就暂停」的行为
 *   3. Worker 心跳：主线程 setInterval 在后台被压到 1 次/分钟，
 *      改用 Web Worker 的定时器（实测不受节流）驱动主线程，维持 1 秒一次巡检
 *   4. 计时补偿：按「视频在播的累计毫秒数」调站点自己的 startclock() 补回丢掉的 tick
 *
 * 四层合起来只做一件事 —— 让页面按「它在前台」的规则运行。
 * 不伪造上报请求、不直接写 m_time、不改视频进度；补出去的秒数恒等于真实经过秒数。
 *
 * 实测（2026-11-02，真实后台标签、跨过 Chromium 5 分钟强节流阈值）：
 *   188 秒真实时间 → m_time 涨 189 秒，比率 1.007，漂移 0.4 秒；
 *   期间站点自己的 updateTime.ashx?pTime=60/120/180 全部正常发出。
 * ──────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__GK_AUTO_STUDY__) return;
  window.__GK_AUTO_STUDY__ = '1.6.0';

  /* ============ 配置 ============ */

  const CFG = {
    autoStart: true,
    mute: true,
    spoofForeground: true,      // 前台伪装总开关（面板可切）
    tickMs: 1000,               // 主循环节奏
    openTimeoutMs: 25000,       // 等播放器出现的上限
    stallLimitMs: 180000,       // 学时 3 分钟不涨就重开
    maxAttemptPerTask: 4,       // 同一任务最多重开次数
    resumeCooldownMs: 1200,     // 续播最小间隔，防止连发 play() 把计时链复制成多条
    telemetryEveryMs: 10000,    // 遥测（仅在 window.__GK_TELEMETRY__ 存在时启用）
    reportAlignMs: 70000,       // 达标后最多再走这么久，等 m_time 落到 60 的整数倍（站点只在整点上报）
    reportFlushMs: 2500,        // 停表后再等这么久，让站点最后一条上报请求落地
    listWaitMs: 18000,          // 刷新课程表之后，等新 DOM 的上限
    settleWaitMs: 120000,       // 本地学时已够、站点状态未翻：先等这么久让它结算，别急着重开
    settlePollMs: 20000,        // 结算等待期间，隔多久刷一次课程表
    maxSettleRounds: 6,         // 结算等待最多刷几次（6 x 20s ≈ settleWaitMs）
    maxRetryPerTask: 2,         // 结算等不到时，最多重刷确认几次
    frameUrl: 'http://www.gaoxiaokaoshi.com/Homew/MainPage.aspx?menu=3&subMenu=4',
    maxPages: 50
  };

  const KEY = 'gk_auto_study_v4';   // 存储键固定为 v4：早期版本的 done 记录在「上报被 abort」时会误记完成，旧键已作废

  /* ============ 存储 ============ */

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadStore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    if (s.day !== todayKey()) s = { day: todayKey(), done: {}, attempts: {}, skip: {}, credit: {} };
    if (!s.done) s.done = {};
    if (!s.attempts) s.attempts = {};
    if (!s.skip) s.skip = {};
    if (!s.credit) s.credit = {};
    return s;
  }

  function saveStore() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  let store = loadStore();

  /* ============ 状态 ============ */

  const S = {
    phase: 'boot',        // boot|rewind|scan|opening|studying|settling|flushing|closing|refreshing|waitlist|flipping|done|error
    paused: !CFG.autoStart,
    task: null,           // { id, name, requiredSec, studiedSec, videoId }
    phaseAt: 0,
    openAt: 0,
    settle: null,         // 收尾现场：{ at, total, baseSec, frozeM, stoppedAt }
    expectReload: 0,      // 发起课程表刷新（reload）的时刻；等 #mainIframe 的 load 追上它
    listLoadedAt: 0,      // 课程表 iframe 最近一次 load 完成的时刻
    settleRounds: 0,      // 本次选课的结算等待已刷了几轮课程表
    rewound: false,       // 本次加载是否已退回到第 1 页
    rewinds: 0,           // 已连点「上一页」的次数（防跑飞）
    lastProgressAt: 0,
    lastProgressSec: 0,
    doneToday: Object.keys(store.done).length,
    pages: 1,
    logs: [],
    // 计时漂移监测：sessionStart 起，wall 走了多少秒 vs m_time 涨了多少秒
    mark: null,           // { wall, mTime }
    drift: 0,             // 秒，正数表示页面时钟比真实时间慢
    lastTelemetryAt: 0
  };

  /* ============ 工具 ============ */

  function textOf(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value || '').trim();
    return String(el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseSeconds(text) {
    if (!text) return 0;
    const t = String(text).replace(/\s/g, '');
    let h = 0, m = 0, s = 0, hit = false;
    let r = t.match(/(\d{1,3})小时/); if (r) { h = +r[1]; hit = true; }
    r = t.match(/(\d{1,4})分(?:钟)?/); if (r) { m = +r[1]; hit = true; }
    r = t.match(/(\d{1,2})秒/); if (r) { s = +r[1]; hit = true; }
    if (hit) return h * 3600 + m * 60 + s;
    const p = t.split(':').map(Number);
    if (p.length === 3 && p.every(n => !isNaN(n))) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2 && p.every(n => !isNaN(n))) return p[0] * 60 + p[1];
    return 0;
  }

  function fmtSec(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + '分' + String(s).padStart(2, '0') + '秒';
  }

  function log(msg, kind) {
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    S.logs.push({ t: '[' + ts + '] ' + msg, k: kind || '' });
    if (S.logs.length > 200) S.logs.shift();
    UI.renderLog();
  }

  /* ============ 页面结构访问 ============ */

  function frameWin(id) {
    const f = document.getElementById(id);
    if (!f) return null;
    try {
      const w = f.contentWindow;
      if (w && w.document) return w;
    } catch (e) { /* 跨域 */ }
    return null;
  }

  /** 课程列表所在 window：优先 #mainIframe，其次当前页 */
  function listWin() {
    const w = frameWin('mainIframe');
    if (w) return w;
    if (document.querySelector('table')) return window;
    return null;
  }

  /** 直接打开播放页（顶层文档就是播放器）时，玩家对象在 window 上 */
  function isSoloPlayer() {
    if (!/LibraryStudy\.aspx/i.test(location.pathname)) return false;
    try { return typeof window.player !== 'undefined' && !!window.player; } catch (e) { return false; }
  }

  function playerWin() {
    if (isSoloPlayer()) return window;
    return frameWin('ExamView');
  }

  function getPlayer() {
    const w = playerWin();
    if (!w) return null;
    try {
      if (w.player && typeof w.player.play === 'function') return w.player;
    } catch (e) { /* ignore */ }
    return null;
  }

  function isFramePage() {
    return !!document.getElementById('ExamView');
  }

  /* ============ 前台伪装 ============ */

  const Spoof = {
    on: CFG.spoofForeground,
    patched: 0,
    failed: 0,

    /**
     * 让目标 window 的文档永远自报「可见」，并拦住 visibilitychange。
     * 可重复调用：新 document（iframe 换地址）会换一整套原型对象，所以要重打。
     */
    patch(w) {
      if (!this.on || !w) return false;
      let done = false;
      try { done = !!w.__gkSpoofed; } catch (e) { return false; }
      if (done) return true;

      let D;
      try { D = w.Document && w.Document.prototype; } catch (e) { D = null; }
      if (!D) { this.failed++; return false; }

      try {
        // 存一份「真实值」的读法，供面板/遥测判断自己是不是真的被切到后台
        const dh = Object.getOwnPropertyDescriptor(D, 'hidden');
        const dv = Object.getOwnPropertyDescriptor(D, 'visibilityState');
        w.__gkReal = {
          hidden: dh && dh.get ? function () { try { return dh.get.call(w.document); } catch (e) { return false; } } : function () { return false; },
          vis: dv && dv.get ? function () { try { return dv.get.call(w.document); } catch (e) { return 'visible'; } } : function () { return 'visible'; }
        };

        Object.defineProperty(D, 'hidden', { configurable: true, get: function () { return false; } });
        Object.defineProperty(D, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
        Object.defineProperty(D, 'webkitHidden', { configurable: true, get: function () { return false; } });
        Object.defineProperty(D, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });

        try {
          Object.defineProperty(w.document, 'hasFocus', { configurable: true, value: function () { return true; } });
        } catch (e) { /* ignore */ }

        // 捕获阶段拦在 window 上：早于 document 上的监听，站点那行不会再执行
        const block = function (e) { e.stopImmediatePropagation(); };
        w.addEventListener('visibilitychange', block, true);
        w.addEventListener('webkitvisibilitychange', block, true);

        w.__gkSpoofed = true;
        this.patched++;
        return true;
      } catch (e) {
        this.failed++;
        return false;
      }
    },

    /** 绕过伪装读真实的 hidden，用于面板提示与遥测 */
    realHidden(w) {
      try {
        if (w && w.__gkReal) return !!w.__gkReal.hidden();
      } catch (e) { /* ignore */ }
      return false;
    },

    /** 播放页可能被换过地址，每轮都补一次（幂等） */
    keep() {
      this.patch(playerWin());
    }
  };

  /* ============ 计时补偿 ============ */

  /*
   * 后台标签里，Chromium 会把这个 1 秒一跳的 setTimeout 链压到 1 次/分钟。
   * 站点自己的 `offset` 自校准只能补「这一跳晚了多少毫秒」，补不回丢掉的 tick，
   * 实测 90 秒后时钟就掉到 2 跳/分钟（见 2026-11-02 遥测）。
   *
   * 补偿办法：按真实经过的秒数，调站点自己的 startclock() 把缺的 tick 补回来。
   *   - 补的过程中把 playFlag 临时置 false，startclock 末尾就不会再排新链（避免链复制）
   *   - 补完恢复 playFlag，原有那条 pending 定时器会自然接上，始终只有一条链
   *   - 只在「视频元素确实在播」时补，暂停期间一秒都不多给
   * 全程只用站点自己的递增与上报逻辑，补出来的时间恒等于真实经过时间。
   */

  const Clock = {
    baseM: null,         // 起算点：首次见到的 m_time
    lastAt: 0,           // 上次调用时刻
    creditMs: 0,         // 累计「视频确实在播」的毫秒数（唯一真值）
    started: false,      // 视频是否真的开始播过（缓冲期不算）
    caughtUp: 0,         // 累计补了多少秒（诊断用）
    note: '',

    /** 换任务 / 重新打开播放页时归零 */
    reset() {
      this.baseM = null;
      this.lastAt = 0;
      this.creditMs = 0;
      this.started = false;
      this.note = 'reset';
    },

    isPlaying(st) {
      if (!st) return false;
      if (st.videoPaused === false) return true;
      if (st.videoPaused === null) return !!st.playing;
      return false;
    },

    /**
     * 给站点的 myload 加一道去重闸。
     * myload 每次调用都会新起一条 1 秒链；如果上一条链的定时器还没死，
     * 就会出现两条链同时跳，学时凭空变快（实测曾到 1.7 倍）。
     * 2 秒内重复点火直接忽略 —— 那说明已经有一条链在跑。
     */
    guard(w) {
      if (!w) return;

      // ① myload 去重：防止两条计时链并存
      try {
        if (!w.__gkClockGuard) {
          const orig = w.myload;
          if (typeof orig === 'function') {
            w.myload = function () {
              const now = Date.now();
              if (now - (w.__gkLastIgnite || 0) < 2000) return;
              w.__gkLastIgnite = now;
              return orig.apply(this, arguments);
            };
            w.__gkClockGuard = true;
          }
        }
      } catch (e) { /* ignore */ }

      // ② 屏蔽「非用户意图」的暂停：切到后台后播放器会自己 pause，
      //    那是学时归零的直接原因。自动模式下直接放行 play，不给 pause。
      try {
        const MP = w.HTMLMediaElement && w.HTMLMediaElement.prototype;
        if (MP && typeof MP.pause === 'function' && !MP.__gkNoPause) {
          const origPause = MP.pause;
          MP.pause = function () {
            if (w.__gkKeepPlaying) return;
            return origPause.apply(this, arguments);
          };
          MP.__gkNoPause = true;
        }
      } catch (e) { /* ignore */ }

      try {
        const p = w.player;
        if (p && typeof p.pause === 'function' && !p.__gkNoPause) {
          const origP = p.pause;
          p.pause = function () {
            if (w.__gkKeepPlaying) return;
            return origP.apply(this, arguments);
          };
          p.__gkNoPause = true;
        }
      } catch (e) { /* ignore */ }
    },

    /** 调试用：记录是谁调了 video.pause()（仅在遥测模式下挂钩） */
    tracePause(w) {
      if (!w || !window.__GK_TELEMETRY__) return;
      try {
        if (w.__gkPauseHook) return;
        const MP = w.HTMLMediaElement && w.HTMLMediaElement.prototype;
        if (!MP || !MP.pause) return;
        const orig = MP.pause;
        MP.pause = function () {
          try { w.__gkPauseStack = String((new Error()).stack || '').replace(/\n\s+/g, ' | ').slice(0, 320); } catch (e) { /* ignore */ }
          return orig.apply(this, arguments);
        };
        w.__gkPauseHook = true;
      } catch (e) { /* ignore */ }
    },

    tick(w, st) {
      this.guard(w);
      this.tracePause(w);
      if (!w || !st) { this.note = 'no-player'; return 0; }

      const now = Date.now();
      if (this.isPlaying(st)) this.started = true;

      // 计不计算的判据跟站点保持一致：只要播放器处于「我们在让它播」的状态就算。
      // 后台里视频偶尔会短暂缓冲/被掐一下，那一刻视频元素 paused=true，
      // 但站点自己的 m_time 照走 —— 按站点的规则来，才和前台行为一致。
      // started 保证「视频真的开始播过」之后才开始计，缓冲期不白送时间。
      const playing = (this.started && !!w.__gkKeepPlaying) || this.isPlaying(st);

      // 首次见到 / m_time 归零（换课）→ 重新起算
      if (this.baseM === null || st.mTime < this.baseM) {
        this.baseM = st.mTime;
        this.lastAt = now;
        this.creditMs = 0;
        this.note = 'base';
        return 0;
      }

      // 只有「视频确实在播」的时间才计入额度；暂停期间不累计，
      // 但已经累计出来的缺口不会因为一次抖动就丢掉
      if (playing && this.lastAt) this.creditMs += now - this.lastAt;
      this.lastAt = now;

      const expected = this.baseM + Math.floor(this.creditMs / 1000);
      let add = expected - st.mTime;
      if (add < 3) { this.note = (playing ? 'ok:' : 'paused:') + add; return 0; }
      if (add > 7200) add = 7200;
      if (typeof w.startclock !== 'function') { this.note = 'no-startclock:' + (typeof w.startclock); return 0; }

      const saved = !!w.playFlag;
      w.playFlag = false;
      try {
        for (let i = 0; i < add; i++) w.startclock();
      } catch (e) {
        w.playFlag = saved;
        this.note = 'throw:' + (e && e.message);
        return 0;
      }
      w.playFlag = saved;

      this.caughtUp += add;
      this.note = 'added:' + add;
      return add;
    }
  };

  /* ============ 后台心跳 ============ */

  /*
   * 后台标签里主线程的 setInterval 会被压到 1 次/分钟，导致：
   *   - 播放器被暂停后要等一分钟才有人去续播
   *   - 计时补偿也只能一分钟补一次
   * Web Worker 的定时器不受页面可见性节流，用它当心跳，主线程里收到消息就干活。
   */
  function startHeartbeat() {
    if (window.__GK_HB) return;
    try {
      const src = 'var n=0;setInterval(function(){n++;postMessage(n);},1000);';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const wk = new Worker(url);
      window.__GK_HB = wk;
      wk.onmessage = function () {
        S.wk = (S.wk || 0) + 1;
        if (S.paused) return;
        try { tick(); } catch (e) { /* ignore */ }
      };
    } catch (e) {
      S.wk = -1;          // -1 表示创建失败（多半是站点 CSP 禁了 blob worker）
    }
  }

  /* ============ 遥测（仅调试时启用） ============ */

  function telemetry(extra) {
    const url = window.__GK_TELEMETRY__;
    if (!url) return;
    const now = Date.now();
    if (now - S.lastTelemetryAt < CFG.telemetryEveryMs) return;
    S.lastTelemetryAt = now;

    const w = playerWin();
    const st = playerState();
    const body = JSON.stringify(Object.assign({
      v: window.__GK_AUTO_STUDY__,
      wall: now,
      phase: S.phase,
      task: S.task ? S.task.name : '',
      mTime: st ? st.mTime : null,
      baseSec: st ? st.baseSec : null,
      playing: st ? st.playing : null,
      videoPaused: st ? st.videoPaused : null,
      realHidden: Spoof.realHidden(w),
      spoofOn: Spoof.on,
      spoofPatched: Spoof.patched,
      drift: S.drift,
      caughtUp: Clock.caughtUp,
      note: Clock.note || '',
      wk: S.wk || 0,
      tk: S.tk || 0,
      pauseStack: w && w.__gkPauseStack ? w.__gkPauseStack : ''
    }, extra || {}));

    try {
      fetch(url, { method: 'POST', mode: 'cors', body: body, keepalive: true })
        .catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  /* ============ 解析课程表 ============ */

  function headerMap(table) {
    const map = {};
    const tr = table.querySelector('tr');
    if (!tr) return map;
    const cells = tr.children;
    for (let i = 0; i < cells.length; i++) {
      const t = textOf(cells[i]);
      if (!t) continue;
      if (/课程名称/.test(t)) map.name = i;
      else if (/分类/.test(t)) map.category = i;
      else if (/学时要求/.test(t)) map.required = i;
      else if (/已完成学时/.test(t)) map.studied = i;
      else if (/状态/.test(t)) map.status = i;
      else if (/开始学习/.test(t)) map.studyCol = i;
      else if (/练习/.test(t)) map.examCol = i;
    }
    return map;
  }

  function statusKey(text) {
    if (/已完成|已学完|完成学习/.test(text)) return 'done';
    if (/学习中|进行中|正在学习/.test(text)) return 'doing';
    if (/未学习|未开始|未完成|未观看/.test(text)) return 'todo';
    return '';
  }

  /**
   * 从课程名里取章节序号：「1.1 国防建设」→ [1,1]，「2.4全民国家安全教育公开课（一）」→ [2,4]。
   * 取不到序号（比如没有编号的课）就排到本页最后，保持表格原顺序。
   */
  function chapterOrder(name, idx) {
    const m = String(name || '').match(/(\d+)\s*[.．、]\s*(\d+)(?:\s*[.．、]\s*(\d+))?/);
    if (!m) return [9999, idx, 0];
    return [+m[1], +m[2], m[3] ? +m[3] : 0];
  }

  function cmpOrder(a, b) {
    const x = a.order, y = b.order;
    for (let i = 0; i < x.length; i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function videoIdOf(a) {
    if (!a) return '';
    const oc = a.getAttribute('onclick') || '';
    let m = oc.match(/showframe\s*\(\s*['"][^'"]*['"]\s*,\s*(\d+)/);
    if (m) return m[1];
    m = oc.match(/[?&]Id=(\d+)/);
    if (m) return m[1];
    const href = a.getAttribute('href') || '';
    m = href.match(/[?&]Id=(\d+)/);
    if (m) return m[1];
    return '';
  }

  function scanCourses() {
    const w = listWin();
    if (!w) return [];
    const doc = w.document;
    const out = [];
    const tables = doc.querySelectorAll('table');
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti];
      const map = headerMap(table);
      if (map.name == null || map.status == null) continue;

      const trs = table.querySelectorAll('tr');
      for (let i = 1; i < trs.length; i++) {
        const tr = trs[i];
        const cells = tr.children;
        if (!cells || cells.length <= map.status) continue;

        const name = textOf(cells[map.name]);
        if (!name || /课程名称/.test(name)) continue;

        const stText = textOf(cells[map.status]);
        const st = statusKey(stText);
        if (!st) continue;

        let a = null;
        if (map.studyCol != null && cells[map.studyCol]) {
          a = cells[map.studyCol].querySelector('a');
        }
        if (!a) {
          const as = tr.querySelectorAll('a');
          for (let k = 0; k < as.length; k++) {
            if (/开始学习|继续学习|重新学习/.test(textOf(as[k]))) { a = as[k]; break; }
          }
        }

        const videoId = videoIdOf(a);
        out.push({
          name: name,
          order: chapterOrder(name, i),
          status: st,
          statusText: stText,
          requiredSec: map.required != null ? parseSeconds(textOf(cells[map.required])) : 0,
          studiedSec: map.studied != null ? parseSeconds(textOf(cells[map.studied])) : 0,
          videoId: videoId,
          id: videoId || ('n_' + name),
          link: a
        });
      }
      if (out.length) break;
    }
    return out;
  }

  function pageIndicator() {
    const w = listWin();
    if (!w) return null;
    const d = w.document;
    const li = d.querySelector('.page .fright ul li');
    if (!li) return null;
    const m = textOf(li).match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { cur: +m[1], total: +m[2] };
  }

  function clickNextPage() {
    const w = listWin();
    if (!w) return false;
    const d = w.document;

    const pi = pageIndicator();
    if (pi && pi.cur >= pi.total) return false;

    const btn = d.getElementById('PageSplit1_BtnNext');
    if (btn) {
      if (btn.hasAttribute('disabled')) return false;
      btn.click();
      return true;
    }

    // 兜底：找文本「下一页」
    const as = d.querySelectorAll('a,input[type="button"],button');
    for (let i = 0; i < as.length; i++) {
      if (/^下一页|^下页/.test(textOf(as[i])) && !as[i].disabled) {
        as[i].click();
        return true;
      }
    }
    return false;
  }

  function clickPrevPage() {
    const w = listWin();
    if (!w) return false;
    const d = w.document;

    const btn = d.getElementById('PageSplit1_BtnPrev');
    if (btn) {
      if (btn.hasAttribute('disabled')) return false;
      btn.click();
      return true;
    }

    // 兜底：找文本「上一页」
    const as = d.querySelectorAll('a,input[type="button"],button');
    for (let i = 0; i < as.length; i++) {
      if (/^上一页|^上页/.test(textOf(as[i])) && !as[i].disabled) {
        as[i].click();
        return true;
      }
    }
    return false;
  }

  /* ============ 播放器控制 ============ */

  function openTask(task) {
    const w = listWin();
    let planId = '32';
    if (w) {
      const ddl = w.document.getElementById('ddlClass');
      if (ddl && ddl.value) planId = ddl.value;
    }

    if (typeof window.showframe === 'function') {
      const url = '../Study/LibraryStudy.aspx?Id=' + task.videoId + '&PlanId=' + planId;
      window.showframe(task.name, url, 810, 560);
      return true;
    }

    // 没有 showframe（非框架页），退化为点击
    if (task.link) { task.link.click(); return true; }
    return false;
  }

  function playerState() {
    const w = playerWin();
    if (!w) return null;
    let m = 0, base = 0, flag = false;
    try {
      m = Number(w.m_time) || 0;
      flag = !!w.playFlag;
      const h = w.document.getElementById('hidStudyTime');
      base = h ? (Number(h.value) || 0) * 60 : 0;
    } catch (e) { return null; }

    let paused = null;
    try {
      const v = w.document.querySelector('video');
      if (v) paused = v.paused;
    } catch (e) { /* ignore */ }

    return { mTime: m, baseSec: base, playing: flag, videoPaused: paused };
  }

  let lastPlayCallAt = 0;
  let lastArmAt = 0;
  let flagFalseAt = 0;          // 第一次发现「链断了」的时刻

  function videoPausedOf(w) {
    try {
      const v = w.document.querySelector('video');
      if (v) return v.paused;
    } catch (e) { /* ignore */ }
    return null;
  }

  function ensurePlaying() {
    const p = getPlayer();
    const w = playerWin();
    if (!p || !w) return false;

    if (CFG.mute) {
      try { if (typeof p.mute === 'function') p.mute(); } catch (e) { /* ignore */ }
      try {
        const v = w.document.querySelector('video');
        if (v) { v.muted = true; v.volume = 0; }
      } catch (e) { /* ignore */ }
    }

    let flag = false;
    try { flag = !!w.playFlag; } catch (e) { /* ignore */ }
    if (flag) { flagFalseAt = 0; return false; }

    const now = Date.now();

    // 先只记下「发现断了」的时刻，等 2 秒让上一条链的残留定时器自然死掉再点火，
    // 否则两代链会并存，学时跑得比真实时间快
    if (!flagFalseAt) { flagFalseAt = now; return false; }
    if (now - flagFalseAt < 2000) return false;

    let acted = false;

    // 1) 视频真的停了 → 恢复播放
    let vp = videoPausedOf(w);
    if (vp === true && now - lastPlayCallAt >= CFG.resumeCooldownMs) {
      lastPlayCallAt = now;
      acted = true;
      try { p.play(); } catch (e) { log('play() 失败: ' + e.message, 'err'); }
      vp = videoPausedOf(w);          // play() 多半同步生效，立刻复查
    } else if (vp !== true && now - lastArmAt >= CFG.resumeCooldownMs) {
      // 2) 视频在播、但计时链断了（play() 没触发站点的 play 事件时就是这样）；
      //    或者压根读不到 video 元素（播放器不是原生 video）—— 都直接用站点
      //    自己的 myload 点火，等价于它又收到一次 play 事件
      lastArmAt = now;
      acted = true;
      try { if (typeof w.myload === 'function') w.myload(); } catch (e) { /* ignore */ }
    }

    return acted;
  }

  function closeDialog() {
    const w = playerWin();
    if (w) w.__gkKeepPlaying = false;            // 收尾时放行 pause
    try { if (w && typeof w.stopLoop === 'function') w.stopLoop(); } catch (e) { /* ignore */ }
    try { if (w && w.player && typeof w.player.pause === 'function') w.player.pause(); } catch (e) { /* ignore */ }
    try {
      if (window.easyDialog && typeof window.easyDialog.close === 'function') {
        window.easyDialog.close();
      }
    } catch (e) { /* ignore */ }
    const vb = document.getElementById('viewBox');
    if (vb) {
      try { vb.style.display = 'none'; } catch (e) { /* ignore */ }
    }
    const ev = document.getElementById('ExamView');
    if (ev) {
      try { ev.src = 'about:blank'; } catch (e) { /* ignore */ }
    }
  }

  function onListLoad() {
    S.listLoadedAt = Date.now();
  }

  /** #mainIframe 的 load 只挂一次；reload 会复用同一个元素，所以挂在元素上就够 */
  function watchListFrame() {
    const f = document.getElementById('mainIframe');
    if (!f || f.__gkLoadWatched) return;
    f.__gkLoadWatched = true;
    try { f.addEventListener('load', onListLoad); } catch (e) { /* ignore */ }
  }

  function refreshList() {
    S.expectReload = Date.now();
    watchListFrame();
    const f = document.getElementById('mainIframe');
    if (f) {
      try { f.contentWindow.location.reload(); return; } catch (e) { /* ignore */ }
    }
    location.reload();
  }

  /* ============ 主状态机 ============ */

  function goto(phase) {
    S.phase = phase;
    S.phaseAt = Date.now();
    UI.render();
  }

  function elapsed() { return Date.now() - S.phaseAt; }

  function tick() {
    S.tk = (S.tk || 0) + 1;
    if (S.paused) { UI.render(); return; }

    // 直接打开播放页：不跑状态机，只做守护
    if (isSoloPlayer()) { soloTick(); return; }

    // 不在框架页：先切到「我的课程」框架
    if (!isFramePage() && S.phase !== 'redirecting') {
      const path = location.pathname;
      if (/LibraryStudy\.aspx|Login/i.test(path)) return;
      if (/MainPage/i.test(path)) return;
      S.phase = 'redirecting';
      UI.render();
      log('当前不是课程框架页，正在打开「我的课程」…');
      setTimeout(() => { location.href = CFG.frameUrl; }, 500);
      return;
    }

    switch (S.phase) {
      case 'boot':
        goto('scan');
        break;

      case 'rewind':
        doRewind();
        break;

      case 'scan':
        doScan();
        break;

      case 'opening':
        doOpening();
        break;

      case 'studying':
        doStudying();
        break;

      case 'settling':
        doSettling();
        break;

      case 'flushing':
        doFlushing();
        break;

      case 'closing':
        closeDialog();
        goto('refreshing');
        break;

      case 'refreshing':
        if (elapsed() > 800) { refreshList(); goto('waitlist'); }
        break;

      case 'waitlist':
        doWaitList();
        break;

      case 'settlewait':
        if (elapsed() > CFG.settlePollMs) { refreshList(); goto('waitlist'); }
        break;

      case 'flipping':
        if (elapsed() > 300) { doFlip(); }
        break;

      case 'done':
      case 'error':
        break;

      default:
        goto('scan');
    }
  }

  /** 退回第 1 页：站点分页是 ASP.NET 回发，一次只退一页，靠状态机分多轮完成 */
  function doRewind() {
    const pi = pageIndicator();
    if (!pi) { if (elapsed() > 4000) { S.rewound = true; goto('scan'); } return; }

    if (pi.cur <= 1) {
      S.rewound = true;
      log('已回到第 1 页（共 ' + pi.total + ' 页），从 1.1 开始检测', 'ok');
      goto('scan');
      return;
    }

    if (elapsed() < 900) return;                  // 等回发落地
    if (S.rewinds >= 30) {                        // 防跑飞
      S.rewound = true;
      log('回退页数过多，从当前页继续', 'warn');
      goto('scan');
      return;
    }

    if (clickPrevPage()) {
      S.rewinds++;
      goto('rewind');                             // 重置计时，等这一轮回发
    } else {
      S.rewound = true;
      log('没找到「上一页」，从当前页继续', 'warn');
      goto('scan');
    }
  }

  /**
   * 这一节在本地已经刷够，但站点还没认（课程表里仍是「学习中」）。
   * 返回 true = 值得再刷几次课程表等等看，别急着重开。
   */
  function creditWaiting(c) {
    const cr = store.credit[c.id];
    if (!cr || !(c.requiredSec > 0) || cr.sec < c.requiredSec) return false;
    if ((cr.retries || 0) >= CFG.maxRetryPerTask) return false;
    return Date.now() - (cr.at || 0) < CFG.settleWaitMs;
  }

  function doScan() {
    const courses = scanCourses();

    if (!courses.length) {
      if (elapsed() < 8000) return;      // 表格可能还在加载
      // 完全找不到课程表
      S.phase = 'error';
      UI.render();
      log('没找到课程表格。请在左侧菜单点「我的课程」。', 'warn');
      return;
    }

    const pi = pageIndicator();
    S.pages = pi ? pi.cur : 1;

    // 本次加载后的首轮扫描：一律先退回第 1 页（1.1 所在页），再从 1.1 往下找
    if (!S.rewound) {
      if (!pi) {
        S.rewound = true;                        // 没有分页控件 = 只有一页
      } else if (pi.cur > 1) {
        goto('rewind');
        return;
      } else {
        S.rewound = true;
        log('从第 1 页、1.1 开始按章节顺序检测');
      }
    }

    const pending = courses.filter(c => {
      if (c.status === 'done') return false;      // 以站点「状态」列为准
      if (store.skip[c.id]) return false;         // 今日已判定刷不动，避免死循环

      // 本站「已完成学时」是累加的：学时早就够了、状态却还挂着「学习中」时，
      // 再开一次会立刻判定达标→关掉→再打开，变成空转。这种情况直接跳过。
      const rec = store.done[c.id];
      if (rec) {
        if (c.requiredSec > 0 && c.studiedSec >= c.requiredSec) return false;
        if ((rec.count || 0) >= 4) return false;
      }

      // 本地记账：这一节刚被我们刷够过，课程表还没跟上（服务端结算有延迟）。
      // 这时重开会把 m_time 归零、从头再刷一遍 —— 先等它结算。
      const cr = store.credit[c.id];
      if (cr && c.requiredSec > 0 && cr.sec >= c.requiredSec) {
        if (creditWaiting(c)) return false;                          // 还在等站点结算
        if ((cr.retries || 0) >= CFG.maxRetryPerTask) return false;   // 重刷过几次仍不认
      }
      return true;
    });

    if (!pending.length) {
      // 还有课「本地学时够了、站点没认」—— 多半是服务端结算慢。
      // 隔一会儿刷一次课程表再看，别急着翻页收工。
      const waiting = courses.filter(c => c.status !== 'done' && !store.skip[c.id] && creditWaiting(c));
      if (waiting.length && S.settleRounds < CFG.maxSettleRounds) {
        S.settleRounds++;
        log('「' + waiting[0].name + '」学时已够，等站点结算后刷新课程表（' + S.settleRounds + '/' + CFG.maxSettleRounds + '）', 'warn');
        goto('settlewait');
        return;
      }

      // 本页做完
      if (clickNextPage()) {
        log('本页已全部完成，翻到下一页');
        goto('flipping');
      } else {
        S.phase = 'done';
        UI.render();
        log('全部完成，今日共 ' + S.doneToday + ' 个任务', 'ok');
      }
      return;
    }

    // 章节顺序：1.1 → 1.2 → … → 2.1，取第一个未完成的
    pending.sort(cmpOrder);
    const target = pending[0];

    // 走到这里说明「本地刷够 → 等结算」的等待期已经过了，课程表仍说没完成：
    // 记一次重刷确认；次数用完就放弃这一节，别在它身上死磕。
    const cr = store.credit[target.id];
    if (cr && target.requiredSec > 0 && cr.sec >= target.requiredSec) {
      cr.retries = (cr.retries || 0) + 1;
      cr.at = Date.now();
      saveStore();
      log('「' + target.name + '」学时已够但站点仍未标记完成，重刷确认（' + cr.retries + '/' + CFG.maxRetryPerTask + '）', 'warn');
    }

    // 调试钩子：临时压低达标阈值，用于验证「完成→切换」闭环
    if (window.__GK_TEST_REQ__) {
      const forced = Number(window.__GK_TEST_REQ__);
      if (forced > 0) {
        log('测试钩子生效：达标阈值改为 ' + fmtSec(forced), 'warn');
        target.requiredSec = forced;
      }
    }

    S.task = target;
    S.mark = null;
    S.drift = 0;
    S.settleRounds = 0;           // 换了任务，结算等待重新计数
    Clock.reset();                // 新任务从 0 起算，别继承上一节的额度
    goto('opening');
    S.openAt = Date.now();

    log('打开任务：' + target.name + '（' + fmtSec(target.studiedSec) + ' / ' + fmtSec(target.requiredSec) + '）');

    if (!target.videoId) {
      log('没解析出视频 Id，尝试直接点按钮', 'warn');
    }

    const ok = openTask(target);
    if (!ok) {
      log('打开失败：找不到 showframe 也没找到按钮', 'err');
      goto('error');
    }
  }

  function doOpening() {
    Spoof.keep();

    const p = getPlayer();
    if (p) {
      ensurePlaying();
      S.lastProgressAt = Date.now();
      S.lastProgressSec = 0;
      log('播放器就绪，开始计时' + (Spoof.on ? '（已伪装前台）' : ''), 'ok');
      goto('studying');
      return;
    }
    if (elapsed() > CFG.openTimeoutMs) {
      log('播放器加载超时，跳过本次', 'err');
      store.attempts[S.task.id] = (store.attempts[S.task.id] || 0) + 1;
      saveStore();
      closeDialog();
      goto('refreshing');
    }
  }

  /** 真实经过秒数 − m_time 增长秒数 = 漂移；正数表示页面时钟落后于真实时间 */
  function calcDrift(st) {
    if (!S.mark || st.mTime < S.mark.mTime) {
      S.mark = { wall: Date.now(), mTime: st.mTime };
      return;
    }
    const wall = (Date.now() - S.mark.wall) / 1000;
    const mine = st.mTime - S.mark.mTime;
    S.drift = Math.round((wall - mine) * 10) / 10;
  }

  /** 直接打开播放页时的守护循环：伪装前台 + 续播 + 漂移监测 */
  function soloTick() {
    Spoof.patch(window);
    window.__gkKeepPlaying = !S.paused;

    if (!playerState()) return;

    ensurePlaying();

    // 回复播放之后再取快照，否则会拿「暂停时」的旧值判断在不在播
    let st = playerState();
    if (!st) return;

    const added = Clock.tick(window, st);
    if (added > 0) st = playerState() || st;

    if (!S.task) {
      const pl = document.getElementById('hidPassLine');
      const line = pl ? Number(pl.value) || 0 : 0;
      S.task = {
        id: 'solo',
        name: '播放页（直接打开）',
        requiredSec: line * 60,
        studiedSec: st.baseSec,
        videoId: ''
      };
      S.mark = null;
      Clock.reset();
      goto('studying');
      log('直接进入播放页，已接管计时守护');
    }

    calcDrift(st);

    const total = st.baseSec + st.mTime;
    S.task.liveSec = total;
    S.task.sessionSec = st.mTime;
    S.task.playing = st.playing;
    UI.renderProgress();
    telemetry({ event: 'solo', total: total });
  }

  function doStudying() {
    Spoof.keep();

    const pw = playerWin();
    if (pw) pw.__gkKeepPlaying = !S.paused;      // 自动模式下不允许被暂停

    let st = playerState();
    if (!st) {
      // iframe 被换掉/没了
      log('播放器不见了，重开', 'warn');
      store.attempts[S.task.id] = (store.attempts[S.task.id] || 0) + 1;
      saveStore();
      goto('refreshing');
      return;
    }

    ensurePlaying();

    // 回复播放之后再取快照，否则会拿「暂停时」的旧值判断在不在播
    st = playerState() || st;

    // 后台被节流丢掉的秒数，用站点自己的 startclock 补回来
    const added = Clock.tick(playerWin(), st);
    if (added > 0) {
      st = playerState() || st;
      if (added >= 30) log('后台节流丢了 ' + added + ' 秒，已补齐', 'warn');
    }

    const total = Math.max(st.baseSec, S.task.studiedSec) + st.mTime;

    // 计时漂移：真实过去了多少秒 vs m_time 涨了多少秒
    calcDrift(st);

    if (S.task.requiredSec > 0 && total >= S.task.requiredSec) {
      // 「够了」不等于「站点知道了」。站点只在 m_time 是 60 的整数倍时才追加上报
      // 脚本，而且用的是动态 <script>。以前在这里直接关弹层 + 把 ExamView 换成
      // about:blank，最后那条上报跟着被 abort，服务端只记到上一个整点 ——
      // 刷新后这节课还差一截，于是被重新打开、m_time 归零再刷一遍。
      S.settle = {
        at: Date.now(),
        total: total,
        baseSec: Math.max(st.baseSec, S.task.studiedSec),
        frozeM: null,
        stoppedAt: 0
      };
      S.task.liveSec = total;
      UI.renderProgress();
      telemetry({ event: 'reached', total: total, mTime: st.mTime });
      goto('settling');
      return;
    }

    // 进度推进监测
    if (st.mTime > S.lastProgressSec) {
      S.lastProgressSec = st.mTime;
      S.lastProgressAt = Date.now();
    } else if (Date.now() - S.lastProgressAt > CFG.stallLimitMs) {
      const n = (store.attempts[S.task.id] || 0) + 1;
      store.attempts[S.task.id] = n;
      saveStore();
      if (n >= CFG.maxAttemptPerTask) {
        log('多次重开仍无进展，跳过：' + S.task.name, 'err');
        store.skip[S.task.id] = { name: S.task.name, at: Date.now() };
        saveStore();
        goto('closing');
      } else {
        log('计时卡住了，重开播放器（第 ' + n + ' 次）', 'warn');
        closeDialog();
        setTimeout(() => {
          S.task = null;
          goto('scan');
        }, 800);
      }
      return;
    }

    S.task.liveSec = total;
    S.task.sessionSec = st.mTime;
    S.task.playing = st.playing;
    UI.renderProgress();
    telemetry({ event: 'tick', total: total });
  }

  /* ── 收尾两步：先把 m_time 走到上报点，再等请求落地 ─────────────
   *
   * 站点 startclock() 里只有这一行会保存进度：
   *   if (m_time % 60 == 0) 追加 <script src="updateTime.ashx?pTime=m_time&...">
   * 动态 script 的请求挂在播放页 document 上，document 一换就 abort。
   *
   * settling：用站点自己的 startclock() 把 m_time 补到下一个上报点
   *           （后台补偿出来的秒数不保证落在整点上，干等会等不到）。
   *           补不了就退回等待，超过 reportAlignMs 直接停表 —— 最多丢不到 60 秒。
   * flushing：停表后原地等 reportFlushMs，让最后一条上报跑完再关弹层。
   * ────────────────────────────────────────────────────────── */

  /** 站点的上报周期：真实站点里写死 60 秒；mock 用 window.reportEvery 压低，方便回归 */
  function reportEvery(w) {
    let n = 60;
    try {
      const v = Number(w && w.reportEvery);
      if (v > 0) n = v;
    } catch (e) { /* ignore */ }
    return n;
  }

  function doSettling() {
    const pw = playerWin();
    let st = playerState();

    if (!pw || !st) { beginFlush(); return; }
    Spoof.keep();
    pw.__gkKeepPlaying = true;                  // 这一段还要继续走表

    const every = reportEvery(pw);
    const aligned = st.mTime > 0 && st.mTime % every === 0;
    const tooLong = Date.now() - S.settle.at > CFG.reportAlignMs;
    if (aligned || tooLong) { beginFlush(); return; }

    // 站点只在整点上报，但后台补偿出来的 m_time 由「累计在播毫秒」决定，
    // 不保证落在整点上 —— 干等可能永远等不到。这里直接用站点自己的
    // startclock() 补齐到下一个整点：补出来的秒数是真实挂机时间，
    // 补的瞬间 playFlag 置 false，不会多排一条计时链。
    const need = every - (st.mTime % every);
    if (st.mTime > 0 && need > 0 && need < every && typeof pw.startclock === 'function') {
      const saved = !!pw.playFlag;
      pw.playFlag = false;
      try {
        for (let i = 0; i < need; i++) pw.startclock();
      } catch (e) { /* ignore */ }
      pw.playFlag = saved;
      st = playerState() || st;
      if (st.mTime > 0 && st.mTime % every === 0) { beginFlush(); return; }
    }

    // 补不了（没有 startclock / 抛错）就退回等待：让站点自己的链走到整点
    ensurePlaying();
    st = playerState() || st;
    const added = Clock.tick(pw, st);
    if (added > 0) {
      st = playerState() || st;
      if (st.mTime > 0 && st.mTime % every === 0) { beginFlush(); return; }
    }

    S.task.liveSec = (S.settle.baseSec || 0) + st.mTime;
    UI.renderProgress();
    telemetry({ event: 'settling', mTime: st.mTime });
  }

  function beginFlush() {
    const pw = playerWin();
    let m = 0;
    try { m = Number(pw && pw.m_time) || 0; } catch (e) { /* ignore */ }

    if (pw) {
      pw.__gkKeepPlaying = false;               // 先放行 pause，否则停不下来
      try { if (typeof pw.stopLoop === 'function') pw.stopLoop(); } catch (e) { /* ignore */ }
      try { if (pw.player && typeof pw.player.pause === 'function') pw.player.pause(); } catch (e) { /* ignore */ }
    }

    S.settle.frozeM = m;
    S.settle.stoppedAt = Date.now();

    const total = (S.settle.baseSec || 0) + m;
    log('学时达标（' + fmtSec(total) + ' / ' + fmtSec(S.task.requiredSec) + '），已停表，等站点保存进度…', 'ok');
    telemetry({ event: 'flush', mTime: m, total: total });
    goto('flushing');
  }

  function doFlushing() {
    if (elapsed() < CFG.reportFlushMs) return;

    // 只把「服务端确实收到过」的部分记进 credit：站点按整点上报，
    // m_time 停在非整点时，尾巴那几十秒服务端是不知道的。
    const m = (S.settle && S.settle.frozeM) || 0;
    const base = (S.settle && S.settle.baseSec) || 0;
    const every = reportEvery(playerWin());
    const reported = m > 0 ? Math.floor(m / every) * every : 0;
    const creditSec = base + reported;

    const id = S.task.id;
    store.credit[id] = { name: S.task.name, sec: creditSec, at: Date.now(), retries: 0 };

    const prev = store.done[id];
    store.done[id] = {
      name: S.task.name,
      at: Date.now(),
      count: ((prev && prev.count) || 0) + 1
    };
    S.doneToday = Object.keys(store.done).length;
    saveStore();

    S.task.creditSec = creditSec;
    telemetry({ event: 'done', mTime: m, creditSec: creditSec });
    S.settle = null;
    goto('closing');
  }

  /** 刷新课程表之后必须等新 DOM 落地再扫，否则会拿旧表格做决策 */
  function doWaitList() {
    const fresh = S.listLoadedAt && S.listLoadedAt >= S.expectReload;
    if (fresh && elapsed() > 300) {
      S.expectReload = 0;
      goto('scan');
      return;
    }
    if (elapsed() > CFG.listWaitMs) {
      log('课程表刷新超时，按当前内容继续', 'warn');
      S.expectReload = 0;
      goto('scan');
    }
  }

  function doFlip() {
    if (S.pages >= CFG.maxPages) { S.phase = 'done'; UI.render(); return; }
    goto('scan');
  }

  /* ============ 面板 ============ */

  const UI = {
    host: null,
    root: null,
    el: {},
    collapsed: false,

    mount() {
      if (this.host) return;
      const host = document.createElement('div');
      host.id = 'gk-auto-host';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:14px;bottom:14px;';
      document.documentElement.appendChild(host);
      this.host = host;

      const root = host.attachShadow({ mode: 'open' });
      this.root = root;

      root.innerHTML = [
        '<style>',
        ':host{all:initial}',
        '*{box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
        '.panel{width:330px;background:#16181d;color:#d7dae0;border:1px solid #2e343c;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.5);font-size:12px;overflow:hidden}',
        '.hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#1e2126;border-bottom:1px solid #2e343c}',
        '.dot{width:8px;height:8px;border-radius:50%;background:#7d8590;flex:0 0 auto}',
        '.dot.run{background:#3fb950;box-shadow:0 0 7px #3fb950}',
        '.dot.wait{background:#d29922}',
        '.dot.ok{background:#58a6ff}',
        '.dot.err{background:#f85149}',
        '.ttl{font-weight:600;color:#e6edf3;flex:1}',
        '.mini{cursor:pointer;color:#8b949e;padding:0 5px;font-size:14px;line-height:1}',
        '.mini:hover{color:#e6edf3}',
        '.bd{padding:10px 11px}',
        '.row{display:flex;justify-content:space-between;gap:10px;margin-bottom:5px;line-height:1.5}',
        '.k{color:#7d8590;flex:0 0 auto}',
        '.v{color:#e6edf3;text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}',
        '.bar{height:5px;background:#242830;border-radius:3px;overflow:hidden;margin:9px 0 11px}',
        '.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2f81f7,#3fb950);transition:width .4s}',
        '.warnbox{display:none;margin:8px 0;padding:6px 8px;border-radius:6px;background:#3d2b00;color:#f0b429;font-size:11px;line-height:1.5}',
        '.warnbox.on{display:block}',
        '.btns{display:flex;gap:6px;flex-wrap:wrap}',
        'button{flex:1;min-width:62px;padding:5px 8px;border-radius:6px;cursor:pointer;border:1px solid #3a4149;background:#242830;color:#d7dae0;font-size:11px}',
        'button:hover{background:#2d323a}',
        'button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}',
        '.log{margin-top:9px;max-height:120px;overflow:auto;font-size:11px;line-height:1.6;color:#8b949e;border-top:1px solid #2e343c;padding-top:7px}',
        '.log .warn{color:#d29922}',
        '.log .err{color:#f85149}',
        '.log .ok{color:#3fb950}',
        '.diag{display:none;margin-top:9px}',
        'textarea{width:100%;height:150px;background:#0b0e13;color:#8b949e;border:1px solid #2e343c;border-radius:6px;font-family:Consolas,monospace;font-size:10px;padding:6px;resize:vertical}',
        '.hidden{display:none!important}',
        '</style>',
        '<div class="panel">',
        '  <div class="hd"><span class="dot" id="dot"></span><span class="ttl">自动刷课 · 视频</span><span class="mini" id="toggle">—</span></div>',
        '  <div class="bd" id="body">',
        '    <div class="row"><span class="k">状态</span><span class="v" id="mode">启动中</span></div>',
        '    <div class="row"><span class="k">任务</span><span class="v" id="task">—</span></div>',
        '    <div class="row"><span class="k">学时</span><span class="v" id="prog">—</span></div>',
        '    <div class="bar"><i id="fill"></i></div>',
        '    <div class="row"><span class="k">前台伪装</span><span class="v" id="spoof">—</span></div>',
        '    <div class="warnbox" id="warnbox"></div>',
        '    <div class="btns">',
        '      <button id="btn-pause">暂停</button>',
        '      <button id="btn-skip">跳过</button>',
        '      <button id="btn-spoof">伪装开</button>',
        '      <button id="btn-diag">诊断</button>',
        '      <button id="btn-reset">清记录</button>',
        '    </div>',
        '    <div class="log" id="log"></div>',
        '    <div class="diag" id="diagbox">',
        '      <textarea id="diagtext" readonly></textarea>',
        '      <div class="btns" style="margin-top:6px"><button id="btn-copy">全选复制</button><button id="btn-hide">收起</button></div>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('');

      const g = id => root.getElementById(id);
      this.el.dot = g('dot');
      this.el.mode = g('mode');
      this.el.task = g('task');
      this.el.prog = g('prog');
      this.el.fill = g('fill');
      this.el.warn = g('warnbox');
      this.el.spoof = g('spoof');
      this.el.log = g('log');
      this.el.body = g('body');
      this.el.diagbox = g('diagbox');
      this.el.diagtext = g('diagtext');

      g('toggle').addEventListener('click', () => {
        this.collapsed = !this.collapsed;
        this.el.body.classList.toggle('hidden', this.collapsed);
        g('toggle').textContent = this.collapsed ? '+' : '—';
      });

      g('btn-pause').addEventListener('click', () => {
        S.paused = !S.paused;
        log(S.paused ? '已暂停（弹层未关闭）' : '已继续');
        UI.render();
      });

      g('btn-skip').addEventListener('click', () => {
        if (S.task) {
          store.skip[S.task.id] = { name: S.task.name, at: Date.now(), manual: true };
          saveStore();
          log('已跳过：' + S.task.name);
        }
        closeDialog();
        goto('refreshing');
      });

      g('btn-spoof').addEventListener('click', () => {
        Spoof.on = !Spoof.on;
        if (Spoof.on) {
          Spoof.patch(window);
          Spoof.patch(playerWin());
          log('前台伪装已开启');
        } else {
          log('前台伪装已关闭（切走标签就会停表）', 'warn');
        }
        UI.render();
      });

      g('btn-diag').addEventListener('click', () => {
        this.el.diagtext.value = diagnose();
        this.el.diagbox.style.display = 'block';
      });

      g('btn-hide').addEventListener('click', () => { this.el.diagbox.style.display = 'none'; });

      g('btn-copy').addEventListener('click', () => {
        this.el.diagtext.focus();
        this.el.diagtext.select();
        try { document.execCommand('copy'); log('已复制', 'ok'); } catch (e) { log('请手动 Ctrl+A / Ctrl+C'); }
      });

      g('btn-reset').addEventListener('click', () => {
        store = { day: todayKey(), done: {}, attempts: {}, skip: {}, credit: {} };
        saveStore();
        S.doneToday = 0;
        log('已清空今日记录');
        UI.render();
      });

      this.renderLog();
    },

    render() {
      if (!this.el.mode) return;
      const map = {
        boot: ['启动中', ''],
        rewind: ['回到第 1 页', 'wait'],
        scan: ['扫描课程', 'run'],
        opening: ['打开任务', 'wait'],
        studying: ['学习中', 'run'],
        settling: ['等上报点', 'wait'],
        flushing: ['保存进度', 'wait'],
        closing: ['收尾', 'run'],
        refreshing: ['刷新列表', 'run'],
        waitlist: ['等课程表', 'wait'],
        settlewait: ['等结算', 'wait'],
        flipping: ['翻页', 'run'],
        done: ['全部完成', 'ok'],
        error: ['需要处理', 'err'],
        redirecting: ['跳转中', 'wait']
      };
      const m = map[S.phase] || [S.phase, ''];
      this.el.mode.textContent = m[0] + (S.doneToday ? ' · 今日 ' + S.doneToday : '');
      this.el.dot.className = 'dot ' + (S.paused ? 'wait' : m[1]);
      this.el.task.textContent = S.task ? S.task.name : '—';

      const pb = this.root && this.root.getElementById('btn-pause');
      if (pb) {
        pb.textContent = S.paused ? '继续' : '暂停';
        pb.classList.toggle('on', S.paused);
      }

      const sb = this.root && this.root.getElementById('btn-spoof');
      if (sb) {
        sb.textContent = Spoof.on ? '伪装开' : '伪装关';
        sb.classList.toggle('on', Spoof.on);
      }

      this.renderProgress();
      this.renderVisibility();
    },

    renderProgress() {
      if (!this.el.prog) return;
      if (!S.task) {
        this.el.prog.textContent = '—';
        this.el.fill.style.width = '0%';
        return;
      }
      const cur = S.task.liveSec || S.task.studiedSec || 0;
      const req = S.task.requiredSec || 0;
      this.el.prog.textContent = req ? (fmtSec(cur) + ' / ' + fmtSec(req)) : fmtSec(cur);
      this.el.fill.style.width = req ? Math.min(100, cur / req * 100) + '%' : '0%';
      this.el.task.textContent = S.task.name;
    },

    renderVisibility() {
      if (!this.el.spoof) return;
      const w = playerWin();
      const realHidden = Spoof.realHidden(w);

      if (!Spoof.on) {
        this.el.spoof.textContent = '关闭';
        this.el.warn.textContent = '⚠️ 前台伪装已关闭。切走标签页或最小化窗口，站点会暂停播放并停止计时。';
        this.el.warn.classList.toggle('on', realHidden && !S.paused);
        return;
      }

      this.el.spoof.textContent = '开启 · 已接管 ' + Spoof.patched + ' 个文档';
      if (realHidden && S.phase === 'studying') {
        this.el.warn.textContent = '已伪装前台：页面在后台，但计时器照常走。（' + (S.drift > 0 ? '漂移 ' + S.drift + ' 秒' : '无漂移') + '）';
        this.el.warn.classList.add('on');
      } else {
        this.el.warn.classList.remove('on');
      }
    },

    renderLog() {
      if (!this.el.log) return;
      const frag = document.createDocumentFragment();
      const list = S.logs.slice(-40);
      for (let i = 0; i < list.length; i++) {
        const d = document.createElement('div');
        d.className = list[i].k;
        d.textContent = list[i].t;
        frag.appendChild(d);
      }
      this.el.log.innerHTML = '';
      this.el.log.appendChild(frag);
      this.el.log.scrollTop = this.el.log.scrollHeight;
    }
  };

  /* ============ 诊断 ============ */

  function diagnose() {
    const out = {
      version: window.__GK_AUTO_STUDY__,
      url: location.href,
      phase: S.phase,
      task: S.task,
      spoof: { on: Spoof.on, patched: Spoof.patched, failed: Spoof.failed },
      drift: S.drift,
      store: store,
      hasShowframe: typeof window.showframe,
      hasEasyDialog: typeof window.easyDialog,
      frames: Array.from(document.querySelectorAll('iframe')).map(f => ({
        id: f.id, name: f.name, src: (f.src || '').slice(0, 160)
      })),
      courses: [],
      player: null
    };

    const cs = scanCourses();
    out.courses = cs.map(c => ({
      name: c.name, status: c.status, requiredSec: c.requiredSec,
      studiedSec: c.studiedSec, videoId: c.videoId
    }));

    const w = playerWin();
    if (w) {
      const ps = playerState();
      out.player = ps ? {
        mTime: ps.mTime, baseSec: ps.baseSec, playing: ps.playing, videoPaused: ps.videoPaused
      } : { note: 'playerWin 存在但读取失败' };
      try {
        out.player.hasPlayerObj = !!(w.player && w.player.play);
        out.player.spTitle = w.document.getElementById('spTitle') ? w.document.getElementById('spTitle').textContent : '';
        out.player.realHidden = Spoof.realHidden(w);
        out.player.spoofed = !!w.__gkSpoofed;
        out.player.docHidden = w.document.hidden;
      } catch (e) { /* ignore */ }
    }

    const pi = pageIndicator();
    out.page = pi;

    return JSON.stringify(out, null, 2);
  }

  /* ============ 启动 ============ */

  function boot() {
    UI.mount();
    Spoof.patch(window);
    log('脚本就绪 v' + window.__GK_AUTO_STUDY__ + ' · ' + location.pathname);

    document.addEventListener('visibilitychange', () => {
      UI.renderVisibility();
    });

    // 播放页每换一次任务就是一次 iframe 导航，新的 document 需要重新接管
    const f = document.getElementById('ExamView');
    if (f) f.addEventListener('load', () => { Spoof.patch(playerWin()); });

    watchListFrame();

    if (S.paused) { S.phase = 'done'; UI.render(); return; }

    S.phase = 'boot';
    startHeartbeat();
    setInterval(tick, CFG.tickMs);
    setTimeout(tick, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
