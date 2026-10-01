// 用途：把镜头 HTML 渲染成 mp4（默认 1920×1080, 30fps）
// 用法：node render.js <页面.html | 镜头目录> [输出目录] [可选秒数] [选项]
//
// 两种渲染模式（默认 deterministic，即确定性逐帧）：
//   deterministic（默认）— __vtick(帧时刻) 逐帧定格 + page.screenshot 逐帧截图 + ffmpeg 编码
//        · 同输入必得同输出，掉帧不可能发生（不依赖机器负载与播放速度）
//        · 耗时 ≈ 帧数 × 单帧耗时，与视频时长无关
//   realtime（--realtime）— CDP Page.startScreencast 抓实时渲染帧，按 30fps 网格重采样
//        · 渲染耗时 ≈ 视频时长，长片有丢帧风险；作为确定性模式跑不通时的兜底
//
// 选项：
//   --realtime          用旧的实时抓帧模式
//   --fps=30            帧率（默认 30）
//   --scale=1           输出缩放（如 0.5 → 960×540），能显著加快编码
//   --quality=19        等价 --crf=19，libx264 的 CRF，越小越清晰（默认 19）
//   --keep-frames       编码成功后保留 _frames 临时目录
//   --settle=60         每帧定格后等待的毫秒数，保证样式/合成器落定（默认 60）
//   --width / --height  舞台尺寸（默认 1920×1080，需与页面 #stage 一致）
//
// 环境变量：FFMPEG_PATH 指向 ffmpeg 可执行文件；PLAYWRIGHT_HOME 指向含 playwright 的 node_modules 目录。
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// pop-video 工具依赖（playwright / ffmpeg-static）的实际安装位置。
// 整个目录搬迁时只改这一行；也可用 PLAYWRIGHT_HOME / FFMPEG_PATH 环境变量覆盖。
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
function findFFmpeg() {
  const cands = [
    process.env.FFMPEG_PATH,
    path.join(TOOLS_HOME, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  try { return require("ffmpeg-static"); } catch (_) {}
  throw new Error("未找到 ffmpeg。可设 FFMPEG_PATH 指向 ffmpeg 可执行文件。");
}

const { chromium } = loadPW();

/* ---------------- 参数解析 ---------------- */
const FLAGS = { realtime: false, keepFrames: false };
const OPT = { fps: 30, scale: 1, crf: 19, settle: 60, width: 1920, height: 1080 };
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a === "--realtime") FLAGS.realtime = true;
  else if (a === "--deterministic") FLAGS.realtime = false;
  else if (a === "--keep-frames") FLAGS.keepFrames = true;
  else if (/^--(fps|scale|quality|crf|settle|width|height)=/.test(a)) {
    const [k, v] = a.slice(2).split("=");
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) {
      if (k === "fps") OPT.fps = n;
      else if (k === "scale") OPT.scale = n;
      else if (k === "quality" || k === "crf") OPT.crf = n;
      else if (k === "settle") OPT.settle = n;
      else if (k === "width") OPT.width = n;
      else if (k === "height") OPT.height = n;
    }
  } else if (!a.startsWith("--")) positional.push(a);
}

const OUT_W = Math.round(OPT.width * OPT.scale);
const OUT_H = Math.round(OPT.height * OPT.scale);

function readDurationMs(html, fallbackSeconds) {
  const dur = (html.match(/const DUR = Number\(q\.get\("dur"\)\) \|\| (\d+)/) || [])[1];
  return dur ? parseInt(dur, 10) : Math.round((fallbackSeconds || 10.5) * 1000);
}

/** file:// URL；默认带 ?noboot=1 跳过启动遮罩，避免首帧拍到黑场（页面无该参数时无副作用） */
function fileUrl(file, extra) {
  const q = new URLSearchParams(extra || { noboot: "1", nohud: "1" });
  return encodeURI("file:///" + file.replace(/\\/g, "/")) + "?" + q.toString();
}

/** 等页面自身的字体与图片就绪 —— 缺了它首帧会拍到 fallback 字体/空图位。 */
async function waitForAssets(page, timeout = 15000) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.evaluate((ms) => new Promise((done) => {
    const pending = () => Array.from(document.images).filter((i) => !i.complete);
    const t0 = Date.now();
    (function poll() {
      if (!pending().length) return done(true);
      if (Date.now() - t0 > ms) return done(false);
      requestAnimationFrame(poll);
    })();
  }), timeout);
}

/** 冻结真实时钟并把页面摆到"演出开始"的姿势：隐藏启动遮罩、时间归零。 */
async function prepareStage(page) {
  await page.evaluate(() => {
    const b = document.getElementById("boot");
    if (b) b.style.display = "none";
    window.__now = 0;
    if (window.__vtick) { window.__vtick(0); window.__vtick(0); }
  });
}

