// 用途：估算文案的中文口播时长（中文≈4.5字/秒），辅助切镜头
// 用法：node pace.js <文案文件> [字每秒]
const fs = require("fs");
const file = process.argv[2];
const rate = parseFloat(process.argv[3] || "4.5");
const text = fs.readFileSync(file, "utf8");
const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
const words = text.replace(/[\u4e00-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
const total = cjk + words;
const sec = total / rate;
console.log("中文字符:", cjk, " 其他词:", words, " 合计:", total);
console.log("按", rate, "字/秒 → 约", Math.round(sec), "秒 (" + (sec / 60).toFixed(1) + " 分钟)");
console.log("建议镜头数(8–15s/镜):", Math.max(1, Math.round(sec / 11)));
