// 用途：打印模板"改这里"标记区域的行号地图，供 AI 只读标记区而非通读全文件
// 用法：node markmap.js <页面.html>
const fs = require("fs");
const path = require("path");

const file = path.resolve(process.argv[2] || "assets/template.html");
const lines = fs.readFileSync(file, "utf8").split("\n");
const marks = [];
lines.forEach((l, i) => {
  const m = l.match(/改这里|const DUR/);
  if (m) marks.push({ ln: i + 1, text: l.trim().slice(0, 70) });
});
console.log("行号地图: " + file);
for (const m of marks) console.log("  " + m.ln + " | " + m.text);