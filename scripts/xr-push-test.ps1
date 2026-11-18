# Emulator test: both hands push the rims together (stepped), several strokes.
param([string]$Shot = 'C:\metavr\shot-push.png', [int]$Strokes = 4)

function X([string]$action, [string]$json) {
  $esc = $json.Replace('"', '\"')
  $out = cmd /c "npx @iwsdk/cli xr $action --input-json `"$esc`" 2>&1" | Out-String
  if ($out -notmatch '"ok": true') { Write-Host "FAIL $action $json`n$out" }
}
function Hands([double]$zl, [double]$zr, [double]$pinch) {
  X 'set-device-state' ('{"state":{"hands":{"left":{"position":{"x":-0.2,"y":1.22,"z":' + $zl + '},"pinchValue":' + $pinch + '},"right":{"position":{"x":0.2,"y":1.22,"z":' + $zr + '},"pinchValue":' + $pinch + '}}}}')
}

cmd /c "npx @iwsdk/cli browser reload > NUL 2>&1"
Start-Sleep 6
X 'enter' '{}'
Start-Sleep 2
X 'set-input-mode' '{"mode":"hand"}'
X 'look-at' '{"device":"headset","target":{"x":0,"y":1.2,"z":-3}}'
Hands -0.15 -0.15 0
Start-Sleep 1
Hands -0.15 -0.15 1   # both pinch = start two-rim mode
Start-Sleep 1
for ($s = 0; $s -lt $Strokes; $s++) {
  for ($k = 1; $k -le 6; $k++) { $z = -0.15 - 0.025 * $k; Hands $z $z 1 }
  Hands -0.30 -0.30 0     # let go
  Hands -0.15 -0.15 0     # bring hands back
  Hands -0.15 -0.15 1     # grab again
}
Hands -0.15 -0.15 0
cmd /c "npx @iwsdk/cli browser screenshot --output-file $Shot > NUL 2>&1"
Write-Host "screenshot: $Shot"
