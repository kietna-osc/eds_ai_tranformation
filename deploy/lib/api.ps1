# Function App (api/): build a Linux package and zip-deploy it.

# Builds deploy/.out/api.zip from api/. Dependencies are installed for Linux x64
# even on Windows: sharp ships a native binary per platform, and a Windows build
# of it cannot load on the Linux Function App. The zip is written with tar.exe,
# which uses "/" separators (Compress-Archive writes "\", which Linux cannot read).
function Build-ApiPackage {
    Write-Step 'Build the Function App package (Linux x64)'
    $stage = New-CleanDir (Join-Path $OutRoot 'api-build')
    $api = Join-Path $RepoRoot 'api'
    foreach ($f in 'package.json', 'package-lock.json', 'host.json') { Copy-Item (Join-Path $api $f) $stage }
    Copy-Item (Join-Path $api 'src') (Join-Path $stage 'src') -Recurse

    Push-Location $stage
    try {
        & { $ErrorActionPreference = 'Continue'; & npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund } |
            ForEach-Object { Write-Note $_ }
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
    if (-not (Test-Path (Join-Path $stage 'node_modules\@img\sharp-linux-x64'))) {
        throw 'The Linux build of sharp (@img/sharp-linux-x64) was not installed. Check that npm is version 10 or later.'
    }

    $zip = Join-Path $OutRoot 'api.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force }
    & { $ErrorActionPreference = 'Continue'; & "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C $stage package.json host.json src node_modules } |
        Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit code $LASTEXITCODE)" }
    Write-Note ("Built {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
    $zip
}

function Deploy-Api($Cfg, [string]$Zip) {
    $app = $Cfg.FunctionApp.Name
    Write-Step "Deploy the package to $app"
    Invoke-Az functionapp deployment source config-zip -g $Cfg.ResourceGroup -n $app --src $Zip --timeout 600 -o none

    # On Linux Consumption the function list stays empty until triggers are synced,
    # even though the deployment itself succeeded.
    $site = "$(Get-ResourceGroupPath $Cfg)/providers/Microsoft.Web/sites/$app"
    Invoke-Arm POST "$site/syncfunctiontriggers?api-version=2023-12-01" | Out-Null

    # The app indexes its functions on start; an empty list means it failed to load src/index.js.
    $count = 0
    for ($i = 1; $i -le 12 -and $count -eq 0; $i++) {
        Start-Sleep -Seconds 10
        $count = @(Invoke-Az functionapp function list -g $Cfg.ResourceGroup -n $app --query '[].name' -o tsv).Count
    }
    if ($count -eq 0) { throw "$app reports no functions after deployment. Check its logs in Application Insights." }
    Write-Note "$app is running $count functions"
}
