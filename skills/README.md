# video-shot / shotplan skills 备份

从 opencode 迁移到 DSH 的两个 skill，并做 Remotion 借鉴后的升级。

## 内容

- `video-shot/` — 每镜头一个 HTML 的演示动画 skill（含确定性渲染管线）
- `shotplan/` — 文案 → video-shot 分镜提示词
- `.githooks/` — 提交/推送前的密钥扫描（见下）

## 来源与去向

| | 位置 |
|---|---|
| 原始版本（迁移前） | `D:\OpenCode\config\opencode\skills\` |
| DSH 使用中 | `D:\dsh\.dsh\skills\` |
| 本地备份仓（本目录） | `D:\dsh\.dsh\skills-backup\` |
| GitHub 备份 | `NanMianG/NanMian-s-rep` → `skills/`（分支 `main`） |
| 扫描器主副本 | `D:\dsh\.dsh\secret-guard\` |

本地 git 历史保留三个阶段，随时可 diff：
`d081d37`(原始态) → `79ea070`(升级) → `5b7924a`(确定性修复)。

## 密钥防护（secret-guard）

已启用 `git config core.hooksPath .githooks`：

| 钩子 | 作用 |
|---|---|
| `pre-commit` | 扫**暂存区新增行**，命中疑似密钥就阻止提交 |
| `pre-push` | 推送前扫 **HEAD 全部已跟踪文件**，兜住历史里已存在的密钥 |
| `secret_scan.py` | 扫描器本体，零外部依赖（只需 Python 3.11+） |

白名单放在 `.githooks/secret_scan.toml`（可选）：

```toml
[allowlist]
paths   = ["*.example", "docs/**"]
regexes = ["AKIAIOSFODNN7EXAMPLE"]
rules   = ["url-with-credentials"]
```

已验证行为：真实形态密钥被拦截；`your_api_key_here`、`AKIAIOSFODNN7EXAMPLE`、
`process.env.X`、`correcthorsebatterystaple` 等占位/环境变量写法放行；
`paths` / `regexes` / `rules` 三种白名单各自生效；撤掉白名单后恢复拦截。

**注意**：本机 Git Bash（MSYS2）在 DSH 沙箱内无法启动（命名对象被禁），
所以沙箱内的 `git commit` 会因钩子报 MSYS 错误而失败。普通终端里 git 与钩子都正常；
沙箱内如需提交可加 `--no-verify`。

## 本机网络环境的两个坑（重要）

### 1. SteamTools / Watt Toolkit 在改 hosts 并做 HTTPS 中间人

你的 `C:\Windows\System32\drivers\etc\hosts` 里有 `# Steam++ Start … # Steam++ End` 一段，
把 GitHub 相关域名全部指向 `127.0.0.1`：

```
127.0.0.1 github.com
127.0.0.1 api.github.com
127.0.0.1 raw.githubusercontent.com
...
```

本地代理用它自己的根证书（`O=BeyondDimension, CN=SteamTools Certificate`）做 MITM，
该证书已装进机器与用户的「受信任的根证书颁发机构」。

**这解释了几个一直很怪的现象**：

| 现象 | 原因 |
|---|---|
| `git clone/push https://github.com/...` 连接被重置 | 流量被本机代理接管 |
| `raw.githubusercontent.com` 一律 ECONNRESET | 同上，且该域被指向本机 |
| Node 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 叶子证书由 SteamTools 的 CA 签发 |

想恢复正常直连：在 SteamTools「网络加速」里**关掉 GitHub 加速**（或退出该程序），
hosts 里那段 `# Steam++` 条目通常也会随之移除。

### 2. 若保留 SteamTools 加速，Node 需要额外信任它的 CA

不改系统信任区，只在本次进程里加：

```powershell
# 导出它的 CA（我已导出到 D:\dsh\.dsh\steamtools-ca.pem）
$env:NODE_EXTRA_CA_CERTS = 'D:\dsh\.dsh\steamtools-ca.pem'
```

**取舍**：这样做等于让 SteamTools 的本地代理看到你的 GitHub 凭据。
若介意凭据经过第三方进程，就按上面第 1 条关掉它的 GitHub 加速再推送。

## GitHub 同步

- 已同步：远端 commit `9d14c5e53e27` — `skills/video-shot/`、`skills/shotplan/` 共 11 个文件，
  逐字节核对一致。
- **未同步**：本次新增的 `.githooks/`（密钥防护）。
  原因：原先可用的 `gho_` 凭据已被撤销，`/user` 与 `/repos` 均返回 401。
  等你有可用凭据后再跑一次 `D:\dsh\.dsh\gh-push.js` 即可补上。

### 为什么用 API 推送而不是 git push

本机 **git 的 TLS 栈连 `github.com` 被重置**（罪魁是上面第 1 条，不是网络故障）。
改用 GitHub REST API：`POST /git/blobs` → `POST /git/trees`(带 `base_tree`) →
`POST /git/commits` → `PATCH /git/refs/heads/main`。
`base_tree` 保证不会覆盖仓库里已有的其它文件。

脚本：`D:\dsh\.dsh\gh-push.js`（自动从 Windows 凭据管理器取凭据，不打印 token）。
保留 SteamTools 加速时记得先设 `NODE_EXTRA_CA_CERTS`。

## 升级要点（相对原始版本）

1. **确定性逐帧渲染**（`render.js` 默认模式）：`__vtick` 定格 + 逐帧截图，替代 CDP 实时抓帧。
   与视频时长解耦、不可能丢帧；实测同镜头连渲两次 mp4 的 SHA256 完全一致。
2. **CSS 过渡/关键帧的确定性**：用 Web Animations API 按「本 cue 已流逝时间」seek
   （`template.html` 内置 `window.__seekCss`）。修复前 CSS 过渡会让渲染结果不可复现。
3. **字体就绪断言**：按页面实际使用的字重/字族逐个 `fonts.load()`，防 fallback 字体与 CJK 缺字。
4. **接触表质检**（`probe.js --sheet`）：一屏总览所有时间点，用页面自身 canvas 拼接，不依赖 ffmpeg。
5. **动效与节奏规则**：每镜一个动效概念 + 情绪单向推进 + 主揭晓留驻 0.5–1.0s；
   分镜表新增「动效落点（留驻）」列。
6. **修掉的缺陷**：模板首帧拍到启动遮罩（时钟与淡出未对齐）、HUD 冻结在 `00:00` 被拍进成片、
   产物尺寸解析误匹配编解码器串、`page.evaluate` 多参数丢失、
   `mechanics.md` 中"劫持 `performance.now`"的错误文档。
