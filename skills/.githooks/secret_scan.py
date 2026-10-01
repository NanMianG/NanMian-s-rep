#!/usr/bin/env python3
"""提交前密钥扫描（零外部依赖）。

用法：
  python secret_scan.py --staged        # 扫描暂存区（pre-commit 用）
  python secret_scan.py --all           # 扫描 HEAD 全部已跟踪文件
  python secret_scan.py --staged --quiet

退出码：0 = 干净，1 = 发现疑似密钥（会阻止提交）。

配置：与本文件同级的 secret_scan.toml（可选）。支持：
  [allowlist]
  paths   = ["*.example", "docs/**"]      # 路径通配（支持 * 与 **）
  regexes = ["AKIAIOSFODNN7EXAMPLE"]      # 任何匹配此正则的值直接放过（给文档示例用）
  rules   = ["aws-key"]                   # 关闭某些规则（按规则名）

设计取舍：
- 只扫「新增行」，避免对历史行反复报警。
- 命中后只输出「规则名 + 文件:行号 + 脱敏值」，避免把真实密钥再打印一遍进日志。
- 规则刻意保守：宁可偶尔漏掉冷门格式，也不要频繁误报逼得你绕过钩子。
  更全面的扫描建议另配 gitleaks（见 README）。
"""
import argparse
import json
import os
import re
import subprocess
import sys

