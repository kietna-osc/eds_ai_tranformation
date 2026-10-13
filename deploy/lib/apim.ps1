# APIM: one API per environment on the shared apim-eds-dev instance.
# The OpenAPI file and policy in apim/ are shared; the policy is adjusted per
# environment so each API reaches its own Function App with its own key.

$ApimApiVersion = '2022-08-01'

function Get-ApimPath($Cfg) { "$(Get-ResourceGroupPath $Cfg)/providers/Microsoft.ApiManagement/service/$($Cfg.Apim.Name)" }

# Creates or updates a named value and waits until APIM has applied it.
# Goes through ARM so the value (a function key) never appears on a command line.
function Set-ApimNamedValue($Cfg, [string]$Name, [string]$Value, [bool]$Secret) {
    $path = "$(Get-ApimPath $Cfg)/namedValues/${Name}?api-version=$ApimApiVersion"
    Invoke-Arm PUT $path @{ properties = @{ displayName = $Name; value = $Value; secret = $Secret } } | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        $state = (Invoke-Arm GET $path).properties.provisioningState
        if ($state -eq 'Succeeded') { Write-Note "Named value $Name is set"; return }
        Start-Sleep -Seconds 4
    }
    throw "Named value $Name did not finish provisioning"
}

# Returns the policy XML for this environment. Every replacement must match,
# so a change to the shared policy file that breaks one is caught here.
function Get-ApimPolicy($Cfg) {
    $xml = [IO.File]::ReadAllText((Join-Path $RepoRoot 'apim\eds-data-api.policy.xml'))
    $a = $Cfg.Apim
    $swaps = [ordered]@{}
    if ($a.UrlNamedValue -ne 'func-eds-url') { $swaps['{{func-eds-url}}'] = "{{$($a.UrlNamedValue)}}" }
    if ($a.KeyNamedValue -ne 'func-eds-key') { $swaps['{{func-eds-key}}'] = "{{$($a.KeyNamedValue)}}" }
    # Rate-limit counters are keyed by the caller's token across the whole instance;
    # a prefix gives this API its own counter.
    if ($a.RateLimitPrefix) { $swaps['counter-key="@('] = "counter-key=`"@(`"$($a.RateLimitPrefix)`" + " }
    foreach ($k in $swaps.Keys) {
        if (-not $xml.Contains($k)) { throw "apim/eds-data-api.policy.xml no longer contains '$k'; update deploy/lib/apim.ps1" }
        $xml = $xml.Replace($k, $swaps[$k])
    }
    $xml
}

function Deploy-Apim($Cfg) {
    $a = $Cfg.Apim
    Write-Step "Deploy APIM API $($a.ApiId) (path /$($a.Path)) on $($a.Name)"

    if ($a.ManageNamedValues) {
        $fa = "$(Get-ResourceGroupPath $Cfg)/providers/Microsoft.Web/sites/$($Cfg.FunctionApp.Name)"
        $key = (Invoke-Arm POST "$fa/host/default/listkeys?api-version=2022-03-01").functionKeys.default
        if (-not $key) { throw "Could not read the default host key of $($Cfg.FunctionApp.Name)" }
        Set-ApimNamedValue $Cfg $a.UrlNamedValue "https://$($Cfg.FunctionApp.Name).azurewebsites.net/api" $false
        Set-ApimNamedValue $Cfg $a.KeyNamedValue $key $true
    }

    Invoke-Az apim api import -g $Cfg.ResourceGroup -n $a.Name --api-id $a.ApiId --path $a.Path `
        --display-name $a.DisplayName --specification-format OpenApiJson `
        --specification-path (Join-Path $RepoRoot 'apim\eds-data-api.openapi.json') `
        --service-url $a.ServiceUrl --protocols https --subscription-required false -o none
    Write-Note 'Operations imported from apim/eds-data-api.openapi.json'

    $policyPath = "$(Get-ApimPath $Cfg)/apis/$($a.ApiId)/policies/policy?api-version=$ApimApiVersion"
    Invoke-Arm PUT $policyPath @{ properties = @{ format = 'rawxml'; value = (Get-ApimPolicy $Cfg) } } | Out-Null
    Write-Note 'Policy applied from apim/eds-data-api.policy.xml'
    $gateway = Get-AzValue apim show -g $Cfg.ResourceGroup -n $a.Name --query gatewayUrl -o tsv
    Write-Note "Callers use $gateway/$($a.Path)"
}
