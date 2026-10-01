# 播放器机制（底盘 · 不动）

镜头页 = 播放器底盘 + 画面层 + cue 时间轴。底盘所有"不动"部件统一在 `assets/template.html` 内，复制后只改标记区。

## 虚拟时钟

- 页面开头**先保存真实时钟** `_realNow = performance.now.bind(performance)`，再劫持 `requestAnimationFrame`，使其回调收到的时间戳即演出时间 `__now`。**切勿把 `performance.now` 劫持到自身**（会导致时间停摆）。
- 点击「启动播放」前时间恒为 `0`；按钮 `600ms` 淡出（`BOOT_FADE`），淡出**结束**后才 `startClock()`——起点与遮罩对齐，否则 render/probe 的第一帧会拍到还没淡完的黑场。
- CSS 动画与 JS cue 共用同一时钟，暂停、截图快进不漂移；`__vtick(ms)` 可把 `__now` 跳到任意毫秒（probe/render 用）。
- 固定舞台坐标 `1920×1080`，通过 `transform: translate(-50%, -50%) scale(s)` 适配窗口。
- **注意**：`__vtick` 只派发 `vtick` 事件（驱动 cue 与 tween），**不刷新 HUD**——`_syncHUD` 只在真实时钟里调用。所以确定性渲染时 HUD 会停在 `00:00`，render/probe 因此默认带 `?nohud=1`；无人值守录屏也用这个参数。
- URL 参数：`?auto=1` 自动播放、`?dur=毫秒` 覆盖时长、`?noboot=1` 跳过遮罩、`?nohud=1` 隐藏 HUD、`?notc=1` 隐藏角注。

## CSS 过渡 / 关键帧动画的确定性（重要）

`__vtick` 只能驱动 JS 侧的时间轴（`on/after/tween/cnt/camTo`），**管不到 CSS 的 `transition` 与 `@keyframes`**——它们由浏览器真实时钟驱动。后果：同一个毫秒在不同机器负载下会拍到**不同的过渡中间态**，渲染结果不可复现。

解决办法是 `window.__seekCss(ms)`（底盘已内置），它用 Web Animations API 把页面上所有动画 pause 并 seek：

```js
window.__seekCss = function(ms){
  for (const a of document.getAnimations()){
    const timing = a.effect.getComputedTiming();
    if (timing.iterations === Infinity){ a.cancel(); continue; }  // 无限动画无法定格，停用
    a.pause();
    a.currentTime = Math.max(0, ms - _lastCueAt);   // 只 seek「本 cue 已流逝」的部分
  }
};
```

- **必须在 `__vtick` 之后再调一次**：本轮 cue 新建的过渡，只有再 seek 一遍才会被算进去。
- `_lastCueAt` 是**上一个触发的 cue 的计划时刻**。用它做基准而不是 0，才能保留真实的过渡中间态（例如 600ms 加 `.in`、过渡 700ms，则在 800ms 应看到约 30% 完成的画面，而不是终态）。锚到 0 会让过渡"瞬间完成"。
- **无限动画**（`iterations: Infinity`，如加载转圈）无法定格，只能 `cancel()` 停用；要出现在成片里就必须改成有限次数或绝对时间驱动的补间。
- **据此改写法**：可控性上 `tween()` 优于 CSS 过渡（`tween` 由虚拟时钟驱动，天生可定格）。CSS 过渡/关键帧适合装饰性、非关键路径的动效；**关键节拍建议用 `tween`/`on` 表达**。
- render.js 与 probe.js 都走这套 seek；老页面（没有 `__seekCss`）会自动回退到内联实现，仍然确定性。

## 时间轴 API

- `on(ms, fn)`：一次性 cue（绝对时间）。
- `after(ms, fn)`：相对 `__now` 排程。
- `tween(from, to, dur, fn, ease)`：通用补间（虚拟时钟驱动）。
- `cnt(from, to, dur, { el, dec, onUpdate })`：数字滚动。
- `camTo` / `camFocus` / `tween` / `cnt` 由 cue 启动时，以「该 cue 的计划时刻」为起点，故 `__vtick` 快进时能定格到正确的中间态（自定义裸 `requestAnimationFrame` 循环不具备此特性，probe 需等其收敛）。
- 暂停时同时冻结 JS 时间轴、CSS 动画与 `body.paused`。
- 重播直接 `location.reload()`。

## 镜头调度（#cam）

所有画面内容放 `#cam` 内：

- `camTo(tx, ty, scale, duration)`：平移/缩放。
- `camFocus(fx, fy, scale, duration)`：对准焦点并自动限制边界。

常用缩放 `1.0–1.35`，重点推近 `1.12–1.30`。推荐节奏：

```
开场拉镜   初始特写 → 300ms 后拉回全景
关键推近   数字揭晓、盖章、结论
转场拉回   新面板入场前恢复全景
跟拍       主体逐站点亮，逐站 camFocus
Ken Burns  标题卡缓慢推近
冲击快推   高潮瞬间 0.45–0.6s 怼脸，再拉回
```

字幕、角注、HUD、电影黑边都放 `#cam` 外，避免被镜头变换影响。

## WebAudio 音效（无音频文件，六个合成原语）

```
pop    弹出        whoosh  镜头移动/大位移
swipe  快切        type    键击
ding   落定        thud    撞击/盖章
```

- 音效 cue 与视觉 cue 同帧，误差 ±50ms。
- 普通连击等距 `Tn`；缓出连击 `TnE` 先密后疏。
- 音量：主揭晓 `0.9–1.2`，日常 `0.4–0.6`，背景连击 `0.28–0.4`。
- 每秒不超 2–3 个主要音效，段落间留 ≥0.5s 静默。
- 模板默认 `master=0.24`、低通 `6500Hz`，不要改。

## 画面卡点

- `.letter` 上下电影黑边（高约 74px）用于慢放/高潮。
- `#dim` 暗角。
- 慢放标签胶囊、毫秒计数器。

## 数据与来源

- 一切数据给出处：`#cam` 外的 `.corner` 角注写来源（如 `数据来源：UN WPP 2024`）。
- 不做底部字幕条；口播只以 cue 注释对齐，如 `// 0:15「这句话对应画面」`。