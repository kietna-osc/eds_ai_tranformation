<#
.SYNOPSIS
  Deploys the current working tree to the test environment.

.DESCRIPTION
  Run setup-test.ps1 once first; it creates the test resources this script deploys to.

  Parts, run in this order:
    sql            new NN_*.sql scripts at the repository root -> sql-eds-test1/eds-db-test
    api            api/ -> func-eds-test
    apim           apim/eds-data-api.* -> API eds-data-api-test (path /eds-test) on apim-eds-dev,
                   plus the named values holding func-eds-test's URL and key
    powerplatform  solution EDSPADelivery: exported from dev as managed, flows re-pointed
                   to /eds-test, imported into EDS-test

.EXAMPLE
  .\deploy\deploy-test.ps1                      # everything
.EXAMPLE
  .\deploy\deploy-test.ps1 -Parts api,apim
#>
param(
    [ValidateSet('sql', 'api', 'apim', 'powerplatform')]
    [string[]]$Parts = @('sql', 'api', 'apim', 'powerplatform'),
    [switch]$BaselineSql,   # record pending SQL scripts as applied without running them
    [switch]$KeepOutput,    # keep the exported solution in deploy/.out (it contains a client secret)
    [switch]$Yes            # do not ask for confirmation
)
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$cfg = & (Join-Path $PSScriptRoot 'config.test.ps1')

Assert-AzureLogin $cfg
Confirm-Run @"
Deploy to TEST: $($Parts -join ', ')
  Function App  $($cfg.FunctionApp.Name)
  SQL           $($cfg.Sql.ServerName)/$($cfg.Sql.Database)$(if ($BaselineSql) { ' (baseline only)' })
  APIM API      $($cfg.Apim.Name)/$($cfg.Apim.ApiId) (path /$($cfg.Apim.Path))
  Power Apps    $($cfg.PowerPlatform.Solution): dev -> $($cfg.PowerPlatform.TargetEnvironment)
"@ -Yes:$Yes

if ($Parts -contains 'sql')           { Deploy-Sql $cfg -Baseline:$BaselineSql }
if ($Parts -contains 'api')           { Deploy-Api $cfg (Build-ApiPackage) }
if ($Parts -contains 'apim')          { Deploy-Apim $cfg }
if ($Parts -contains 'powerplatform') { Deploy-PowerPlatform $cfg -KeepOutput:$KeepOutput }
Write-Step 'Test deployment finished'
