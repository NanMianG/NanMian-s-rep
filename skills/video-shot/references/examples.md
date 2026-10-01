# 成片样板库索引（外部链接 · 不随本 Skill 分发）

UP 主 UncleCheng-li 的完整成片实例公开在 GitHub，含三套共 41 镜头，按风格轮换零重复。**本 Skill 不打包这些文件**（其中含「安安 × 橘雪莉」版权立绘，与"去版权素材"定位冲突），仅作索引，需要对照时按页面号去仓库查。

- 仓库：<https://github.com/UncleCheng-li/AI_Animation>
- 技能目录：`skills/video-shot-demos/`
- 成片：`skills/video-shot-demos/assets/examples/`

| 实例 | 路径 | 规模 | 领域 |
|---|---|---|---|
| 第一辑 | `assets/examples/glm-5.3-range-test/` | 29 镜头 | 安全实测复盘（29 风格零重复，含播放器原始参考） |
| 第二辑 | `assets/examples/doubao-paper-detective/` | 11 镜头 | 论文阅读商单「论文侦探」 |
| 第三辑 | `assets/examples/uu-dsh/` | 1 镜头 | 拟真录屏「情景复现」样板（1:1 复刻软件界面） |

用法：想给某风格找参照，先在 `style-cards.md` 查到对应的 `UP 样板` 页号（如 `2-5`=嘉年华老虎机），再到仓库该实例目录里打开 `shot-2-5*.html` 对照。**只做局部抽查**：`grep` 定位后按行号读 ≤80 行，不要通读。

其它可参考文件：
- `skills/video-shot-demos/assets/template.html` —— 上游底盘（1920×1080，含角色吐槽系统）
- `skills/video-shot-demos/references/character-reactions.md` —— 双角色吐槽体系（本 Skill 未采用）
- `skills/video-shot-demos/scripts/shot.js` —— 上游确定性截帧质检脚本

## 本机网络实测（2026-10 实测，取资料时先看这段）

| 目标 | 状态 | 怎么用 |
|---|---|---|
| `api.github.com` | ✅ 通 | **首选**。`/repos/<o>/<r>/contents/<path>` 返回 base64 的 `content`，解出来就是原文 |
| `github.com` | ✅ 通（HTTP 200） | 浏览器页面可用；但页面被大量模板噪声干扰，不如 API |
| `codeload.github.com` | ✅ 通（301） | 可下 tarball |
| `raw.githubusercontent.com` | ❌ **ECONNRESET** | 别用，会直接失败 |
| `git clone/push https://github.com/...` | ❌ **连接被重置** | git 的 TLS 栈被重置，完全权限下也一样；推送只能在本机终端里手动做 |

取单个文件原文的可靠写法（Node，无需任何依赖）：

```bash
node -e "const h=require('https');h.get({host:'api.github.com',path:'/repos/OWNER/REPO/contents/PATH',headers:{'User-Agent':'x'}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(Buffer.from(JSON.parse(b).content,'base64').toString('utf8')))})"
```

**省 token**：别整篇拉大文件。先用目录接口列清单，再只取目标那一个文件；拿到后按行号读 ≤80 行做局部抽查。
