# Omitone —— 一键发布到 GitHub
#
# 用法（在本仓库目录下）：
#   powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1
#
# 为什么还需要你操作一次：
#   GitHub 的登录/授权必须由账号本人完成。脚本用的是浏览器 OAuth（device flow），
#   你只在弹出的浏览器里点一次「Authorize」即可 —— 密码和令牌都不会经过本脚本、
#   也不会经过任何其他人。
#
# ⚠️ 请把这句话记牢：
#   永远不要把 GitHub 密码或 Personal Access Token 发给任何人（包括 AI 助手、
#   群友、"技术支持"）。授权只走浏览器 OAuth 这一条路。

$ErrorActionPreference = "Stop"

# ---- 可配置项 -------------------------------------------------------------
$RepoName = "Omitone"          # 仓库名，想改就改这里
$Visibility = "--public"       # 想先私有再公开就改成 --private
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "== Omitone 发布助手 ==" -ForegroundColor Cyan
Write-Host ""

# 0. 前置检查
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "未检测到 GitHub CLI (gh)。" -ForegroundColor Red
    Write-Host "请先安装：winget install --id GitHub.cli  或从 https://cli.github.com 下载" -ForegroundColor Yellow
    exit 1
}

# 1. 发布前审查（密钥/个人信息是否误入）
Write-Host "[1/5] 发布前审查..." -ForegroundColor Cyan
node tools/publish-audit.js
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "审查发现了需要确认的内容，请先看清楚再决定是否继续。" -ForegroundColor Yellow
    $ans = Read-Host "仍要继续？(y/N)"
    if ($ans -ne "y") { exit 1 }
}

# 2. 登录（浏览器授权，唯一需要你动手的地方）
$who = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[2/5] 需要登录 GitHub —— 接下来浏览器会弹出，点一次 Authorize 即可" -ForegroundColor Cyan
    Write-Host "      （密码不会经过终端，也不会经过我）" -ForegroundColor DarkGray
    gh auth login -h github.com --web --git-protocol https
    if ($LASTEXITCODE -ne 0) {
        Write-Host "登录未完成，已中止。" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[2/5] 已登录，跳过" -ForegroundColor Green
}

$user = gh api user --jq .login
Write-Host "      当前账号：$user" -ForegroundColor DarkGray

# 3. 创建仓库并推送
Write-Host ""
Write-Host "[3/5] 创建仓库 $user/$RepoName 并推送..." -ForegroundColor Cyan
$exists = gh repo view "$user/$RepoName" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "      仓库已存在，改为推送到已有仓库" -ForegroundColor DarkGray
    git remote remove origin 2>$null
    git remote add origin "https://github.com/$user/$RepoName.git"
    git push -u origin master
} else {
    gh repo create $RepoName $Visibility --source=. --remote=origin --push
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "推送失败。" -ForegroundColor Red
    exit 1
}

# 4. 仓库信息（描述 / 主题）
Write-Host ""
Write-Host "[4/5] 填写仓库描述与主题..." -ForegroundColor Cyan
$desc = "学习通（超星）网页版的学习辅助浏览器扩展 —— 免费、公益、本地运行，AI 功能由使用者自行接入 API"
gh repo edit "$user/$RepoName" --description $desc --enable-issues --enable-wiki=false 2>$null
@(
    "chaoxing",
    "browser-extension",
    "学习通",
    "超星",
    "manifest-v3",
    "automation",
    "gpl-3.0"
) | ForEach-Object { gh repo edit "$user/$RepoName" --add-topic $_ 2>$null }

# 5. 完成
Write-Host ""
Write-Host "[5/5] 完成" -ForegroundColor Green
Write-Host ""
Write-Host "  仓库地址： https://github.com/$user/$RepoName" -ForegroundColor White
Write-Host "  设置页面： https://github.com/$user/$RepoName/settings" -ForegroundColor DarkGray
Write-Host ""
Write-Host "可选：在设置页上传一张 Social Preview 图（仓库主页的封面），" -ForegroundColor DarkGray
Write-Host "      图标在 icons/icon-128.png。" -ForegroundColor DarkGray
Write-Host ""
