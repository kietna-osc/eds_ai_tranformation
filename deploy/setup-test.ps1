<#
.SYNOPSIS
  Creates the test environment's Azure resources and fills them with a copy of dev's data.

.DESCRIPTION
  Safe to re-run: a step whose resource already exists is skipped. Creates, from config.test.ps1:
    1. Storage: stedstest1013 (Functions host) and stedsimagestest1013 (images, history-images
       and history-exports containers; shared-key access off, as dev).
    2. Function App func-eds-test: Linux, Node 22, system-assigned identity, app settings,
       blob access, and inbound traffic restricted to the APIM gateway's IP.
    3. SQL server sql-eds-test1: Entra-only auth with you as admin, Azure services allowed.
    4. Database eds-db-test: a free-offer database with the same configuration as dev's
       eds-db (serverless Gen5, 0.5-2 vCores, 32 GB, auto-pause 60 min), filled with eds-db's
       schema and data by SqlPackage (downloaded from Microsoft once). Dev's users are not
       copied: func-eds-test gets its own user with func-eds-dev's permissions. Image URLs
       point to the test storage, and the SQL scripts are recorded as already applied.
    5. Images: dev's history-images blobs are copied to the test storage.
  Then run deploy-test.ps1 to deploy the code, the APIM API and the Power Platform solution.

.EXAMPLE
  .\deploy\setup-test.ps1
.EXAMPLE
  .\deploy\setup-test.ps1 -RecopyDatabase   # replace eds-db-test with a fresh copy of dev's data
#>
param(
    [switch]$RecopyDatabase,   # delete eds-db-test, recreate it and copy dev's data again
    [switch]$SkipImages,       # do not copy the image blobs
    [switch]$Yes
)
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$cfg = & (Join-Path $PSScriptRoot 'config.test.ps1')
$rg = $cfg.ResourceGroup
$fa = $cfg.FunctionApp
$src = $cfg.Source
$faLocation = if ($fa.Location) { $fa.Location } else { $cfg.Location }

Assert-AzureLogin $cfg
Confirm-Run @"
Set up TEST in $rg ($($cfg.Location)):
  Storage       $($fa.RuntimeStorage), $($cfg.ImageStorage.Name)
  Function App  $($fa.Name) ($($fa.PlanType), Node $($fa.NodeVersion), $faLocation)
  SQL           $($cfg.Sql.ServerName)/$($cfg.Sql.Database) (free offer)  <- schema and data of $($src.SqlServer)/$($src.Database)$(if ($RecopyDatabase) { '  (EXISTING TEST DATABASE WILL BE DELETED)' })
  Images        $($src.ImageStorage)/$($src.ImageContainer) -> $($cfg.ImageStorage.Name)$(if ($SkipImages) { ' (skipped)' })
"@ -Yes:$Yes
$me = Get-CurrentUser

# 1. Storage -------------------------------------------------------------------
Write-Step 'Storage accounts'
$accounts = @(Invoke-Az storage account list -g $rg --query '[].name' -o tsv)
foreach ($sa in @(@{ Name = $fa.RuntimeStorage; SharedKey = 'true' }, @{ Name = $cfg.ImageStorage.Name; SharedKey = 'false' })) {
    if ($accounts -contains $sa.Name) { Write-Note "$($sa.Name) exists"; continue }
    Invoke-Az storage account create -g $rg -n $sa.Name -l $cfg.Location --sku Standard_LRS --kind StorageV2 `
        --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access $sa.SharedKey -o none
    Write-Note "Created $($sa.Name)"
}
$existing = @(Invoke-Az storage container-rm list -g $rg --storage-account $cfg.ImageStorage.Name --query '[].name' -o tsv)
foreach ($c in $cfg.ImageStorage.Containers) {
    if ($existing -contains $c) { Write-Note "Container $c exists"; continue }
    Invoke-Az storage container-rm create -g $rg --storage-account $cfg.ImageStorage.Name -n $c --public-access off -o none
    Write-Note "Created container $c"
}
$imageScope = Get-AzValue storage account show -g $rg -n $cfg.ImageStorage.Name --query id -o tsv

# 2. Function App --------------------------------------------------------------
Write-Step "Function App $($fa.Name)"
if (@(Invoke-Az functionapp list -g $rg --query '[].name' -o tsv) -contains $fa.Name) {
    Write-Note "$($fa.Name) exists"
} elseif ($fa.PlanType -eq 'FlexConsumption') {
    Invoke-Az functionapp create -g $rg -n $fa.Name --storage-account $fa.RuntimeStorage `
        --flexconsumption-location $faLocation --runtime node --runtime-version $fa.NodeVersion -o none
    Write-Note "Created $($fa.Name) (Flex Consumption)"
} else {
    Invoke-Az functionapp create -g $rg -n $fa.Name --storage-account $fa.RuntimeStorage `
        --consumption-plan-location $faLocation --os-type Linux --runtime node --runtime-version $fa.NodeVersion `
        --functions-version 4 -o none
    Write-Note "Created $($fa.Name) (Consumption, Linux)"
}
# PATCH only the identity: `az functionapp identity assign` sends the whole site and
# Azure rejects that for new Linux Consumption apps ("hosting constraints").
$sitePath = "$(Get-ResourceGroupPath $cfg)/providers/Microsoft.Web/sites/$($fa.Name)?api-version=2023-12-01"
$principal = (Invoke-Arm PATCH $sitePath @{ identity = @{ type = 'SystemAssigned' } }).identity.principalId
Write-Note "Managed identity $principal"

