// 用途：无头截帧质检（确定性冻结：任意毫秒定格，查重叠/穿帮/收尾）
// 用法：node probe.js <页面.html> <毫秒> [输出.png]        单张定格图
//       node probe.js <页面.html> 800,4000,9000           → 输出 _frame_<ms>ms.png
//       node probe.js <页面.html> 600,1800,3000,4200,6000,7800 --sheet
//                                                         → 额外拼一张 _sheet.png 接触表
// 原理：先注入 0s 过渡/动画，再 __vtick(ms) 让所有 <=ms 的 cue 一次性到位并定格，
//       因此截图不受 CSS 过渡中间态影响，可精确复核任意时间点。
// 选项：
//   --sheet             把各时间点拼成一张接触表（默认 3 列，可 --cols=N）
//   --cols=3            接触表列数
//   --settle=1300       每个时间点定格后等待毫秒数（默认 1300，等裸 rAF 动画收敛）
//   --width / --height  视口尺寸（默认 1920×1080）
// 环境变量：PLAYWRIGHT_HOME 指向含 playwright 的 node_modules 目录。
const fs = require("fs");
const path = require("path");

// pop-video 工具依赖（playwright / ffmpeg-static）的实际安装位置。
// 整个目录搬迁时只改这一行；也可用 PLAYWRIGHT_HOME 环境变量覆盖。
const TOOLS_HOME = "D:/OpenCode/tools/pop-video";

function loadPW() {
  const cands = [
    process.env.PLAYWRIGHT_HOME && path.join(process.env.PLAYWRIGHT_HOME, "playwright"),
    process.env.PLAYWRIGHT_HOME && path.join(process.env.PLAYWRIGHT_HOME, "node_modules", "playwright"),
    process.env.PLAYWRIGHT_HOME,
    path.join(__dirname, "..", "node_modules", "playwright"),
    path.join(TOOLS_HOME, "node_modules", "playwright"),
  ].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch (_) {} }
  try { return require("playwright"); } catch (_) {}
  throw new Error("未找到 playwright。可设 PLAYWRIGHT_HOME 指向含 playwright 的 node_modules 目录（或项目根）。");
}

const { chromium } = loadPW();

/* ---------------- 参数解析 ---------------- */
const FLAGS = { sheet: false };
const OPT = { cols: 3, settle: 1300, width: 1920, height: 1080 };
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a === "--sheet") FLAGS.sheet = true;
  else if (/^--(cols|settle|width|height)=/.test(a)) {
    const [k, v] = a.slice(2).split("=");
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) {
      if (k === "cols") OPT.cols = n;
      else if (k === "settle") OPT.settle = n;
      else if (k === "width") OPT.width = n;
      else if (k === "height") OPT.height = n;
    }
  } else if (!a.startsWith("--")) positional.push(a);
}

/** 等字体文件真正就绪，并按需加载实际用到的字重/字族（否则会拍到 fallback 字体、漏掉 CJK 缺字） */
async function waitForFontsReady(page, timeout = 12000) {
  await page.evaluate(async (ms) => {
    try {
      if (!document.fonts) return;
      await document.fonts.ready;
      const specs = new Set();
      let sample = "";
      document.querySelectorAll("*").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (!t) return;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none") return;
        specs.add(`${st.fontStyle} ${st.fontWeight} 16px ${st.fontFamily}`);
        if (sample.length < 200) sample += t;
      });
      const t0 = Date.now();
      for (const spec of Array.from(specs).slice(0, 40)) {
        if (Date.now() - t0 > ms) break;
        try { await document.fonts.load(spec, (sample || "测").slice(0, 60)); } catch (e) {}
      }
      await document.fonts.ready;
    } catch (e) {}
  }, timeout);
}

