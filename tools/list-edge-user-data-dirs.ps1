# 列出当前正在运行的浏览器进程各自的 --user-data-dir（一行一个，去重）。
# ⚠️ 读不到进程列表 = 这一族清理必须整轮停（见 tools/clean-e2e-profiles.js 的第一道闸），
#    因为「不知道哪台在跑」和「没有在跑」是两件事，后者才允许删。
$ErrorActionPreference = 'Stop'
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction Stop
} catch {
  exit 2
}
$dirs = @()
foreach ($p in $procs) {
  $cmd = $p.CommandLine
  if (-not $cmd) { continue }
  if ($cmd -match '--user-data-dir="?([^"\s]+)"?') {
    $dirs += $matches[1]
  }
}
$dirs | Sort-Object -Unique