# ---------------------------------------------------------------- 检测规则
# 说明：value 部分用受限字符集 + 上界长度，避免灾难性回溯。
RULES = [
    # 云厂商
    ("aws-access-key-id", r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b"),
    ("aws-secret-access-key", r"(?i)aws[_-]?(?:secret[_-]?)?access[_-]?key\s*[:=]\s*[\"']?([A-Za-z0-9/+=]{40})\b"),
    ("gcp-service-account", r'"type"\s*:\s*"service_account"'),
    ("azure-storage-key", r"(?i)AccountKey\s*=\s*[A-Za-z0-9+/=]{40,200}"),
    # 模型 / AI 厂商
    ("anthropic-key", r"\bsk-ant-[A-Za-z0-9_\-]{20,120}"),
    ("openai-key", r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,120}"),
    ("deepseek-key", r"\bsk-[A-Za-z0-9]{32,80}\b"),
    ("huggingface-token", r"\bhf_[A-Za-z0-9]{20,60}"),
    ("replicate-token", r"\br8_[A-Za-z0-9]{20,60}"),
    # 代码托管 / CI
    ("github-pat", r"\bghp_[A-Za-z0-9]{36,60}\b"),
    ("github-oauth", r"\bgho_[A-Za-z0-9]{36,60}\b"),
    ("github-user-token", r"\bghu_[A-Za-z0-9]{36,60}\b"),
    ("github-app-token", r"\b(?:ghs|ghr)_[A-Za-z0-9]{36,60}\b"),
    ("github-fine-grained", r"\bgithub_pat_[A-Za-z0-9_]{50,120}"),
    ("gitlab-pat", r"\bglpat-[A-Za-z0-9_\-]{16,60}"),
    ("npm-token", r"\bnpm_[A-Za-z0-9]{30,60}\b"),
    ("pypi-token", r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{20,120}"),
    # 通信 / 支付
    ("slack-token", r"\bxox[abprs]-[A-Za-z0-9\-]{10,80}"),
    ("slack-webhook", r"https://hooks\.slack\.com/services/[A-Za-z0-9/_\-]{20,120}"),
    ("stripe-key", r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,80}\b"),
    ("twilio-key", r"\bSK[0-9a-fA-F]{32}\b"),
    ("sendgrid-key", r"\bSG\.[A-Za-z0-9_\-]{16,40}\.[A-Za-z0-9_\-]{30,60}"),
    ("discord-webhook", r"https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_\-]{30,120}"),
    ("telegram-bot-token", r"\b\d{8,12}:AA[A-Za-z0-9_\-]{30,40}\b"),
    # 私钥
    ("private-key-block", r"-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY(?:\s+BLOCK)?-----"),
    # 连接串里带密码
    ("url-with-credentials", r"(?i)\b[a-z][a-z0-9+.\-]{2,20}://[^\s:@/]{1,64}:([^\s:@/]{6,128})@[^\s/\"'<>\s]{3,200}"),
    # 通用赋值式（规则较宽，放在最后）
    ("generic-secret-assignment",
     r"(?i)\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|"
     r"private[_-]?key|passwd|password|passphrase|bearer)\b\s*[:=]\s*[\"']?([A-Za-z0-9_\-./+=]{16,200})"),
]

# 明显不是真实密钥的占位值（避免文档里的示例反复报警）
PLACEHOLDER = re.compile(
    r"(?i)(?:"
    r"your[_-]?\w*|my[_-]?\w*|placeholder|changeme|replace[_-]?me|redacted|"
    r"example|sample|dummy|fake|"
    r"\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|%[A-Za-z_]+%|\{\{[^}]*\}\}|"
    r"correcthorsebatterystaple|EXAMPLEKEY|XXXX+|"
    r"^\W*(?:todo|none|null|undefined)\W*$"
    r")"
)

DEFAULT_CONFIG = {
    "allowlist": {
        "paths": [
            "*.example",
            "*.sample",
            "*.template",
            ".env.example",
            "**/secret_scan.py",
            "**/secret_scan.toml",
            "**/node_modules/**",
            "**/*.lock",
            "**/package-lock.json",
            "**/pnpm-lock.yaml",
        ],
        "regexes": [],
        "rules": [],
    }
}


def load_config(script_dir):
    path = os.path.join(script_dir, "secret_scan.toml")
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝
    if not os.path.exists(path):
        return cfg
    try:
        import tomllib  # Python 3.11+
        # 用 utf-8-sig 读：PowerShell 5.1 的 Set-Content -Encoding UTF8 和记事本
        # 都会写入 BOM，普通 utf-8 解析会直接失败。
        with open(path, "r", encoding="utf-8-sig") as fh:
            user = tomllib.loads(fh.read())
        al = user.get("allowlist", {})
        for key in ("paths", "regexes", "rules"):
            if isinstance(al.get(key), list):
                if key == "paths":
                    cfg["allowlist"]["paths"].extend(al[key])
                else:
                    cfg["allowlist"][key] = list(al[key])
    except Exception as exc:  # 配置坏了不能让钩子静默失守
        print(f"[secret-scan] 警告：无法解析 {path}（{exc}），改用默认配置", file=sys.stderr)
    return cfg


def path_allowed(path, patterns):
    import fnmatch
    p = path.replace("\\", "/")
    for pat in patterns:
        pat = pat.replace("\\", "/")
        if fnmatch.fnmatch(p, pat):
            return True
        # "**/" 与 fnmatch 配合不完美，补两种常见形态
        if pat.startswith("**/") and fnmatch.fnmatch(p, pat[3:]):
            return True
        if fnmatch.fnmatch(os.path.basename(p), pat):
            return True
    return False


def is_placeholder(value):
    """判断是否为占位/示例值。

    注意：不能锚定行首 —— AWS 官方文档示例键是 AKIAIOSFODNN7EXAMPLE，
    以 AKIA 开头，必须允许"标记出现在串内"。标记词选得足够具体，避免误放真实密钥。
    """
    v = value.strip("'\"")
    if not v or len(v) < 8:
        return True
    if PLACEHOLDER.search(v):
        return True
    # 代码里读环境变量的写法，不是密钥本身
    if re.search(r"(?i)process\.env|os\.environ|getenv|import\.meta\.env|\$\{?[A-Z_]+\}?", v):
        return True
    return False


def redact(value):
    v = value.strip("'\"")
    if len(v) <= 8:
        return "*" * len(v)
    return f"{v[:4]}{'*' * 6}{v[-2:]}（{len(v)} 字符，已脱敏）"


def run_git(args, cwd):
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def iter_staged(repo):
    """产出 (路径, 文本, 行号起始偏移基准)。只取新增行。"""
    diff = run_git(["diff", "--cached", "--unified=0", "--no-color", "--diff-filter=ACMR"], repo)
    if diff.returncode != 0:
        return
    cur = None
    new_ln = 0
    buf = {}      # path -> list[(lineno, text)]
    for line in diff.stdout.splitlines():
        if line.startswith("+++ b/"):
            cur = line[6:]
            buf.setdefault(cur, [])
        elif line.startswith("@@"):
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            new_ln = int(m.group(1)) if m else 0
        elif line.startswith("+") and not line.startswith("+++"):
            if cur:
                buf[cur].append((new_ln, line[1:]))
            new_ln += 1
        elif line.startswith("-") and not line.startswith("---"):
            pass
        else:
            new_ln += 1
    for path, entries in buf.items():
        yield path, entries


def iter_all(repo):
    ls = run_git(["ls-files", "-z"], repo)
    if ls.returncode != 0:
        return
    for path in [p for p in ls.stdout.split("\0") if p]:
        show = run_git(["show", f"HEAD:{path}"], repo)
        if show.returncode != 0:
            continue
        yield path, [(i + 1, l) for i, l in enumerate(show.stdout.splitlines())]


def scan(repo, staged, cfg, quiet):
    allowed_paths = cfg["allowlist"]["paths"]
    allow_regexes = [re.compile(r) for r in cfg["allowlist"]["regexes"] if r]
    disabled = set(cfg["allowlist"]["rules"])
    findings = []
    scanned = 0

    source = iter_staged(repo) if staged else iter_all(repo)
    for path, entries in source:
        if path_allowed(path, allowed_paths):
            continue
        scanned += 1
        for lineno, text in entries:
            if not text or len(text) > 4000:
                continue
            for rule, pattern in RULES:
                if rule in disabled:
                    continue
                for m in re.finditer(pattern, text):
                    value = m.group(1) if m.groups() else m.group(0)
                    if any(r.search(value) for r in allow_regexes):
                        continue
                    if rule == "generic-secret-assignment" and is_placeholder(value):
                        continue
                    if rule != "generic-secret-assignment" and is_placeholder(value):
                        continue
                    # 排除纯十六进制短串等噪声（generic 规则已限长，这里再挡一次）
                    if rule == "generic-secret-assignment" and len(set(value)) <= 3:
                        continue
                    findings.append((rule, path, lineno, value))

    if not quiet:
        mode = "暂存区" if staged else "HEAD 全部文件"
        print(f"[secret-scan] 已扫描 {scanned} 个文件（{mode}）")

    if not findings:
        return 0

    print("", file=sys.stderr)
    print("[secret-scan] ✖ 发现疑似密钥，已阻止本次提交：", file=sys.stderr)
    seen = set()
    for rule, path, lineno, value in findings:
        key = (rule, path, lineno)
        if key in seen:
            continue
        seen.add(key)
        print(f"  · {rule}  {path}:{lineno}  {redact(value)}", file=sys.stderr)
    print("", file=sys.stderr)
    print("  处理办法：", file=sys.stderr)
    print("   1) 把密钥移到环境变量或本机 $DSH_HOME/.env（并确保 .env 已被忽略）", file=sys.stderr)
    print("   2) 确实只是文档示例 → 在 secret_scan.toml 的 allowlist.regexes 加该值，", file=sys.stderr)
    print("      或把整个文件加进 allowlist.paths（支持 *.example、docs/** 这类通配）", file=sys.stderr)
    print("   3) 确认误报 → 用 git commit --no-verify 临时绕过（之后请补白名单）", file=sys.stderr)
    print("   4) 若该密钥已经提交过：立刻在服务端吊销并轮换，清理历史（改代码没用）", file=sys.stderr)
    print("", file=sys.stderr)
    return 1


def main():
    # Windows 控制台默认可能是 GBK，中文与符号会炸；显式转 UTF-8 容错
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="提交前密钥扫描")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--staged", action="store_true", help="扫描暂存区（pre-commit）")
    g.add_argument("--all", action="store_true", help="扫描 HEAD 全部已跟踪文件")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--repo", default=None, help="仓库路径，默认取当前目录")
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    cfg = load_config(script_dir)
    repo = args.repo or os.getcwd()

    try:
        return scan(repo, args.staged, cfg, args.quiet)
    except Exception as exc:
        # 钩子自身出错时宁可放行也不要卡死提交，但必须显式告警
        print(f"[secret-scan] 警告：扫描器异常（{exc}），本次未拦截", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
