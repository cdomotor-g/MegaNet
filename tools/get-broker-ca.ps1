<#
    get-broker-ca.ps1 — Pull the CA certificate a device needs to trust an MQTT
    broker, on a plain Windows machine with nothing installed.

    Why this exists
    ───────────────
    An ELPRO 115E-2 (and most industrial gateways) will not open a TLS
    connection until it has been given the CA certificate that signed the
    broker's certificate. Getting that file is normally a one-line `openssl
    s_client` job — which is fine on Linux and macOS and useless on the Windows
    laptop the technician is actually sitting at.

    PowerShell can do the same thing with no installs: open the socket, do the
    TLS handshake, ask Windows to build the certificate chain, and write the
    root out as PEM. Every piece of that is in the .NET base class library and
    has been since forever.

    What it writes, into the folder you run it from:
      <host>-ca-root.crt   the ROOT certificate, PEM. Try this one first.
      <host>-ca-chain.crt  root + intermediates, PEM. Try this if the root alone
                           is refused — some devices want the whole chain.

    Usage
    ─────
      powershell -ExecutionPolicy Bypass -File .\get-broker-ca.ps1 `
          -BrokerHost your-cluster.s1.eu.hivemq.cloud

      # non-standard port:
      ... -BrokerHost host.example -Port 8883

    Note: it connects to the real broker on the real port. If this script cannot
    reach it, **the gateway will not be able to either** — which is a useful
    thing to have found out from a desk rather than from site.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $BrokerHost,

    [int] $Port = 8883,

    [int] $TimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'

function Write-Pem {
    param(
        [Security.Cryptography.X509Certificates.X509Certificate2[]] $Certificates,
        [string] $Path
    )
    $sb = New-Object Text.StringBuilder
    foreach ($c in $Certificates) {
        [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
        [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))
        [void]$sb.AppendLine('-----END CERTIFICATE-----')
    }
    # ASCII, LF-free trailing junk avoided: devices are fussy about PEM.
    Set-Content -Path $Path -Value $sb.ToString().TrimEnd() -Encoding ascii
}

Write-Host ""
Write-Host "Connecting to $BrokerHost`:$Port ..." -ForegroundColor Cyan

$tcp = New-Object Net.Sockets.TcpClient
try {
    $async = $tcp.BeginConnect($BrokerHost, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
        throw "timed out after $TimeoutSeconds seconds"
    }
    $tcp.EndConnect($async)
} catch {
    Write-Host ""
    Write-Host "COULD NOT CONNECT: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "That is worth knowing on its own. If this machine cannot reach"
    Write-Host "$BrokerHost on port $Port, the 115E-2 on the same network will not"
    Write-Host "be able to either — check the firewall allows outbound TCP $Port"
    Write-Host "before blaming the device."
    exit 1
}

try {
    # Accept whatever is presented: we are INSPECTING the certificate, not
    # trusting it. Validating here would defeat the purpose — the whole reason
    # we are here is that nobody has the CA yet.
    $callback = [Net.Security.RemoteCertificateValidationCallback] { param($sn, $c, $ch, $e) $true }
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, $callback)

    # TLS 1.2 explicitly: older PowerShell defaults can still negotiate 1.0,
    # which some brokers have turned off entirely.
    $ssl.AuthenticateAsClient(
        $BrokerHost,
        $null,
        [Security.Authentication.SslProtocols]::Tls12,
        $false)

    $leaf = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)

    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = 'NoCheck'
    $built = $chain.Build($leaf)

    Write-Host ""
    Write-Host "Certificate chain:" -ForegroundColor Cyan
    for ($i = 0; $i -lt $chain.ChainElements.Count; $i++) {
        $c = $chain.ChainElements[$i].Certificate
        $label = if ($i -eq 0) { 'server ' }
                 elseif ($i -eq $chain.ChainElements.Count - 1) { 'ROOT   ' }
                 else { 'interm.' }
        Write-Host ("  [$label] " + $c.Subject)
    }

    if (-not $built) {
        Write-Host ""
        Write-Host "NOTE: Windows could not fully validate this chain." -ForegroundColor Yellow
        Write-Host "The files are still written and are still usable, but check the"
        Write-Host "root below looks like a real public CA before sending it on."
        foreach ($s in $chain.ChainStatus) { Write-Host ("  " + $s.StatusInformation.Trim()) -ForegroundColor Yellow }
    }

    $all  = @($chain.ChainElements | ForEach-Object { $_.Certificate })
    $root = $all[$all.Count - 1]

    $safe      = $BrokerHost -replace '[^A-Za-z0-9\.\-]', '_'
    $rootPath  = Join-Path (Get-Location) "$safe-ca-root.crt"
    $chainPath = Join-Path (Get-Location) "$safe-ca-chain.crt"

    Write-Pem -Certificates @($root) -Path $rootPath
    # Root + intermediates, leaf excluded: the leaf is the broker's own
    # certificate and is never what a device is asked to trust.
    if ($all.Count -gt 1) {
        Write-Pem -Certificates ($all[1..($all.Count - 1)]) -Path $chainPath
    }

    Write-Host ""
    Write-Host "Root CA is:" -ForegroundColor Green
    Write-Host ("  Subject : " + $root.Subject)
    Write-Host ("  Issuer  : " + $root.Issuer)
    Write-Host ("  Expires : " + $root.NotAfter.ToString('yyyy-MM-dd'))
    Write-Host ""
    Write-Host "Written:" -ForegroundColor Green
    Write-Host "  $rootPath      <-- send this one first"
    if ($all.Count -gt 1) { Write-Host "  $chainPath     <-- only if the root alone is refused" }
    Write-Host ""
    Write-Host "Both are PUBLIC certificates. Neither contains a private key, and"
    Write-Host "neither is a secret — they are safe to email."
    Write-Host ""
}
finally {
    if ($ssl) { $ssl.Dispose() }
    $tcp.Close()
}