/** 用页面自身的 canvas 拼接触表：无 ffmpeg 依赖，且能顺便标注每个时间点 */
async function buildSheet(browser, items, times, out, cols) {
  const w = 480, h = 270, gap = 8, labelH = 26;
  const rows = Math.ceil(items.length / cols);
  const W = cols * (w + gap) + gap, H = rows * (h + labelH + gap) + gap;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // 注意：Playwright 的 page.evaluate 只转发第一个参数，参数必须打包成一个对象
  const payload = {
    opts: { W, H, w, h, gap, labelH, cols },
    imgs: items.map((p, i) => ({
      data: "data:image/png;base64," + fs.readFileSync(p).toString("base64"),
      label: times[i] + "ms",
    })),
  };
  await page.setContent("<!doctype html><meta charset='utf-8'><body style='margin:0;background:#101014'>" +
    "<canvas id='c'></canvas><script>window.__draw=(p)=>{" +
    "const o=p.opts,c=document.getElementById('c');c.width=o.W;c.height=o.H;const x=c.getContext('2d');" +
    "x.fillStyle='#101014';x.fillRect(0,0,o.W,o.H);" +
    "p.imgs.forEach((it,i)=>{const col=i%o.cols,row=Math.floor(i/o.cols);" +
    "const px=o.gap+col*(o.w+o.gap),py=o.gap+row*(o.h+o.labelH+o.gap);" +
    "const im=new Image();im.src=it.data;x.drawImage(im,px,py,o.w,o.h);" +
    "x.fillStyle='rgba(0,0,0,.72)';x.fillRect(px,py+o.h,o.w,o.labelH);" +
    "x.fillStyle='#8ef';x.font='600 15px monospace';x.textBaseline='middle';" +
    "x.fillText(it.label,px+8,py+o.h+o.labelH/2);});};</script>");
  await page.evaluate(async (p) => {
    await Promise.all(p.imgs.map((it) => new Promise((res) => {
      const im = new Image();
      im.onload = res; im.onerror = res; im.src = it.data;
    })));
    window.__draw(p);
  }, payload);
  const canvas = await page.$("#c");
  await canvas.screenshot({ path: out });
  await page.close();
  return out;
}

(async () => {
  if (!positional[0]) { console.error("用法: node probe.js <页面.html> <毫秒[,毫秒...]> [输出.png] [--sheet]"); process.exit(2); }
  const file = path.resolve(positional[0]);
  const times = String(positional[1] || "3000").split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  const outArg = positional[2] && !positional[2].startsWith("--") ? positional[2] : null;
  if (!times.length) { console.error("毫秒参数无效"); process.exit(2); }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: OPT.width, height: OPT.height } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(encodeURI("file:///" + file.replace(/\\/g, "/")) + "?noboot=1&nohud=1");
  await waitForFontsReady(page);

  const produced = [];
  for (const ms of times) {
    const cssCount = await page.evaluate((ms) => {
      if (!window.__probeFrozen) {
        const b = document.getElementById("boot");
        if (b) b.style.display = "none";
        window.__probeFrozen = true;
      }
      if (typeof window.__vtick !== "function") throw new Error("页面没有 __vtick，无法定格");
      window.__vtick(ms); window.__vtick(ms); window.__vtick(ms);
      // 与 render.js 同一套时间语义：CSS 过渡/关键帧动画用 Web Animations API seek 到同一毫秒。
      // 这比"把 transition-duration 置 0"更好——后者会让过渡中间态直接跳到终态，而中间态最容易穿帮。
      // 优先用页面自带的 __seekCss（按"本 cue 已流逝时间"seek，保留真实中间态）。
      if (typeof window.__seekCss === "function") return window.__seekCss(ms);
      const anims = document.getAnimations ? document.getAnimations() : [];
      let n = 0;
      for (const a of anims) {
        try {
          const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          if (timing && timing.iterations === Infinity) { a.cancel(); continue; }  // 无限动画无法定格，停用
          a.pause();
          a.currentTime = ms;   // 超出时长即落在终态
          n++;
        } catch (e) {}
      }
      return n;
    }, ms);
    if (cssCount) console.log("  (seek 了 " + cssCount + " 个 CSS 动画/过渡)");
    // 模板 API（on/tween/cnt/camTo）由虚拟时钟驱动，__vtick 已定格；这里等真实 rAF 循环
    // （自定义 requestAnimationFrame 计数器等）收敛到终态，保证同一毫秒多次截图一致。
    await page.waitForTimeout(OPT.settle);
    const out = (times.length === 1 && outArg)
      ? path.resolve(outArg)
      : path.join(path.dirname(file), "_frame_" + ms + "ms.png");
    await page.screenshot({ path: out });
    produced.push(out);
    console.log("frame ->", out);
  }

  if (FLAGS.sheet && produced.length) {
    const sheetOut = (times.length > 1 || !outArg)
      ? path.join(path.dirname(file), "_sheet.png")
      : path.resolve(outArg).replace(/\.png$/i, "") + "_sheet.png";
    try {
      console.log("sheet -> " + await buildSheet(browser, produced, times, sheetOut, OPT.cols));
    } catch (e) {
      console.log("接触表生成失败: " + (e && e.message ? e.message : e));
    }
  }

  await browser.close();
  console.log(errs.length ? "PAGEERROR: " + errs.join("; ") : "OK");
})().catch((e) => { console.error("失败: " + (e && e.message ? e.message : e)); process.exit(1); });
