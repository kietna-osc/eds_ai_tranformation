<#
.SYNOPSIS
  Deploys the current working tree to the dev environment.

.DESCRIPTION
  Parts, run in this order:
    sql   new NN_*.sql scripts at the repository root -> sql-eds-dev1/eds-db
    api   api/ -> func-eds-dev
    apim  apim/eds-data-api.* -> API eds-data-api (path /eds) on apim-eds-dev
  Power Platform is not deployed to dev: dev is where the app and flows are edited.

.EXAMPLE
  .\deploy\deploy-dev.ps1 -Parts api
.EXAMPLE
  .\deploy\deploy-dev.ps1 -Parts sql -BaselineSql   # first time: record the scripts dev already has
#>
param(
    [ValidateSet('sql', 'api', 'apim')]
    [string[]]$Parts = @('sql', 'api', 'apim'),
    [switch]$BaselineSql,   # record pending SQL scripts as applied without running them
    [switch]$Yes            # do not ask for confirmation
)
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$cfg = & (Join-Path $PSScriptRoot 'config.dev.ps1')

Assert-AzureLogin $cfg
Confirm-Run @"
Deploy to DEV: $($Parts -join ', ')
  Function App  $($cfg.FunctionApp.Name)
  SQL           $($cfg.Sql.ServerName)/$($cfg.Sql.Database)$(if ($BaselineSql) { ' (baseline only)' })
  APIM API      $($cfg.Apim.Name)/$($cfg.Apim.ApiId) (path /$($cfg.Apim.Path))
"@ -Yes:$Yes

if ($Parts -contains 'sql')  { Deploy-Sql $cfg -Baseline:$BaselineSql }
if ($Parts -contains 'api')  { Deploy-Api $cfg (Build-ApiPackage) }
if ($Parts -contains 'apim') { Deploy-Apim $cfg }
Write-Step 'Dev deployment finished'
