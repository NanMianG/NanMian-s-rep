# 提交前钩子集合（secret-guard）

本目录是 `D:\dsh\.dsh\skills-backup` 的 git 钩子，随仓库版本化（`.git/hooks` 不上传，所以放在这里）。

## 装了什么

| 文件 | 作用 |
|---|---|
| `pre-commit` | 扫描**暂存区新增行**，命中疑似密钥就阻止提交 |
| `pre-push` | 推送前扫描 **HEAD 全部已跟踪文件**，兜住历史里已存在的密钥 |
| `secret_scan.py` | 扫描器本体（零外部依赖，只需 Python 3.11+） |
| `secret_scan.toml` | 白名单配置（可选，与 `secret_scan.py` 同目录） |

启用方式（本仓库已配好）：`git config core.hooksPath .githooks`

## 白名单怎么写

```toml
[allowlist]
paths   = ["*.example", "docs/**"]        # 路径通配，支持 * 与 **
regexes = ["AKIAIOSFODNN7EXAMPLE"]        # 值本身是文档示例，直接放过
rules   = ["url-with-credentials"]        # 关闭某条规则（按规则名）
```

规则名可跑 `python .githooks/secret_scan.py --staged` 从报错里看到，
或看 `secret_scan.py` 顶部的 `RULES` 列表。

**注意**：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 与记事本都会写入 BOM；
扫描器已按 `utf-8-sig` 读取，加 BOM 也能正常工作。

## 覆盖范围与取舍

覆盖：AWS、GCP 服务账号、Azure 存储密钥、OpenAI/Anthropic/DeepSeek/HuggingFace/Replicate、
GitHub（ghp/gho/ghu/ghs/ghr/github_pat）、GitLab、npm、PyPI、Slack、Stripe、Twilio、SendGrid、
Discord webhook、Telegram bot、私钥块、带密码的连接串、通用 `*_key/token/secret/password = ...`。

设计取舍：
- 只扫**新增行**，避免对历史行反复报警；
- 命中后**只输出脱敏值**，不把真实密钥再打印一遍进日志；
- 规则保守优先：偶尔漏掉冷门格式，也不频繁误报逼你去用 `--no-verify`；
- 扫描器自身异常时**放行并告警**，不会卡死你的提交。

## 更全面的扫描（可选）

本扫描器是"提交时拦截"，不做历史挖掘。想全量审计历史，建议另装
[gitleaks](https://github.com/gitleaks/gitleaks)：

```powershell
winget install gitleaks
gitleaks detect --log-opts="--all"     # 扫全历史
gitleaks protect --staged --redact     # 暂存区
```

## 手动使用

```powershell
python .githooks/secret_scan.py --staged     # 扫暂存区
python .githooks/secret_scan.py --all        # 扫 HEAD 全部文件
git commit --no-verify                       # 临时绕过（之后请补白名单）
```
