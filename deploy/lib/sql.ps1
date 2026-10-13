# SQL: runs the numbered scripts at the repository root (01_schema.sql, ...) through sql.js.

function Get-SqlServerHost($Cfg) { "$($Cfg.Sql.ServerName).database.windows.net" }

# SqlReplace is for the numbered scripts only; a file run by Invoke-SqlFile uses tokens.
function Write-SqlVars($Cfg, [hashtable]$ExtraTokens, [switch]$NoReplace) {
    $tokens = [ordered]@{}
    foreach ($k in $Cfg.SqlTokens.Keys) { $tokens[$k] = $Cfg.SqlTokens[$k] }
    if ($ExtraTokens) { foreach ($k in $ExtraTokens.Keys) { $tokens[$k] = $ExtraTokens[$k] } }
    $replace = if ($NoReplace) { @{} } else { $Cfg.SqlReplace }
    $file = Join-Path $OutRoot "sql-vars-$($Cfg.Name).json"
    New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null
    Write-Utf8File $file (@{ tokens = $tokens; replace = $replace } | ConvertTo-Json -Depth 5)
    $file
}

# Runs sql.js and returns its output lines (also shown). When the server firewall
# blocks this machine, adds (or moves) one rule named deploy-<windows user> to the
# current IP and tries again.
function Invoke-SqlTool($Cfg, [string[]]$ToolArgs) {
    $tool = Join-Path $PSScriptRoot 'sql.js'
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $out = @(& { $ErrorActionPreference = 'Continue'; & node $tool @ToolArgs } | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        $ipLine = $out | Where-Object { $_ -like 'CLIENT_IP=*' } | Select-Object -First 1
        $out | Where-Object { $_ -notlike 'CLIENT_IP=*' } | ForEach-Object { Write-Note $_ }
        if ($code -eq 0) { return $out }
        if ($code -ne 3 -or -not $ipLine) { throw "SQL step failed (exit code $code); see the message above." }
        $ip = $ipLine.Substring(10)
        $rule = 'deploy-' + ($env:USERNAME -replace '[^A-Za-z0-9-]', '')
        Write-Note "Firewall of $($Cfg.Sql.ServerName) blocks $ip; setting rule $rule to it"
        Invoke-Az sql server firewall-rule create -g $Cfg.ResourceGroup -s $Cfg.Sql.ServerName -n $rule `
            --start-ip-address $ip --end-ip-address $ip -o none
        Start-Sleep -Seconds 20
    }
    throw "Still blocked by the firewall of $($Cfg.Sql.ServerName)"
}

function Deploy-Sql($Cfg, [switch]$Baseline) {
    $mode = if ($Baseline) { 'Record the existing SQL scripts as applied (nothing runs)' } else { 'Run new SQL scripts' }
    Write-Step "$mode on $($Cfg.Sql.ServerName)/$($Cfg.Sql.Database)"
    $toolArgs = @('migrate', (Get-SqlServerHost $Cfg), $Cfg.Sql.Database, $RepoRoot, (Write-SqlVars $Cfg))
    if ($Baseline) { $toolArgs += '--baseline' }
    Invoke-SqlTool $Cfg $toolArgs | Out-Null
}

function Invoke-SqlFile($Cfg, [string]$File, [hashtable]$ExtraTokens) {
    Write-Note "Running $(Split-Path $File -Leaf)"
    Invoke-SqlTool $Cfg @('run', (Get-SqlServerHost $Cfg), $Cfg.Sql.Database, $File, (Write-SqlVars $Cfg $ExtraTokens -NoReplace)) |
        Out-Null
}

# Wakes the environment's database and returns its number of user tables.
function Get-SqlTableCount($Cfg) {
    $line = Invoke-SqlTool $Cfg @('ping', (Get-SqlServerHost $Cfg), $Cfg.Sql.Database) | Where-Object { $_ -like 'TABLES=*' }
    [int]($line -replace 'TABLES=', '')
}

# Gives the environment's Function App user the permissions $SourceUser has in the source database.
function Copy-SqlGrants($Cfg, [string]$SourceServer, [string]$SourceDatabase, [string]$SourceUser) {
    Invoke-SqlTool $Cfg @('copy-grants', "$SourceServer.database.windows.net", $SourceDatabase, $SourceUser,
        (Get-SqlServerHost $Cfg), $Cfg.Sql.Database, $Cfg.SqlTokens.FUNC_APP) | Out-Null
}

# SqlPackage (Microsoft's database export/import tool), downloaded once into deploy/.out/tools.
function Get-SqlPackage {
    $dir = Join-Path $OutRoot 'tools\sqlpackage'
    $exe = Join-Path $dir 'SqlPackage.exe'
    if (Test-Path $exe) { return $exe }
    Write-Note 'Downloading SqlPackage from Microsoft (once, about 50 MB)'
    New-CleanDir $dir | Out-Null
    $zip = Join-Path $OutRoot 'tools\sqlpackage.zip'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri 'https://aka.ms/sqlpackage-windows' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    Remove-Item $zip -Force
    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        Remove-Item $dir -Recurse -Force
        throw "SqlPackage.exe is not validly signed by Microsoft ($($sig.Status)); deleted it."
    }
    $exe
}

# Copies schema and all table data from the source database into the (empty) target
# database. Users, logins, role memberships and permissions are left out: dev's users
# have dev's SIDs. The target's own user and grants are set up separately.
function Copy-SqlDatabase($Cfg, [string]$SourceServer, [string]$SourceDatabase) {
    $exe = Get-SqlPackage
    $dacpac = Join-Path $OutRoot "$SourceDatabase-data.dacpac"   # personal data; deleted below
    $token = Get-AccessToken 'https://database.windows.net/'
    $srcHost = "$SourceServer.database.windows.net"
    $dstHost = Get-SqlServerHost $Cfg
    $dstDb = $Cfg.Sql.Database
    try {
        Write-Note "Extracting $SourceServer/$SourceDatabase (schema and data)"
        & { $ErrorActionPreference = 'Continue'
            & $exe '/Action:Extract' "/SourceServerName:$srcHost" "/SourceDatabaseName:$SourceDatabase" `
                "/AccessToken:$token" "/TargetFile:$dacpac" '/p:ExtractAllTableData=true' '/p:VerifyExtraction=true' `
                '/p:IgnorePermissions=true' '/p:IgnoreUserLoginMappings=true' } | ForEach-Object { Write-Note "$_" }
        if ($LASTEXITCODE -ne 0) { throw "SqlPackage Extract failed (exit code $LASTEXITCODE)" }

        Write-Note "Publishing into $($Cfg.Sql.ServerName)/$dstDb"
        & { $ErrorActionPreference = 'Continue'
            & $exe '/Action:Publish' "/SourceFile:$dacpac" "/TargetServerName:$dstHost" "/TargetDatabaseName:$dstDb" `
                "/AccessToken:$token" '/p:CreateNewDatabase=false' '/p:ScriptDatabaseOptions=false' `
                '/p:ExcludeObjectTypes=Users;Logins;RoleMembership;Permissions' } | ForEach-Object { Write-Note "$_" }
        if ($LASTEXITCODE -ne 0) { throw "SqlPackage Publish failed (exit code $LASTEXITCODE)" }
    } finally { if (Test-Path $dacpac) { Remove-Item $dacpac -Force } }
}
