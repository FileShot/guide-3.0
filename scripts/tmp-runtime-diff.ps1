$ErrorActionPreference = 'Stop'

$serverMain = 'server/main.js'
$electronMain = 'electron-main.js'

$serverRoutes = Select-String -Path $serverMain -Pattern "app\.(get|post|put|delete|patch)\('([^']+)'" -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { "{0} {1}" -f $_.Groups[1].Value.ToUpper(), $_.Groups[2].Value } |
  Sort-Object -Unique

$electronRoutesEq = Select-String -Path $electronMain -Pattern "if \(p === '([^']+)' && method === '([A-Z]+)'\)" -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { "{0} {1}" -f $_.Groups[2].Value.ToUpper(), $_.Groups[1].Value } |
  Sort-Object -Unique

$electronRoutesPrefix = Select-String -Path $electronMain -Pattern "if \(p\.startsWith\('([^']+)'\).*method === '([A-Z]+)'\)" -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { "{0} {1}*" -f $_.Groups[2].Value.ToUpper(), $_.Groups[1].Value } |
  Sort-Object -Unique

$electronRoutes = ($electronRoutesEq + $electronRoutesPrefix) | Sort-Object -Unique

$serverRequires = Select-String -Path $serverMain -Pattern "require\(([^\)]*)\)" -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { $_.Groups[1].Value.Trim() } |
  Sort-Object -Unique

$electronRequires = Select-String -Path $electronMain -Pattern "require\(([^\)]*)\)" -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { $_.Groups[1].Value.Trim() } |
  Sort-Object -Unique

Write-Output "SERVER_ROUTE_COUNT=$($serverRoutes.Count)"
Write-Output "ELECTRON_ROUTE_COUNT=$($electronRoutes.Count)"
Write-Output "ONLY_SERVER_ROUTES_BEGIN"
Compare-Object -ReferenceObject $serverRoutes -DifferenceObject $electronRoutes -PassThru |
  Where-Object { $_ -in $serverRoutes } |
  Sort-Object
Write-Output "ONLY_SERVER_ROUTES_END"
Write-Output "ONLY_ELECTRON_ROUTES_BEGIN"
Compare-Object -ReferenceObject $electronRoutes -DifferenceObject $serverRoutes -PassThru |
  Where-Object { $_ -in $electronRoutes } |
  Sort-Object
Write-Output "ONLY_ELECTRON_ROUTES_END"

Write-Output "SERVER_REQUIRE_COUNT=$($serverRequires.Count)"
Write-Output "ELECTRON_REQUIRE_COUNT=$($electronRequires.Count)"
Write-Output "ONLY_SERVER_REQUIRES_BEGIN"
Compare-Object -ReferenceObject $serverRequires -DifferenceObject $electronRequires -PassThru |
  Where-Object { $_ -in $serverRequires } |
  Sort-Object
Write-Output "ONLY_SERVER_REQUIRES_END"
Write-Output "ONLY_ELECTRON_REQUIRES_BEGIN"
Compare-Object -ReferenceObject $electronRequires -DifferenceObject $serverRequires -PassThru |
  Where-Object { $_ -in $electronRequires } |
  Sort-Object
Write-Output "ONLY_ELECTRON_REQUIRES_END"
