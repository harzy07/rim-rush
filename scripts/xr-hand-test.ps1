# Emulator smoke test: enter XR with hand tracking, pinch both rims to start,
# then push both hands forward several times and screenshot the result.
param([string]$Shot = 'C:\metavr\shot-xr.png')

function X([string]$action, [string]$json) {
  $esc = $json.Replace('"', '\"')
  $out = cmd /c "npx @iwsdk/cli xr $action --input-json `"$esc`" 2>&1" | Out-String
  if ($out -notmatch '"ok": true') { Write-Host "FAIL $action $json`n$out" } else { Write-Host "ok  $action" }
}

cmd /c "npx @iwsdk/cli browser reload > NUL 2>&1"
Start-Sleep 6
X 'enter' '{}'
Start-Sleep 2
# Look down at the virtual table where the arena is placed (0.6 m ahead, 0.55 m below the eyes).
X 'look-at' '{"device":"headset","target":{"x":0,"y":1.0,"z":-0.55}}'
Start-Sleep 1
X 'set-input-mode' '{"mode":"hand"}'
Start-Sleep 1
foreach ($s in @(@('hand-left', -0.2), @('hand-right', 0.2))) {
  X 'set-transform' ('{"device":"' + $s[0] + '","position":{"x":' + $s[1] + ',"y":1.25,"z":-0.15},"orientation":"auto","anchor":"grasp"}')
}
Start-Sleep 1
# Pinch both at once = start in two-rim mode
X 'set-device-state' '{"state":{"hands":{"left":{"pinchValue":1},"right":{"pinchValue":1}}}}'
Start-Sleep 1

for ($i = 0; $i -lt 3; $i++) {
  # push forward while pinched (right a little harder so it turns left)
  X 'animate-to' '{"device":"hand-left","position":{"x":-0.2,"y":1.25,"z":-0.30},"duration":0.4,"anchor":"grasp"}'
  X 'animate-to' '{"device":"hand-right","position":{"x":0.2,"y":1.25,"z":-0.33},"duration":0.4,"anchor":"grasp"}'
  Start-Sleep -Milliseconds 500
  # release and return
  X 'set-select-value' '{"device":"hand-left","value":0}'
  X 'set-select-value' '{"device":"hand-right","value":0}'
  X 'set-transform' '{"device":"hand-left","position":{"x":-0.2,"y":1.25,"z":-0.15},"orientation":"auto","anchor":"grasp"}'
  X 'set-transform' '{"device":"hand-right","position":{"x":0.2,"y":1.25,"z":-0.15},"orientation":"auto","anchor":"grasp"}'
  Start-Sleep -Milliseconds 200
  X 'set-select-value' '{"device":"hand-left","value":1}'
  X 'set-select-value' '{"device":"hand-right","value":1}'
}
X 'set-select-value' '{"device":"hand-left","value":0}'
X 'set-select-value' '{"device":"hand-right","value":0}'
cmd /c "npx @iwsdk/cli browser screenshot --output-file $Shot > NUL 2>&1"
Write-Host "screenshot: $Shot"
