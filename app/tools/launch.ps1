# launch.ps1 - starts Nova IPTV's local server and opens it in your browser.
# Run it from START-NOVA-IPTV.bat (double-click), not directly.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

Say ''
Say '  Nova IPTV' 'Cyan'
Say '  ---------'
Say ''

# ---------- find Node.js ----------
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $root)
    $tails = @('nodejs\node.exe', 'nodejs\node.exe', 'Programs\nodejs\node.exe', 'node\node.exe')
    for ($i = 0; $i -lt $bases.Count; $i++) {
        $b = $bases[$i]
        if (-not $b) { continue }
        $p = Join-Path $b $tails[$i]
        if (Test-Path $p) { return $p }
    }
    return $null
}

$node = Find-Node

if (-not $node) {
    Say '  Node.js is not installed on this PC.' 'Yellow'
    Say '  Nova needs it only to run the local web server.'
    Say ''
    Say '  I can download a portable copy (about 30 MB) into this folder.'
    Say '  Nothing is installed system-wide and nothing outside this folder changes.'
    Say ''
    $answer = Read-Host '  Download it now? [Y/n]'
    if ($answer -and $answer.Trim().ToLower().StartsWith('n')) {
        Say ''
        Say '  No problem. Install Node.js from https://nodejs.org (LTS),' 'Yellow'
        Say '  then double-click START-NOVA-IPTV.bat again.' 'Yellow'
        Say ''
        Read-Host '  Press Enter to close'
        exit 1
    }

    try {
        Say ''
        Say '  Looking up the current Node.js LTS...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
        $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
        if (-not $lts) { throw 'Could not determine the current LTS release.' }

        $ver = $lts.version
        $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
        $url = "https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip"
        $zip = Join-Path $env:TEMP "node-$ver-win-$arch.zip"

        Say "  Downloading Node.js $ver ($arch)..."
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

        Say '  Unpacking...'
        $tmp = Join-Path $root '.node-tmp'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        $dest = Join-Path $root 'node'
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Move-Item $inner.FullName $dest
        Remove-Item $tmp -Recurse -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue

        $node = Join-Path $dest 'node.exe'
        if (-not (Test-Path $node)) { throw 'Node did not unpack as expected.' }
        Say '  Done.' 'Green'
        Say ''
    }
    catch {
        Say ''
        Say ("  Could not download Node.js: " + $_.Exception.Message) 'Red'
        Say '  Install it yourself from https://nodejs.org (LTS), then run this again.' 'Yellow'
        Say ''
        Read-Host '  Press Enter to close'
        exit 1
    }
}

# ---------- pick a free port ----------
$port = 8080
while ($port -lt 8100) {
    try {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
        $listener.Start(); $listener.Stop()
        break
    } catch { $port++ }
}

$url = "http://localhost:$port"

# ---------- open the browser once the server is up ----------
$opener = "for (`$i=0; `$i -lt 60; `$i++) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1',$port)).Close(); Start-Process '$url'; break } catch { Start-Sleep -Milliseconds 250 } }"
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $opener | Out-Null

Say "  Opening $url in your browser..." 'Green'

# ---------- run the server in this window ----------
& $node (Join-Path $root 'tools\dev-server.js') $port

Say ''
Say '  Server stopped.' 'Yellow'
Read-Host '  Press Enter to close'
