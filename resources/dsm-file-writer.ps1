# DSM UNLOCK 写入代理。
#
# 由 Electron 主进程通过白名单 PowerShell 启动：
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File dsm-file-writer.ps1
#
# 环境变量：
#   COPY_TARGET_DIR  目标目录（已存在）
#   COPY_FILE_NAME   最终文件名（本脚本不移动文件）
#   COPY_TEMP_NAME   目标目录内的临时文件名
#
# 协议：
#   - stdin：原始明文字节
#   - stdout：ASCII JSON {"bytes":N,"sha256":"..."}
#   - stderr：ASCII JSON {"code":"WRITE_FAILED","messageBase64":"..."}
#   - 退出码：0 成功，1 失败
#
# 本脚本只写临时文件并计算哈希；最终 rename 由 Node 在校验后完成，
# 不要在脚本中使用 Write-Output 输出其他内容。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Failure([string]$message) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
  $payload = '{"code":"WRITE_FAILED","messageBase64":"' + $encoded + '"}'
  try { [Console]::Error.WriteLine($payload) } catch { }
  exit 1
}

$targetDir = $env:COPY_TARGET_DIR
$fileName = $env:COPY_FILE_NAME
$tempName = $env:COPY_TEMP_NAME

if ([string]::IsNullOrEmpty($targetDir) -or
    [string]::IsNullOrEmpty($fileName) -or
    [string]::IsNullOrEmpty($tempName)) {
  Write-Failure '缺少写入参数'
}

$tempPath = [System.IO.Path]::Combine($targetDir, $tempName)
$stream = $null

try {
  # 使用 4 参数重载：Windows PowerShell 5.1 在部分 .NET 组合下无法绑定
  # 带 FileOptions 的 6 参数 Open 重载，会报“找不到 Open 的重载，参数计数为 6”。
  # 4 参数形式兼容性最好；FileStream 默认缓冲区足够配合下方的 64 KiB 读写循环。
  $stream = [System.IO.File]::Open(
    [string]$tempPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )

  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object -TypeName 'byte[]' -ArgumentList 65536
  [long]$total = 0

  while (($read = $stdin.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $stream.Write($buffer, 0, $read)
    $total += $read
  }

  $stream.Flush()
  $stream.Dispose()
  $stream = $null

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fileStream = [System.IO.File]::OpenRead($tempPath)
    try {
      $hashBytes = $sha.ComputeHash($fileStream)
    } finally {
      $fileStream.Dispose()
    }
  } finally {
    $sha.Dispose()
  }

  $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
  [Console]::Out.WriteLine('{"bytes":' + $total + ',"sha256":"' + $hash + '"}')
  exit 0
} catch {
  if ($null -ne $stream) {
    try { $stream.Dispose() } catch { }
  }
  if (Test-Path -LiteralPath $tempPath) {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
  Write-Failure $_.Exception.Message
}