function encode(outVideo, tmpDir) {
  const FFMPEG = findFFmpeg();
  return new Promise((res, rej) => {
    // 缩放放在解码后、编码前；libx264 要求宽高为偶数，故先取偶
    const vf = OPT.scale !== 1
      ? ["-vf", `scale=${OUT_W - (OUT_W % 2)}:${OUT_H - (OUT_H % 2)}:flags=lanczos`]
      : [];
    const args = ["-y", "-framerate", String(OPT.fps), "-i", path.join(tmpDir, "f%06d.jpg"),
      ...vf, "-c:v", "libx264", "-preset", "medium", "-crf", String(OPT.crf),
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", outVideo];
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "inherit"] });
    p.on("close", (code) => code === 0 ? res() : rej(new Error("ffmpeg exit " + code)));
    p.on("error", rej);
  });
}

/** 用 ffmpeg 反查产物，拿到真实时长与尺寸——比信任自己的算术更可靠 */
function probeOutput(video) {
  const FFMPEG = findFFmpeg();
  return new Promise((res) => {
    const p = spawn(FFMPEG, ["-i", video], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => err += d);
    // 有些受限环境不允许管道 stdio（spawn EPERM）；此时返回 null 而不是把整个渲染判失败
    p.on("error", () => res({ seconds: null, width: null, height: null }));
    p.on("close", () => {
      const dur = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/) || [];
      // 只认 Stream 行里 "数字x数字" 的那一处；宽泛匹配会命中 "avc1 / 0x31637661" 这类编解码器串
      const dim = err.match(/(\d{2,5})x(\d{2,5})[\s,\[]/) || [];
      res({
        seconds: dur.length ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : null,
        width: dim[1] ? +dim[1] : null,
        height: dim[2] ? +dim[2] : null,
      });
    });
  });
}

/* ---------------- 确定性逐帧（默认） ---------------- */
async function renderDeterministic(browser, file, outDirArg, seconds) {
  const outDir = outDirArg ? path.resolve(outDirArg) : path.dirname(file);
  const html = fs.readFileSync(file, "utf8");
  const totalMs = readDurationMs(html, seconds);
  const TOTAL = Math.max(1, Math.ceil(totalMs / 1000 * OPT.fps));
  const tmpDir = path.join(outDir, "_frames");
  const name = path.basename(file, ".html");
  const VIDEO = path.join(outDir, name + ".mp4");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: OPT.width, height: OPT.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(fileUrl(file));
  await waitForAssets(page);
  await prepareStage(page);

  const hasVtick = await page.evaluate(() => typeof window.__vtick === "function");
  if (!hasVtick) {
    await context.close();
    throw new Error(name + "：页面没有 __vtick，无法确定性渲染。请改用 --realtime（或让页面继承模板底盘）。");
  }

  const t0 = Date.now();
  let sawCssAnim = false;
  for (let i = 0; i < TOTAL; i++) {
    const ms = Math.round(i * 1000 / OPT.fps);
    const r = await page.evaluate((m) => {
      window.__vtick(m); window.__vtick(m); window.__vtick(m);
      // CSS 过渡/关键帧动画走真实时钟，__vtick 管不到它——必须单独把动画 seek 到同一时刻，
      // 否则同一毫秒在不同机器负载下会拍到不同的中间态（确定性就没了）。
      // 优先用页面自带的 __seekCss（它能按"本 cue 已流逝时间"seek，保留真实中间态）；
      // 老页面没有它时退回内联实现（按绝对时刻 seek）。
      if (typeof window.__seekCss === "function") return window.__seekCss(m) > 0;
      const anims = document.getAnimations ? document.getAnimations() : [];
      let css = false;
      for (const a of anims) {
        try {
          const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          if (timing && timing.iterations === Infinity) { a.cancel(); continue; }  // 无限动画无法定格，直接停用
          a.pause();
          a.currentTime = m;      // 超出时长即落在终态
          css = true;
        } catch (e) {}
      }
      return css;
    }, ms);
    if (r) sawCssAnim = true;
    if (OPT.settle > 0) await page.waitForTimeout(OPT.settle);
    await page.screenshot({
      path: path.join(tmpDir, "f" + String(i).padStart(6, "0") + ".jpg"),
      type: "jpeg",
      quality: 95,
    });
    if (i % 30 === 0 || i === TOTAL - 1) {
      process.stdout.write(`\r  ${name}: ${i + 1}/${TOTAL} 帧 (${((i + 1) / TOTAL * 100).toFixed(0)}%)   `);
    }
  }
  process.stdout.write("\n");
  await context.close();

  await encode(VIDEO, tmpDir);
  if (!FLAGS.keepFrames) fs.rmSync(tmpDir, { recursive: true, force: true });

  const info = await probeOutput(VIDEO);
  const kb = Math.round(fs.statSync(VIDEO).size / 1024);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`video -> ${VIDEO} (${kb}KB, ${TOTAL}f @${OPT.fps}fps, ` +
    `${info.width}×${info.height}, 时长 ${info.seconds ? info.seconds.toFixed(2) + "s" : "?"}, 渲染 ${secs}s)`);
  if (errors.length) console.log("  ⚠ 页面报错: " + errors.join(" | "));
  if (sawCssAnim) console.log("  ℹ 检测到 CSS 过渡/关键帧动画，已用 Web Animations API 逐帧 seek；无限动画已停用");
}

