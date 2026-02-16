# AIDM v3 Backup Script
# Creates a timestamped zip backup preserving folder structure
# Excludes: venv, Lib, node_modules, __pycache__, .git, data, *.pyc, settings.json

param(
    [string]$BackupDir = ".\backup"
)

$ErrorActionPreference = "Stop"

# Config
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$projectName = "aidm_v3"
$source = Join-Path $PSScriptRoot "aidm_v3"
$dest = Join-Path $BackupDir "${projectName}_$timestamp.zip"

# Directory names to exclude (exact match)
$excludeDirNames = @(
    'venv',
    'venv313',
    'Lib',           # Another venv directory
    'Include',       # venv Include
    'share',         # venv share  
    'Scripts',       # venv Scripts (but we want our scripts!)
    'node_modules',
    '__pycache__',
    '.git',
    '.egg-info',
    '.pytest_cache',
    '.mypy_cache',
    'chroma',
    'backup',
    'test_chroma'
)

# File patterns to exclude
$excludeFilePatterns = @('*.pyc', '*.pyo', '*.zip', '*.log', 'pyvenv.cfg', '.env', '.env.example', 'settings.json', 'apikeys_unencrypted')

Write-Host "Creating backup..." -ForegroundColor Cyan
Write-Host "  Source: $source"
Write-Host "  Destination: $dest"

# Create temp staging directory
$tempDir = Join-Path $env:TEMP "aidm_backup_$timestamp"
if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

# Get all files, filter in memory
$allFiles = Get-ChildItem -Path $source -Recurse -File
$filteredFiles = @()

foreach ($file in $allFiles) {
    $skip = $false
    
    # Check if any parent directory should be excluded
    $pathParts = $file.FullName.Substring($source.Length + 1).Split('\')
    foreach ($part in $pathParts) {
        if ($excludeDirNames -contains $part) {
            $skip = $true
            break
        }
    }
    
    # Check file patterns
    if (-not $skip) {
        foreach ($pattern in $excludeFilePatterns) {
            if ($file.Name -like $pattern) {
                $skip = $true
                break
            }
        }
    }
    
    if (-not $skip) {
        $filteredFiles += $file
    }
}

Write-Host "  Found: $($filteredFiles.Count) files to backup (excluded: $($allFiles.Count - $filteredFiles.Count))" -ForegroundColor Yellow

# Copy filtered files
$fileCount = 0
foreach ($file in $filteredFiles) {
    $relativePath = $file.FullName.Substring($source.Length + 1)
    $destPath = Join-Path $tempDir $relativePath
    $destDir = Split-Path $destPath -Parent
    
    if (!(Test-Path $destDir)) {
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    
    Copy-Item $file.FullName -Destination $destPath
    $fileCount++
}

# Ensure backup directory exists
if (!(Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

# Create zip
Write-Host "  Compressing..." -ForegroundColor Yellow
Compress-Archive -Path "$tempDir\*" -DestinationPath $dest -Force

# Cleanup
Remove-Item -Path $tempDir -Recurse -Force

# Report
$sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 2)
Write-Host ""
Write-Host "Backup complete!" -ForegroundColor Green
Write-Host "  Files: $fileCount"
Write-Host "  Size: $sizeMB MB"
Write-Host "  Path: $dest"