$settings = @($fa.Settings.Keys | ForEach-Object { "$_=$($fa.Settings[$_])" })
if ($fa.PlanType -ne 'FlexConsumption') {
    # As on func-eds-dev: the package is built locally (deploy/lib/api.ps1), never on the server.
    $settings += 'AzureWebJobsFeatureFlags=EnableWorkerIndexing', 'SCM_DO_BUILD_DURING_DEPLOYMENT=false', 'ENABLE_ORYX_BUILD=false'
}
Invoke-Az functionapp config appsettings set -g $rg -n $fa.Name --settings @settings -o none
Write-Note "App settings: $(($fa.Settings.Keys) -join ', ')"

Grant-Role $principal 'ServicePrincipal' 'Storage Blob Data Contributor' $imageScope

# Only the APIM gateway may call the app, as on func-eds-dev.
$apimIps = @(Invoke-Az apim show -g $rg -n $cfg.Apim.Name --query 'publicIpAddresses' -o tsv)
$rules = @(Invoke-Az functionapp config access-restriction show -g $rg -n $fa.Name --query 'ipSecurityRestrictions[].name' -o tsv)
for ($i = 0; $i -lt $apimIps.Count; $i++) {
    $name = if ($i -eq 0) { 'AllowAPIM' } else { "AllowAPIM$($i + 1)" }
    if ($rules -contains $name) { Write-Note "Access rule $name exists"; continue }
    Invoke-Az functionapp config access-restriction add -g $rg -n $fa.Name --rule-name $name --action Allow `
        --ip-address "$($apimIps[$i])/32" --priority (100 + $i) -o none
    Write-Note "Inbound allowed only from APIM $($apimIps[$i])"
}

# 3. SQL server ----------------------------------------------------------------
Write-Step "SQL server $($cfg.Sql.ServerName)"
if (@(Invoke-Az sql server list -g $rg --query '[].name' -o tsv) -contains $cfg.Sql.ServerName) {
    Write-Note "$($cfg.Sql.ServerName) exists"
} else {
    Invoke-Az sql server create -g $rg -n $cfg.Sql.ServerName -l $cfg.Location --enable-ad-only-auth `
        --external-admin-principal-type User --external-admin-name $me.upn --external-admin-sid $me.id -o none
    Invoke-Az sql server firewall-rule create -g $rg -s $cfg.Sql.ServerName -n AllowAzureServices `
        --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
    Write-Note "Created $($cfg.Sql.ServerName) (Entra-only, admin $($me.upn))"
}

# 4. Database ------------------------------------------------------------------
$db = $cfg.Sql
Write-Step "Database $($db.Database)"
$dbs = @(Invoke-Az sql db list -g $rg -s $db.ServerName --query '[].name' -o tsv)
if ($RecopyDatabase -and $dbs -contains $db.Database) {
    Invoke-Az sql db delete -g $rg -s $db.ServerName -n $db.Database --yes -o none
    Write-Note "Deleted $($db.Database)"
    $dbs = @()
}
if ($dbs -contains $db.Database) {
    Write-Note "$($db.Database) exists"
} else {
    $freeArgs = if ($db.FreeOffer) { @('--use-free-limit', '--free-limit-exhaustion-behavior', 'AutoPause') } else { @() }
    Invoke-Az sql db create -g $rg -s $db.ServerName -n $db.Database --edition $db.Edition --compute-model Serverless `
        --family $db.Family --capacity $db.MaxVcores --min-capacity $db.MinVcores --auto-pause-delay $db.AutoPauseMinutes `
        --max-size $db.MaxSize --backup-storage-redundancy $db.BackupRedundancy --collation $db.Collation @freeArgs -o none
    Write-Note "Created $($db.Database) ($($db.Edition) serverless $($db.Family), $($db.MinVcores)-$($db.MaxVcores) vCores, $($db.MaxSize)$(if ($db.FreeOffer) { ', free offer' }))"
}
# Filled only while it has no tables, so a re-run never overwrites test data.
if ((Get-SqlTableCount $cfg) -eq 0) {
    Copy-SqlDatabase $cfg $src.SqlServer $src.Database
} else {
    Write-Note "$($db.Database) already has tables; data not copied again (use -RecopyDatabase)"
}
$appId = Get-AzValue ad sp show --id $principal --query appId -o tsv
$sid = '0x' + ((([guid]$appId).ToByteArray() | ForEach-Object { $_.ToString('X2') }) -join '')
Invoke-SqlFile $cfg (Join-Path $PSScriptRoot 'sql\after-copy.sql') @{
    FUNC_APP_SID    = $sid
    SOURCE_BLOB_URL = "https://$($src.ImageStorage).blob.core.windows.net"
}
Copy-SqlGrants $cfg $src.SqlServer $src.Database $src.FunctionApp
# The copied schema and data already contain every script's effect.
Deploy-Sql $cfg -Baseline

# 5. Images --------------------------------------------------------------------
if (-not $SkipImages) {
    Write-Step "Copy images $($src.ImageStorage)/$($src.ImageContainer) -> $($cfg.ImageStorage.Name)"
    Grant-Role $me.id 'User' 'Storage Blob Data Contributor' $imageScope
    $dir = New-CleanDir (Join-Path $OutRoot 'images')   # parcel labels: personal data, deleted below
    try {
        Invoke-Az storage blob download-batch --account-name $src.ImageStorage -s $src.ImageContainer -d $dir `
            --auth-mode login -o none
        Invoke-WithRetry {
            Invoke-Az storage blob upload-batch --account-name $cfg.ImageStorage.Name -d $cfg.FunctionApp.Settings.BLOB_CONTAINER `
                -s $dir --auth-mode login --overwrite true -o none
        } 'Image upload'
        Write-Note "Copied $((Get-ChildItem $dir -Recurse -File).Count) blobs"
    } finally { Remove-Item $dir -Recurse -Force }
}

Write-Step 'Test resources are ready. Next: .\deploy\deploy-test.ps1'
