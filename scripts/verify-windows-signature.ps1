param(
  [Parameter(Mandatory = $true)]
  [string[]] $Path,
  [string] $ExpectedThumbprint,
  [switch] $RequireTimestamp
)

$ErrorActionPreference = 'Stop'
foreach ($file in $Path) {
  $resolved = (Resolve-Path -LiteralPath $file).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode verification failed: $resolved ($($signature.Status)). Refusing to publish."
  }
  if ($ExpectedThumbprint -and $signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
    throw "Unexpected signing certificate: $resolved. Refusing to publish."
  }
  if ($RequireTimestamp -and -not $signature.TimeStamperCertificate) {
    throw "Missing signing timestamp: $resolved. Refusing to publish."
  }
  Write-Host "Verified signature: $resolved"
}
