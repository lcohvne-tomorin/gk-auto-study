# gk-auto-study

高校考试网（gaoxiaokaoshi.com）视频学时自动完成脚本。按章节顺序自动选课、静音播放、学时达标后先存进度再切下一节，自动翻页；切到后台、最小化，照样计时。

**当前版本 1.6.0** · [立即安装](https://github.com/lcohvne-tomorin/gk-auto-study/raw/main/gk-auto-study.user.js) · [更新日志](./CHANGELOG.md) · [问题反馈](https://github.com/lcohvne-tomorin/gk-auto-study/issues)

## 安装

| 方式 | 操作 |
|---|---|
| 推荐 | 浏览器打开 [gk-auto-study.user.js](https://github.com/lcohvne-tomorin/gk-auto-study/raw/main/gk-auto-study.user.js)，Tampermonkey 会自动弹出安装页 |
| 图文步骤 | 打开[安装页](https://lcohvne-tomorin.github.io/gk-auto-study/)，点「安装脚本」 |
| 手动 | Tampermonkey → 新建脚本 → 全选替换 → 保存 |

前置条件：浏览器装好 Tampermonkey（Chrome / Edge / Firefox）。装完打开 **我的课程** 页，右下角出现控制面板即生效。

## 它做什么

| 能力 | 说明 |
|---|---|
| 按章节顺序选课 | 每次刷新先退回第 1 页，从 1.1 起取第一个状态不是「已完成」的课；数字排序，`1.9 < 1.10 < 2.1` |
| 学时达标先存进度 | 不立刻关窗口，先等站点上报落地再切下一节，不会「刷完又从 0 刷一遍」 |
| 后台继续计时 | 四层伪装：可见性、暂停屏蔽、Worker 心跳、按真实秒数补偿 |
| 自动翻页 | 本页全完成翻下一页，仍按章节号取第一个未完成 |
| 防卡死 | 计时不动重开；站点不认账先等结算再重试，最多 2 次就跳过 |
| 面板可控 | 暂停、跳过、伪装开关、诊断 JSON、清记录 |

## 它不做什么

- **不伪造学习记录。** 补出的秒数恒等于真实挂机时间，只是把「切后台就停表」恢复成「照常计时」，不直接写 `m_time`、不伪造上报请求、不改视频进度。
- **不上传任何数据。** 单文件、`@grant none`、无外部依赖、不联网、不读账号密码、不写 Cookie；所有状态只在你自己浏览器的 `localStorage`。
- **不保证长期可用。** 站点改版会让脚本失效，见[更新日志](./CHANGELOG.md)。

> ⚠️ 脚本会代替你保持播放状态，与站点用户协议存在冲突，账号风险由使用者自行承担。请勿商业转售、请勿同时挂多个账号。

---

# 开发者文档

> 以下内容面向**接手的 agent / 开发者**：不止说「怎么用」，重点是「为什么这样写」和「改哪里会炸」。首次阅读建议按 3 → 4 → 5 的顺序。

## 1. 30 秒上手

```bash
# 语法检查
node --check gk-auto-study.user.js

# 全量回归（需要无头 Edge，约 3–5 分钟）
node mock/cdp_test.js

# 只跑某一组、并给播放页塞一个原生 video
ONLY=E EXTRA=video=1 node mock/cdp_test.js
```

安装：Tampermonkey → 新建脚本 → 全选替换 → 保存 → 打开
`http://www.gaoxiaokaoshi.com/Homew/MainPage.aspx?menu=3&subMenu=4`。

**装好后的第一条验证信号**（日志面板）：

```
[..] 脚本就绪 v1.6.0 · /Homew/MainPage.aspx
[..] 从第 1 页、1.1 开始按章节顺序检测
[..] 打开任务：1.3 国防建设（25分00秒 / 45分00秒）
[..] 播放器就绪，开始计时（已伪装前台）
[..] 学时达标（45分00秒 / 45分00秒），已停表，等站点保存进度…
[..] 打开任务：1.4 …        ← 同一个课程名不该出现两次
```

若「打开任务」里出现同一个课名两次、且学时从 0 重来 —— 收尾逻辑失效了，见 §8。

---

## 2. 文件结构

| 路径 | 作用 | 备注 |
|---|---|---|
| `gk-auto-study.user.js` | **唯一交付物**，油猴脚本 | 改这个 |
| `mock/frame.html` | 模拟框架页（`#mainIframe` + `#ExamView`） | 用 URL 参数切换场景 |
| `mock/list.html` | 模拟课程表（表格 + ASP.NET 风格分页） | 读 `localStorage` 里的假服务端学时 |
| `mock/player.html` | 模拟播放页（`myload`/`startclock`/`stopLoop`/上报） | 复刻真实站点的计时与上报 |
| `mock/cdp_test.js` | 无头 Edge + CDP 回归，8 组用例 | 与静态服务**同进程** |
| `serve.py` | 本地静态服务 + `POST /report`（遥测落盘） | 真机调试用，需 PNA 头 |
| `bskeval.sh` / `bskrun.sh` | browser-skill 封装（取 `context_id` 后 evaluate） | 真站探测用 |
| `gk-auto-study.user.js.v350.bak` | 历史对照版本 | 仅用于 A/B 复现旧 bug |

**mock 不是玩具**：`player.html` 刻意复刻了「上报是动态 `<script>`、iframe 一换就被 abort」这个真实行为，
所以它能稳定复现线上最恶心的问题。改收尾逻辑前先跑 mock，别直接上真站试。

---

## 3. 站点机制（读代码前必须先懂这个）

### 3.1 学时 = 挂机秒数，不是视频进度

播放页 `Study/LibraryStudy.aspx` 的原始逻辑：

```js
player.on('play',  function () { myload(); });   // 点火：起一条 1 秒一跳的链
player.on('pause', function () { stopLoop(); }); // 停表
player.on('ended', function () { stopLoop(); }); // 停表

function startclock() {
  timeCount++;
  var offset = now - (startTime + timeCount * 1000);
  nextTime = 1000 - offset;          // 只能纠正「这一跳晚了多少毫秒」
  m_time++;
  if (m_time % 60 == 0) 追加 <script src="updateTime.ashx?pTime=m_time&...">
  ...
}

document.addEventListener('visibilitychange', function () {
  if (document.hidden) player.pause(); else player.play();
});
```

三条结论，后面所有设计都建立在这上面：

1. **学时和视频播到第几分钟无关**，只和 `play` 之后挂了多少秒有关。所以刷课 ≠ 看完视频。
2. **停表只有一个入口**：那条 `visibilitychange` 监听。挡掉它，计时就不会停。
3. **上报只在 `m_time` 是 60 的整数倍时发生**，而且是**动态插入的 `<script>`**（JSONP 式），
   请求挂在播放页这个 `document` 上 —— document 一换，请求就 abort。

### 3.2 页面结构

```
Homew/MainPage.aspx?menu=3&subMenu=4   ← 框架页，脚本跑在这里
├── #mainIframe        课程表（Study/LibraryStudyList.aspx），ASP.NET 回发分页
└── #ExamView          播放页（Study/LibraryStudy.aspx?Id=&PlanId=），在 #viewBox 弹层里
```

- `showframe(name, id)` 打开播放器，**不用跳页**。
- 分页控件 `#PageSplit1_BtnNext` / `#PageSplit1_BtnPrev`，是回发按钮，一次只走一页。
- 课程表列：名称、状态（`已完成` / `学习中` / `未学习` / 空）、学时要求、已完成学时。
  **列位置不固定，按表头文字定位**（`headerMap()`），不要按列宽度或固定索引猜。

### 3.3 为什么「达标就关」会白刷

```
m_time=3600 达标 → 立即 closeDialog() + ExamView.src='about:blank'
                → 最后那条 pTime=3600 的请求被 abort
                → 服务端只记到 3540
                → 刷新后这节课还差 60 秒，状态仍是「学习中」
                → 脚本又选中它，m_time 归零，从头再刷
```

这是 v1.6.0 修的核心问题。解法见 §5.4。

---

## 4. 架构

### 4.1 状态机

`S.phase` 由 `tick()`（每秒一次）驱动，`goto(phase)` 切态并重置 `phaseAt`。

```
boot ──▶ rewind ──▶ scan ──▶ opening ──▶ studying ──▶ settling ──▶ flushing
          ▲            │                        ▲                        │
          │            │ 本页无待办              │                        ▼
          │            ├──▶ flipping ───────────┘                     closing
          │            │                                                │
          │            └──▶ settlewait ◀──┐                            ▼
          │                   │            │                        refreshing
          │                   └────────────┴──▶ waitlist ───────────────┘
          │                                        │
          └────────────────────────────────────────┘

旁路：redirecting（不在框架页 → 跳转）  soloPlayer（直接打开播放页 → 只守护，不选课）
终止：done（全部完成 / 暂停）  error（找不到课程表 / 打不开任务）
```

### 4.2 模块职责

| 模块 | 位置 | 职责 |
|---|---|---|
| `CFG` | 顶部 | 所有可调参数，见 §4.3 |
| `store` / `loadStore` / `saveStore` | 存储区 | localStorage 读写，跨天自动作废 |
| `S` | 状态区 | 运行时状态（phase、task、settle 现场、分页、日志） |
| `Spoof` | 前台伪装 | 改 `Document.prototype.hidden/visibilityState`，捕获阶段拦 `visibilitychange` |
| `Clock` | 计时补偿 | `guard()` 去重闸 + pause 屏蔽；`tick()` 按在播毫秒调 `startclock()` 补齐 |
| `startHeartbeat` | 后台心跳 | Web Worker 每秒 `postMessage`，绕过主线程节流 |
| `scanCourses` / `headerMap` / `chapterOrder` | 课程表解析 | 按表头定位列、解析秒数、章节号数字排序 |
| `pageIndicator` / `clickNextPage` / `clickPrevPage` | 分页 | 兼容有 id / 只有文字两种控件 |
| `openTask` / `playerState` / `ensurePlaying` / `closeDialog` | 播放器控制 | 打开任务、读 `m_time`、点火、关弹层 |
| `tick` + `do*` | 主状态机 | 各阶段的一次性推进逻辑 |
| `UI` | 面板 | Shadow DOM，330px，右下角；`renderLog` 由 `log()` 调 |
| `diagnose` | 诊断 | 导出 JSON 快照，线上排障主要靠它 |

### 4.3 CFG 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `autoStart` | `true` | 加载后自动开跑 |
| `mute` | `true` | 静音 |
| `spoofForeground` | `true` | 前台伪装总开关 |
| `tickMs` | `1000` | 主循环节奏 |
| `openTimeoutMs` | `25000` | 等播放器出现的上限 |
| `stallLimitMs` | `180000` | 学时 3 分钟不涨就重开 |
| `maxAttemptPerTask` | `4` | 同一任务最多重开次数 |
| `resumeCooldownMs` | `1200` | 续播/点火最小间隔，防连发 `play()` 复制计时链 |
| `reportAlignMs` | `70000` | 达标后最多等多久对齐到上报整点 |
| `reportFlushMs` | `2500` | 停表后等多久让上报落地 |
| `listWaitMs` | `18000` | 刷新课程表后等新 DOM 的上限 |
| `settleWaitMs` | `120000` | 本地学时够、站点没认：等结算的窗口 |
| `settlePollMs` | `20000` | 结算等待期间刷新课程表的间隔 |
| `maxSettleRounds` | `6` | 结算等待最多刷几轮 |
| `maxRetryPerTask` | `2` | 结算等不到后，最多重刷确认几次 |
| `maxPages` | `50` | 翻页上限 |

---

## 5. 关键设计决策

### 5.1 前台伪装 = 四层，缺一层就漏

| 层 | 做法 | 不做的后果 |
|---|---|---|
| ① 可见性伪装 | `Document.prototype` 的 `hidden` / `visibilityState` 恒返回「可见」；window 捕获阶段 `stopImmediatePropagation()` 掉 `visibilitychange` | 切后台瞬间站点调 `player.pause()`，计时停 |
| ② 暂停屏蔽 | 自动模式期间 `HTMLMediaElement.prototype.pause` 与 `player.pause` 变空操作（受 `__gkKeepPlaying` 控制） | 播放器自己「切后台就暂停」 |
| ③ Worker 心跳 | `setInterval` 放进 Web Worker，每秒 `postMessage` 回主线程 | 主线程定时器被压到 1 次/分钟，续播和补偿都瘫 |
| ④ 计时补偿 | `Clock.tick()` 按「在播累计毫秒」算期望 `m_time`，差值 ≥3 秒就用站点自己的 `startclock()` 补齐 | `m_time` 少涨（实测 90 秒后掉到 2 跳/分钟） |

**边界**：四层只做一件事——让页面按「它在前台」的规则运行。
**不伪造上报请求、不直接赋值 `m_time`、不改视频进度。** 补出去的秒数恒等于真实经过秒数
（实测比率 1.005，漂移 0.4 秒）。这条底线别破，否则脚本性质就变了。

### 5.2 `myload()` 必须去重

每次 `myload()` 都会新起一条 1 秒链。旧链定时器没死时再点一次 → **两条链并行 → 学时 1.7 倍**（实测）。
`Clock.guard()` 的重闸逻辑：2 秒内重复点火直接 `return`。同时打标记 `__gkLastIgnite`。

### 5.3 `Clock` 的锚点会污染

`Clock.baseM` 是「起算时的 `m_time`」，`creditMs` 是累计在播毫秒。换课时若不清零：

```
上一节累计 900 秒额度 → 新一节 m_time 从 0 开始
期望值 = baseM(旧) + 900 → 差值上百秒 → 一开播就判定达标
```

两条防线：`Clock.reset()` 在每个新任务、每次重开播放页时调用；
`tick()` 里若发现 `st.mTime < this.baseM`（`m_time` 归零）也重新起算。

另外 `started` 门闩保证「视频真正播过」之后才累计，缓冲期不白送时间。

### 5.4 收尾两阶段（本版核心）

```
studying  : total >= required
   ↓
settling  : 保持播放，把 m_time 推到 reportEvery(60) 的整数倍
            优先用站点 startclock() 直接补齐（后台补偿出来的值不保证在整点，干等会等不到）
            补不了才退回等待；超过 reportAlignMs 直接停表，最多丢不到 60 秒
   ↓
flushing  : __gkKeepPlaying=false → stopLoop() → player.pause()
            原地等 reportFlushMs(2.5s)，让动态 <script> 的请求跑完
            只把 floor(m_time / 60) * 60 + baseSec 记进 store.credit
   ↓
closing → refreshing → waitlist（等 #mainIframe 的 load）→ scan
```

两个易错点：

- **`beginFlush()` 里必须先 `__gkKeepPlaying = false`**，否则 pause 钩子把 `player.pause()` 也吞了，停不下来。
- **`credit` 只能记「服务端确实收到过」的整点部分**。`m_time=3607` 时服务端只知道 3600，
  记 3607 会让脚本误以为已完成、以后不再补那 7 秒。

### 5.5 刷新课程表不能立刻扫

`refreshList()` 触发的是 iframe 的 `reload`，是异步的。旧版刷新完立刻 `scanCourses()`，
读到的是**刷新前的 DOM** —— 于是拿「25 / 45 学习中」的旧数据做了「再开一次」的决策。

现在：`refreshList()` 记 `S.expectReload`，进 `waitlist`；`watchListFrame()` 监听
`#mainIframe` 的 `load` 事件写 `S.listLoadedAt`；只有 `listLoadedAt >= expectReload` 且稳定 300ms
才回 `scan`，超时 18 秒降级继续（打 warn）。

### 5.6 三层防死循环

| 场景 | 处理 |
|---|---|
| 计时卡住（3 分钟 `m_time` 不涨） | 关弹层重开，`attempts[id]++`，满 4 次 `store.skip` |
| 课程表显示学时已够、状态没翻 | 直接跳过（再开也是「达标→关闭」空转），记 `skip` |
| 本地 `credit` 够、站点不认 | 等结算 120 秒（每 20 秒刷一次表，最多 6 轮）→ 重刷确认最多 2 次 → 放弃 |

---

## 6. 存储

键：`gk_auto_study_v4`（`KEY`）。跨天自动重置。

```js
{
  day: "2026-11-02",
  done:     { "<courseId>": { name, at, count } },   // 本地判定刷完过；count 用于「满 4 次不再刷」
  attempts: { "<courseId>": 3 },                     // 重开次数
  skip:     { "<courseId>": { name, at, manual? } }, // 今日不再碰
  credit:   { "<courseId>": { name, sec, at, retries } } // 服务端确实收到过的学时
}
```

**为什么是 v4**：v3 及之前的 `done` 在「上报被 abort」时会误记完成，留着会导致漏课。
改 `KEY` 会让所有用户记录失效，**非必要不动**；动之前想清楚旧数据是否可信。

课程的唯一标识是 `videoIdOf(a)`：优先 `href` 里的 `Id=`，退化为 `onclick` 里的 `showframe(..., id)`，
再退化为名称。**任何改选课逻辑的改动都要确认 id 稳定**，否则 `skip`/`credit` 会串课。

---

## 7. 回归测试

```bash
node mock/cdp_test.js            # 全部 8 组
ONLY=E node mock/cdp_test.js     # 只跑 E
EXTRA=video=1                    # 播放页插入原生 <video>
SCRIPT=gk-auto-study.user.js.v350.bak   # 用别的脚本跑（版本对照）
```

| 用例 | 场景 | 断言要点 |
|---|---|---|
| A | 初始在第 2 页，第 1 页行序乱（1.3 学习中 / 1.1 已完成 / 1.2 未学习） | 先回第 1 页，选 1.2（按章节号，不是按行序） |
| B | 分页控件无 id，只剩「上一页」文字链接 | 仍能回退并选 1.2 |
| C | 第 1 页全部已完成 | 翻到第 2 页并打开 2.1 |
| D | 学时已够但状态没翻 | 同一节只打开 1 次，转等结算 |
| E | 达标时正好在上报点 | 停表等上报落地；刷新后看到已完成并切下一节 |
| F | 达标时不在上报点 | 先补到上报点再停表，尾巴不丢 |
| G | 服务端始终没收到上报（`norep=1`） | 靠 `credit` 顶住，先刷别的课，不重开这节 |
| H | 本页只剩等待结算的课 | 轮询刷新课程表，不直接判「全部完成」 |

**机制**：`node:http` 起静态服务（同进程，避免后台进程被回收）→ 拉起无头 Edge（CDP 9336）→
注入脚本 → 轮询 `localStorage` 里的假服务端状态 → 按日志正则断言。

mock 的 URL 参数：

| 参数 | 含义 |
|---|---|
| `v=done` | 所有课标为已完成 |
| `v=stale` | 学时已够但状态仍「学习中」 |
| `tiny=1&req=6` | 学时要求压到 6 秒，加快测试 |
| `rep=3` | 上报周期压到 3 秒（真实站点 60） |
| `norep=1` | 服务端丢弃上报，模拟 abort |
| `noid=1` | 分页控件去掉 id |
| `video=1` | 播放页插入原生 `<video>` |

---

## 8. 改动守则（红线）

1. **不要伪造 `updateTime.ashx` 请求，不要直接写 `m_time`。** 所有秒数必须过站点自己的
   `startclock()`，保证补出的时间等于真实经过时间。
2. **任何关闭弹层的路径都必须经过 `flushing`。** 包括「跳过」「暂停」「失败重开」——
   新增分支时检查是不是直接调了 `closeDialog()`。
3. **`myload()` 只能通过 `Clock.guard()` 包过的那层调用。** 直接 `w.myload()` 会绕过去重闸。
4. **换任务 / 重开播放页必须 `Clock.reset()`。** 漏一次就会补出几百秒。
5. **刷新课程表后必须走 `waitlist`。** 不要 `refreshList(); scanCourses();` 连着写。
6. **改选课逻辑时先确认 `videoIdOf()` 稳定。** id 变了 `skip`/`credit`/`attempts` 全部错位。
7. **`beginFlush()` 的第一件事是 `__gkKeepPlaying = false`。** 否则 pause 被钩子吞掉。
8. **改了 `@version` 记得同步 `window.__GK_AUTO_STUDY__`。** 两处不一致会让面板和日志对不上，
   测试脚本也会注入失败（它按 `@version` 校验）。

---

## 9. 排查手册

| 日志 / 现象 | 含义 | 往哪看 |
|---|---|---|
| `脚本就绪 v… ` 都没出现 | 脚本没注入 | `@match`、Tampermonkey 是否启用、是否在框架页 |
| `没找到课程表格` | 不在「我的课程」页，或表格结构变了 | `scanCourses()` 的表格选择器、`headerMap()` |
| `播放器就绪` 很久不出现 | `showframe` 没生效 / `#ExamView` 没加载 | `openTask()`、`playerWin()`、真站 DOM |
| 学时涨得比真实时间快 | 计时链重复（`myload` 被多点） | `Clock.guard()` 的 2 秒闸是否被绕过 |
| 学时涨得慢 / 不动 | 补偿失效、`startclock` 改名、visibility 没挡住 | 面板「诊断」里的 `player.realHidden` / `spoofed` |
| `学时达标…已停表` 后又出现同名任务 | 上报没落地 | `settling` 是否走到整点、`reportFlushMs` 是否太短 |
| `学时已够，等站点结算` 刷 6 轮后仍不认 | 服务端结算异常，或课程需要额外条件（考试/评价） | `store.credit`、真站课程详情 |
| `多次重开仍无进展，跳过` | 播放器压根没起播 | 视频源、`player.play` 是否被站点改动 |
| 面板一直「启动中」 | `boot()` 没跑完或 `tick` 被异常打断 | 控制台报错、`S.phase` |

调试技巧：面板「诊断」按钮导出 JSON（`version / phase / task / spoof / drift / store / courses / player / page`），
比看日志快。要在控制台直接看，用 `document.getElementById('gk-auto-host')` 拿不到内部状态——
状态在闭包里，只能通过诊断面板或 `window.__GK_AUTO_STUDY__`（仅版本号）。

真机遥测：`serve.py` 提供 `POST /report`，脚本侧需 `window.__GK_TELEMETRY__` 为真才上报
（`telemetry()` 里有闸），日志落在 `telemetry.log`。默认关闭，别在正式使用时开。

---

## 10. 已知限制

- **真实站点整轮未验证**：一节 45 分钟，开发环境只做到「后台计时比率实测 + mock 全链路复现」。
  收尾时序的正确性建立在 mock 对上报行为的精确复刻上，不是线上跑满一节的结果。
- **多页回退未实跑**：真站的分页回发在自动化环境里受插件页限制，只确认了控件存在；
  mock 覆盖了有 id / 无 id 两种形态。
- **站点改版即失效**：依赖 `#mainIframe`、`#ExamView`、`showframe`、`myload`、`startclock`、
  `stopLoop`、`m_time`、`playFlag`、`updateTime.ashx`。任一改名都要重新适配。
- **只在 Chromium 内核 + Tampermonkey 验证**（Edge 实测）。Firefox / Violentmonkey 未测。
- **`@grant none`**：脚本与页面同上下文，能直接调 `w.startclock()`。若改成沙箱模式，全部失效。
