# Scrub sensitive files from all existing backup zips
# Removes: .env, .env.example, settings.json, apikeys_unencrypted

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$backupDir = Join-Path $PSScriptRoot "backup"
$sensitiveFiles = @('.env', '.env.example', 'settings.json', 'apikeys_unencrypted')

$zips = Get-ChildItem -Path $backupDir -Filter "*.zip" -File
Write-Host "Found $($zips.Count) backup zips to scrub" -ForegroundColor Cyan
Write-Host ""

foreach ($zipFile in $zips) {
    Write-Host "Processing: $($zipFile.Name)" -ForegroundColor Yellow
    $removed = @()

    try {
        $zip = [System.IO.Compression.ZipFile]::Open($zipFile.FullName, [System.IO.Compression.ZipArchiveMode]::Update)

        # Collect entries to remove (can't modify collection while iterating)
        $toRemove = @()
        foreach ($entry in $zip.Entries) {
            $entryName = Split-Path $entry.FullName -Leaf
            if ($sensitiveFiles -contains $entryName) {
                $toRemove += $entry
                $removed += $entry.FullName
            }
        }

        foreach ($entry in $toRemove) {
            $entry.Delete()
        }

        $zip.Dispose()

        if ($removed.Count -gt 0) {
            Write-Host "  Removed $($removed.Count) file(s):" -ForegroundColor Red
            foreach ($r in $removed) {
                Write-Host "    - $r" -ForegroundColor Red
            }
        }
        else {
            Write-Host "  Clean (no sensitive files found)" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  ERROR: $_" -ForegroundColor Red
        if ($zip) { $zip.Dispose() }
    }
}

Write-Host ""
Write-Host "Scrub complete!" -ForegroundColor Green