/* ---------------- 实时抓帧（兜底） ---------------- */
async function renderRealtime(browser, file, outDirArg, seconds) {
  const outDir = outDirArg ? path.resolve(outDirArg) : path.dirname(file);
  const html = fs.readFileSync(file, "utf8");
  const totalMs = readDurationMs(html, seconds);
  const TOTAL = Math.ceil(totalMs / 1000 * OPT.fps);
  const tmpDir = path.join(outDir, "_frames");
  const name = path.basename(file, ".html");
  const VIDEO = path.join(outDir, name + ".mp4");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const context = await browser.newContext({ viewport: { width: OPT.width, height: OPT.height } });
  const page = await context.newPage();
  page.on("pageerror", (e) => fs.writeFileSync(path.join(outDir, name + ".error.log"), String(e)));
  await page.goto(fileUrl(file));
  await waitForAssets(page);

  const cdp = await context.newCDPSession(page);
  const frames = [];
  let t0 = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const now = Date.now();
    if (!t0) t0 = now;
    frames.push({ t: now - t0, data: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });

  // 抖动泵：静止段也持续产帧，避免 screencast 空断
  await page.evaluate(() => {
    const dz = document.createElement("div");
    dz.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;background:rgba(0,0,0,.01);z-index:2147483647;pointer-events:none";
    document.body.appendChild(dz);
    let px = 0;
    (function pump() { px = px ? 0 : 1; dz.style.left = px + "px"; requestAnimationFrame(pump); })();
  });

  await page.evaluate(() => window.__startPlayback && window.__startPlayback());
  await page.waitForTimeout(totalMs + 500);
  await cdp.send("Page.stopScreencast").catch(() => {});
  await context.close();

  if (!frames.length) throw new Error(name + "：未捕获到任何帧");
  const pick = (target) => {
    let lo = 0, hi = frames.length - 1, best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (frames[mid].t <= target) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return frames[best].data;
  };
  for (let i = 0; i < TOTAL; i++) {
    fs.writeFileSync(path.join(tmpDir, "f" + String(i).padStart(6, "0") + ".jpg"),
      Buffer.from(pick(i * 1000 / OPT.fps), "base64"));
  }

  await encode(VIDEO, tmpDir);
  if (!FLAGS.keepFrames) fs.rmSync(tmpDir, { recursive: true, force: true });
  const info = await probeOutput(VIDEO);
  const kb = Math.round(fs.statSync(VIDEO).size / 1024);
  console.log(`video -> ${VIDEO} (${kb}KB, ${TOTAL}f @${OPT.fps}fps, ` +
    `${info.width}×${info.height}, 时长 ${info.seconds ? info.seconds.toFixed(2) + "s" : "?"}, 实时抓帧 ${frames.length} 帧)`);
}

/* ---------------- 入口 ---------------- */
(async () => {
  const target = path.resolve(positional[0] || ".");
  const outDirArg = positional[1];
  const seconds = parseFloat(positional[2] || "10.5");
  const mode = FLAGS.realtime ? "realtime" : "deterministic";
  const browser = await chromium.launch();
  try {
    const dir = fs.statSync(target).isDirectory();
    const files = dir
      ? fs.readdirSync(target).filter((f) => f.endsWith(".html") && f !== "index.html").sort().map((f) => path.join(target, f))
      : [target];
    if (!files.length) throw new Error("目录下没有 .html 镜头文件：" + target);
    if (dir) console.log(`${mode} 模式 · ${files.length} 个镜头 · ${OUT_W}×${OUT_H} @${OPT.fps}fps`);
    for (const f of files) {
      const out = dir ? (outDirArg || target) : outDirArg;
      if (mode === "deterministic") await renderDeterministic(browser, f, out, seconds);
      else await renderRealtime(browser, f, out, seconds);
    }
  } finally {
    await browser.close();
  }
})();
