# Shared helpers for deploy-dev.ps1, deploy-test.ps1 and setup-test.ps1.
# Written for Windows PowerShell 5.1. Nothing here stores a secret: every call
# uses the signed-in `az login` / `pac auth` account.

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$OutRoot  = Join-Path $RepoRoot 'deploy\.out'   # git-ignored; build outputs and temporary files

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" }
function Write-Warn([string]$Message) { Write-Host "    WARNING: $Message" -ForegroundColor Yellow }

# Native tools print warnings on stderr. When output is redirected (e.g. *>&1),
# Windows PowerShell 5.1 turns each stderr line into an error record, which
# $ErrorActionPreference = 'Stop' makes fatal. The wrappers below therefore use
# 'Continue' locally and judge success by the exit code alone.

# Runs az and throws when it fails. Only the first two arguments go into the
# error message so a secret passed later on the command line is never printed.
function Invoke-Az {
    $ErrorActionPreference = 'Continue'
    $out = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit code $LASTEXITCODE)" }
    $out | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }
}

# Same as Invoke-Az, for a command that prints a single value (-o tsv).
function Get-AzValue {
    $ErrorActionPreference = 'Continue'
    $out = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit code $LASTEXITCODE)" }
    ($out | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | Out-String).Trim()
}

# pac can print "Error: ..." and still exit 0, so its output is checked too.
function Invoke-Pac {
    $ErrorActionPreference = 'Continue'
    $failed = $false
    & pac @args | ForEach-Object {
        if ($_ -match '^\s*Error:') { $failed = $true }
        Write-Note $_
    }
    if ($LASTEXITCODE -ne 0 -or $failed) { throw "pac $($args[0..1] -join ' ') failed; see the message above" }
}

# A zip that pac has just written stays locked for a few seconds (virus scan),
# and the next pac command then fails on it.
function Wait-FileUnlocked([string]$Path, [int]$Seconds = 120) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        try { [IO.File]::Open($Path, 'Open', 'Read', 'None').Close(); return }
        catch {
            if ((Get-Date) -gt $deadline) { throw "$Path is still locked by another process" }
            Start-Sleep -Seconds 2
        }
    }
}

function New-CleanDir([string]$Path) {
    if (Test-Path $Path) { Remove-Item $Path -Recurse -Force }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $Path
}

function Write-Utf8File([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Invoke-WithRetry([scriptblock]$Action, [string]$What, [int]$Attempts = 10, [int]$DelaySeconds = 30) {
    for ($i = 1; ; $i++) {
        try { return (& $Action) }
        catch {
            if ($i -ge $Attempts) { throw }
            Write-Warn "$What failed: $($_.Exception.Message). Retry $i/$($Attempts - 1) in ${DelaySeconds}s."
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

function Assert-AzureLogin($Cfg) {
    $sub = & az account show --query id -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $sub) { throw 'Not signed in to Azure. Run: az login' }
    if ($sub.Trim() -ne $Cfg.SubscriptionId) {
        Write-Note "Switching az to subscription $($Cfg.SubscriptionId)"
        Invoke-Az account set --subscription $Cfg.SubscriptionId | Out-Null
    }
}

function Confirm-Run([string]$Summary, [switch]$Yes) {
    Write-Host $Summary
    if ($Yes) { return }
    $answer = Read-Host 'Continue? (y/N)'
    if ($answer -notmatch '^(y|yes)$') { throw 'Cancelled.' }
}

function Get-AccessToken([string]$Resource) {
    Get-AzValue account get-access-token --resource $Resource --query accessToken -o tsv
}

# Azure Resource Manager REST call. Used where az would need an argument that
# cmd.exe mangles (&, quotes) or where a secret must not appear on a command line.
function Invoke-Arm([string]$Method, [string]$Path, $Body) {
    $p = @{
        Method  = $Method
        Uri     = "https://management.azure.com$Path"
        Headers = @{ Authorization = "Bearer $(Get-AccessToken 'https://management.azure.com/')" }
    }
    if ($null -ne $Body) {
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20))
        $p.ContentType = 'application/json; charset=utf-8'
    }
    Invoke-RestMethod @p
}

function Get-ResourceGroupPath($Cfg) {
    "/subscriptions/$($Cfg.SubscriptionId)/resourceGroups/$($Cfg.ResourceGroup)"
}

function Get-CurrentUser {
    Invoke-Az ad signed-in-user show --query '{id:id,upn:userPrincipalName}' -o json | Out-String | ConvertFrom-Json
}

function Grant-Role([string]$PrincipalId, [string]$PrincipalType, [string]$Role, [string]$Scope) {
    # No JMESPath with parentheses here: az runs through cmd.exe, which misreads them.
    $count = @(Invoke-Az role assignment list --assignee $PrincipalId --role $Role --scope $Scope --query '[].id' -o tsv).Count
    if ($count -gt 0) { Write-Note "'$Role' already assigned to $PrincipalId"; return }
    Invoke-Az role assignment create --assignee-object-id $PrincipalId --assignee-principal-type $PrincipalType `
        --role $Role --scope $Scope -o none
    Write-Note "Assigned '$Role' to $PrincipalId"
}

. (Join-Path $PSScriptRoot 'api.ps1')
. (Join-Path $PSScriptRoot 'apim.ps1')
. (Join-Path $PSScriptRoot 'sql.ps1')
. (Join-Path $PSScriptRoot 'powerplatform.ps1')
