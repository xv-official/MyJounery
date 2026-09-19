---
name: github-repo-loader
description: Fetch files, a subfolder, or a whole repo from a GitHub URL into the workspace via git, zip archive, or Contents API. Use when given a github.com link to 载入/拉取/下载/克隆 GitHub 仓库内容. Not for installing skills or git push/PR.
---

# GitHub 仓库内容载入

根据用户给出的 GitHub 地址，把仓库（或子目录、单文件）内容真实下载到本地工作区。
所有命令在 Windows PowerShell 5 环境执行。

## 铁律

1. **先探测、后下载**：永远不要假设默认分支是 `main`，不要硬编码 `raw.githubusercontent.com/<owner>/<repo>/main/<path>`。404 不代表文件不存在，只代表路径或分支假设错误。
2. **禁止编造内容**：任何通道失败都不得自行生成同名文件替代，必须换通道或向用户说明。
3. **落盘后必验证**：用 LS/Glob/Test-Path 确认目标文件确实存在，再汇报成功。
4. **token 安全**：私有库 token 只在当次命令的请求头中使用，禁止写入文件、日志、记忆，禁止回显。

## 1. 解析地址

从 URL 提取 `owner / repo / ref / path`：

| URL 形式 | 提取结果 |
|----------|----------|
| `https://github.com/{owner}/{repo}` | 整库，ref 待探测 |
| `https://github.com/{owner}/{repo}/tree/{ref}/{path}` | 子目录 |
| `https://github.com/{owner}/{repo}/blob/{ref}/{path}` | 单文件 |
| `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | 单文件直链 |
| 含 `#`、查询参数、gist 链接 | gist 不属于本流程；先剥离无用片段 |

同时确认用户意图：整库 / 只要某子目录 / 只要某单文件，以及落位目录。意图不明时只问这一个问题。

## 2. 探测仓库（ref 未知时必做）

GitHub API 必须带 `User-Agent` 头，否则 403：

```powershell
$headers = @{ 'User-Agent' = 'trae-skill'; 'Accept' = 'application/vnd.github+json' }
$repo = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/$repoName"
$ref = $repo.default_branch          # main / master / 其他
```

枚举目录、确认文件真实路径：

```powershell
$dir = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/$repoName/contents/$path?ref=$ref"
$dir | Select-Object name, type, download_url
```

- 未认证限额 60 次/小时，遇到 403 rate limit 时改用 git/zip 通道，或请用户提供 token（私有库同样需要）：
  `$headers.Authorization = 'Bearer <token>'`
- 老环境 TLS 报错时先执行：
  `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`

## 3. 选择下载通道

按场景选择，不要无脑全量 clone：

| 场景 | 通道 |
|------|------|
| 需要完整历史 / 用户明确说 clone | git clone |
| 只要代码快照、子目录或无 git 环境 | zip 归档（codeload） |
| 只要单个文件 | raw 直链 |

### 通道 A：git（本机已装 git）

整库浅克隆到临时目录，再把需要的内容复制进工作区（避免在工作区生成多余 `.git`）：

```powershell
git clone --depth 1 --branch $ref "https://github.com/$owner/$repoName.git" $tmp
```

只要子目录用 sparse checkout：

```powershell
git clone --depth 1 --filter=blob:none --sparse "https://github.com/$owner/$repoName.git" $tmp
git -C $tmp sparse-checkout set $path
```

私有库：让用户自行配置凭据管理器或使用带 token 的 https URL，不要把 token 写进记忆或文件。

### 通道 B：zip 归档（无 git 或仅需快照，首选 fallback）

```powershell
$zipUrl = "https://codeload.github.com/$owner/$repoName/zip/refs/heads/$ref"
# 标签用：https://codeload.github.com/$owner/$repoName/zip/refs/tags/$tag
Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'trae-skill' } -Uri $zipUrl -OutFile "$env:TEMP\repo.zip"
Expand-Archive -Path "$env:TEMP\repo.zip" -DestinationPath $staging -Force
```

注意：解压后顶层多一层 `{repoName}-{ref}` 目录，复制内容时要进入这一层，不要把它整体错放成目标目录。

### 通道 C：单文件 raw

ref 和路径已经过第 2 步确认后再下载：

```powershell
$raw = "https://raw.githubusercontent.com/$owner/$repoName/$ref/$path"
Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'trae-skill' } -Uri $raw -OutFile (Join-Path $targetDir $fileName)
```

## 4. 落位与防覆盖

- 默认落位：工作区下以仓库名命名的新子目录；用户指定了路径则按指定路径。
- 落位前先检查目标是否已存在同名文件/目录；存在冲突时停下告知，由用户决定覆盖、合并还是换目录。
- 用户没要求时，不复制 `.git/`；`.github/`、README、CI 配置等是否保留按用户意图判断。
- 临时 clone / zip / staging 目录在复制完成并验证后删除。

## 5. 错误处理

| 现象 | 处理 |
|------|------|
| raw 下载 404 | 回第 2 步用 Contents API 重新枚举分支与路径，不要判定"仓库没有此文件" |
| API 403 rate limit | 改 git/zip 通道，或请用户提供 token |
| `curl` 报参数错误 | PowerShell 的 curl 是 Invoke-WebRequest 别名，一律用 `Invoke-WebRequest -UseBasicParsing` 或 `Invoke-RestMethod` |
| TLS/连接错误 | 先设置 TLS 1.2；仍失败可重试一次或换通道 |
| 仓库不存在 / 是私有库 | 明确告知 404 或需要授权，请用户确认地址或提供凭据 |

## 边界

- **安装现成 skill**：走 skill-creator 的 Install 流程（枚举、暂存、校验、落到全局 skills 目录），本 skill 只负责"取内容"。
- **推送代码、commit、开 PR、issue**：使用 git 命令或 GitHub 插件能力，不在本 skill 范围。
- 本 skill 不执行从仓库下载下来的任何脚本，除非用户明确要求并自行承担风险。
