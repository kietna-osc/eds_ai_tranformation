# Power Platform: promotes the solution from the dev environment to another one.
#
# Dev is where the app and flows are edited, so dev is the source: the solution is
# exported from it as managed, the flows are re-pointed (APIM path, etc.), its
# version is raised above the target's, and it is imported with the target's
# environment variable values and connections.
#
# The export contains the flows' real client secret, so the working folder is
# deleted after the import unless -KeepOutput is given. It is git-ignored either way.

function Get-DataverseRows([string]$EnvUrl, [string]$Query) {
    $base = $EnvUrl.TrimEnd('/')
    $h = @{ Authorization = "Bearer $(Get-AccessToken $base)"; Accept = 'application/json' }
    (Invoke-RestMethod -Headers $h -Uri "$base/api/data/v9.2/$Query").value
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# Applies every replacement to $Text; adds the number of hits per key to $Hits.
function Update-Text([string]$Text, $Replace, [hashtable]$Hits) {
    foreach ($from in $Replace.Keys) {
        $n = ([regex]::Matches($Text, [regex]::Escape($from))).Count
        if ($n -eq 0) { continue }
        $Text = $Text.Replace($from, $Replace[$from])
        $Hits[$from] += $n
    }
    $Text
}

function Test-Utf8Bom([byte[]]$Bytes) {
    $Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF
}

# A canvas app is a zip (.msapp) whose data sources and connections are JSON inside it.
function Update-MsappText([string]$Path, $Replace, [hashtable]$Hits) {
    $zip = [IO.Compression.ZipFile]::Open($Path, 'Update')
    try {
        foreach ($entry in @($zip.Entries)) {
            if ($entry.FullName -notmatch '\.(json|yaml|xml)$') { continue }
            $ms = New-Object IO.MemoryStream
            $s = $entry.Open(); try { $s.CopyTo($ms) } finally { $s.Close() }
            $bytes = $ms.ToArray()
            $bom = Test-Utf8Bom $bytes
            $text = (New-Object Text.UTF8Encoding $false).GetString($bytes, [int]$bom * 3, $bytes.Length - [int]$bom * 3)
            $new = Update-Text $text $Replace $Hits
            if ($new -ceq $text) { continue }
            $name = $entry.FullName
            $entry.Delete()
            $w = $zip.CreateEntry($name, 'Optimal').Open()
            try { $out = (New-Object Text.UTF8Encoding $bom).GetPreamble() + (New-Object Text.UTF8Encoding $false).GetBytes($new); $w.Write($out, 0, $out.Length) }
            finally { $w.Close() }
        }
    } finally { $zip.Dispose() }
}

function Update-SolutionText([string]$Folder, $Replace) {
    $hits = @{}
    foreach ($k in $Replace.Keys) { $hits[$k] = 0 }
    foreach ($f in Get-ChildItem $Folder -Recurse -File -Include *.json, *.xml) {
        $bytes = [IO.File]::ReadAllBytes($f.FullName)
        $text = [IO.File]::ReadAllText($f.FullName)
        $new = Update-Text $text $Replace $hits
        if ($new -cne $text) { [IO.File]::WriteAllText($f.FullName, $new, (New-Object Text.UTF8Encoding (Test-Utf8Bom $bytes))) }
    }
    foreach ($f in Get-ChildItem $Folder -Recurse -File -Filter *.msapp) { Update-MsappText $f.FullName $Replace $hits }
    foreach ($k in $Replace.Keys) {
        if ($hits[$k] -eq 0) { Write-Warn "'$k' was not found in the solution" }
        else { Write-Note "Replaced '$k' -> '$($Replace[$k])' ($($hits[$k]) times)" }
    }
}

function Set-SolutionVersion([string]$Folder, [string]$Target, [string]$Solution) {
    $file = Join-Path $Folder 'Other\Solution.xml'
    $text = [IO.File]::ReadAllText($file)
    $m = [regex]::Match($text, '<Version>([\d.]+)</Version>')
    $exported = [version]$m.Groups[1].Value
    $installed = Get-DataverseRows $Target "solutions?`$select=version&`$filter=uniquename%20eq%20'$Solution'" |
        Select-Object -First 1
    $base = $exported
    if ($installed -and [version]$installed.version -gt $base) { $base = [version]$installed.version }
    $new = New-Object Version $base.Major, $base.Minor, $base.Build, ($base.Revision + 1)
    [IO.File]::WriteAllText($file, $text.Replace($m.Value, "<Version>$new</Version>"), (New-Object Text.UTF8Encoding $false))
    $was = if ($installed) { $installed.version } else { 'not installed' }
    Write-Note "Version $new (dev exported $exported; target has $was)"
}

function Write-DeploymentSettings($Cfg, [string]$Zip, [string]$File) {
    $pp = $Cfg.PowerPlatform
    Invoke-Pac solution create-settings --solution-zip $Zip --settings-file $File
    $s = [IO.File]::ReadAllText($File) | ConvertFrom-Json

    $vars = @(); $unset = @()
    foreach ($ev in @($s.EnvironmentVariables)) {
        if ($null -eq $ev) { continue }
        if ($pp.EnvironmentVariables.Contains($ev.SchemaName)) {
            $ev.Value = [string]$pp.EnvironmentVariables[$ev.SchemaName]
            $vars += $ev
        } else { $unset += $ev.SchemaName }
    }
    $s.EnvironmentVariables = $vars
    if ($unset) { Write-Warn "Same values as dev (not in the config): $($unset -join ', ')" }

    $bound = @{}
    foreach ($r in Get-DataverseRows $pp.TargetEnvironment 'connectionreferences?$select=connectionreferencelogicalname,connectionid') {
        if ($r.connectionid) { $bound[$r.connectionreferencelogicalname] = $r.connectionid }
    }
    $missing = @()
    foreach ($cr in @($s.ConnectionReferences)) {
        if ($null -eq $cr) { continue }
        if ($pp.ConnectionIds.Contains($cr.LogicalName)) { $cr.ConnectionId = $pp.ConnectionIds[$cr.LogicalName] }
        elseif ($bound.ContainsKey($cr.LogicalName)) { $cr.ConnectionId = $bound[$cr.LogicalName] }
        else { $missing += "$($cr.LogicalName) ($($cr.ConnectorId.Split('/')[-1]))" }
    }
    if ($missing) {
        throw ("The target has no connection for: $($missing -join ', '). Create the connection in the target " +
            "environment (make.powerapps.com > Connections), then put its ID in PowerPlatform.ConnectionIds in the config.")
    }
    Write-Utf8File $File ($s | ConvertTo-Json -Depth 10)
}

function Deploy-PowerPlatform($Cfg, [switch]$KeepOutput) {
    $pp = $Cfg.PowerPlatform
    $sol = $pp.Solution
    $dir = New-CleanDir (Join-Path $OutRoot "powerplatform-$($Cfg.Name)")
    try {
        Write-Step "Export $sol (managed) from $($pp.SourceEnvironment)"
        $exported = Join-Path $dir "${sol}_dev_managed.zip"
        Invoke-Pac solution export --environment $pp.SourceEnvironment --name $sol --managed --path $exported --overwrite `
            --async --max-async-wait-time 30

        Write-Step 'Adjust the solution for the target environment'
        $src = Join-Path $dir 'src'
        Wait-FileUnlocked $exported
        Invoke-Pac solution unpack --zipfile $exported --folder $src --packagetype Managed
        foreach ($name in $pp.ExpectedComponents) {
            $found = Get-ChildItem $src -Recurse -File -Include *.json, *.xml | Select-String -SimpleMatch $name -List |
                Select-Object -First 1
            if (-not $found) { Write-Warn "'$name' is not in the $sol solution, so it will not be deployed. Add it to the solution in dev." }
        }
        Update-SolutionText $src $pp.Replace
        Set-SolutionVersion $src $pp.TargetEnvironment $sol

        $zip = Join-Path $dir "${sol}_$($Cfg.Name)_managed.zip"
        Invoke-Pac solution pack --zipfile $zip --folder $src --packagetype Managed
        Wait-FileUnlocked $zip
        $settings = Join-Path $dir 'settings.json'
        Write-DeploymentSettings $Cfg $zip $settings

        Write-Step "Import into $($pp.TargetEnvironment)"
        Invoke-Pac solution import --environment $pp.TargetEnvironment --path $zip --settings-file $settings `
            --activate-plugins --force-overwrite --async --max-async-wait-time 30
        Write-Note 'Imported. Flows are turned on.'
    } finally {
        if ($KeepOutput) { Write-Warn "Kept $dir. It contains the flows' client secret; delete it when done." }
        elseif (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    }
}
