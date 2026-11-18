# Desktop smoke test: reload, screenshot, drive with the keyboard, print debug logs.
param([string]$Steps = '{"steps":[{"action":"click","point":{"x":60,"y":420}},{"action":"press","key":"Space"},{"action":"keyDown","key":"ArrowUp"},{"action":"wait","durationMs":4000},{"action":"keyUp","key":"ArrowUp"},{"action":"keyDown","key":"ArrowRight"},{"action":"wait","durationMs":900}]}')
if (Test-Path $Steps) { $Steps = (Get-Content $Steps -Raw) -replace '\s+', ' ' }
function Invoke-Iw([string]$a) { cmd /c "npx @iwsdk/cli $a 2>&1" | Out-String }
Invoke-Iw 'browser reload' | Out-Null
Start-Sleep 8
Invoke-Iw 'browser screenshot --output-file C:\metavr\h0.png' | Out-Null
$esc = $Steps.Replace('"', '\"')
$r = Invoke-Iw "browser interact --input-json `"$esc`""
if ($r -notmatch '"ok": true') { Write-Host "interact failed: $r" }
Invoke-Iw 'browser screenshot --output-file C:\metavr\h1.png' | Out-Null
$logs = Invoke-Iw 'browser logs --input-json "{\"count\":40}"'
[regex]::Matches($logs, '"message": "(\[rr\][^"]*)') | Select-Object -Last 8 | ForEach-Object { $_.Groups[1].Value }
[regex]::Matches($logs, '"level": "error",\s*"message": "([^"]*)') | Select-Object -First 3 | ForEach-Object { 'ERROR: ' + $_.Groups[1].Value }
