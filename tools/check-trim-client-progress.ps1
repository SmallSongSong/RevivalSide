param(
    [string]$Dotnet = 'dotnet',
    [string]$HostDll = "$PSScriptRoot/../exports/android-combat-host/CombatHost.dll",
    [string]$ManagedDir = "$PSScriptRoot/../exports/reference/Managed",
    [string]$GameplayTablesDir = "$PSScriptRoot/../exports/reference/frozen-tables/gameplay-tables"
)
$ErrorActionPreference = 'Stop'
$projectDir = "$PSScriptRoot/../exports/trim-client-progress-check"
New-Item -ItemType Directory -Force $projectDir | Out-Null
@'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
'@ | Set-Content "$projectDir/Check.csproj"
Copy-Item "$PSScriptRoot/check-trim-client-progress.cs" "$projectDir/Program.cs"
$fixture = "$projectDir/trim-end.json"
& node "$PSScriptRoot/check-battle-continuation.js" $fixture
if ($LASTEXITCODE -ne 0) { throw 'Battle continuation fixture check failed' }
& $Dotnet run --project "$projectDir/Check.csproj" -- $HostDll $ManagedDir $GameplayTablesDir "$fixture.progress.json"
if ($LASTEXITCODE -ne 0) { throw 'Native Trim client progress check failed' }
