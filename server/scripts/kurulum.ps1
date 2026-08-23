# Redakt On-Premise · Windows kurulum betigi
#
# Yaptiklari:
#   1. Yapilandirma dosyasini hazirlar (config\.env)
#   2. config klasorunun okuma iznini servis hesabi ve yoneticilerle sinirlar
#   3. Gorev Zamanlayici uzerinde acilista baslayan bir gorev olusturur
#   4. Guvenlik duvarinda gelen baglanti kurali acar
#
# Yonetici olarak calistirin:
#   powershell -ExecutionPolicy Bypass -File kurulum.ps1 -ServiceAccount "SIRKET\svc_redakt"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServiceAccount,

    [int]$Port = 8080,
    [string]$TaskName = "Redakt-OnPremise",
    [switch]$SkipFirewall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = Join-Path $root "node.exe"
$appScript = Join-Path $root "app\redakt-server.mjs"
$configDir = Join-Path $root "config"
$envFile = Join-Path $configDir ".env"
$envExample = Join-Path $configDir ".env.example"
$logDir = Join-Path $root "logs"

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "   [OK] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "   [!]  $text" -ForegroundColor Yellow }

# --- Yonetici kontrolu ------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Bu betik yonetici olarak calistirilmalidir."
}

# --- On kosullar ------------------------------------------------------------
Write-Step "On kosullar denetleniyor"
foreach ($required in @($nodeExe, $appScript)) {
    if (-not (Test-Path $required)) { throw "Paket eksik, bulunamadi: $required" }
}
Write-Ok "Paket dosyalari yerinde"

try {
    $null = New-Object Security.Principal.NTAccount($ServiceAccount)
    $sid = (New-Object Security.Principal.NTAccount($ServiceAccount)).Translate([Security.Principal.SecurityIdentifier])
    Write-Ok "Servis hesabi dogrulandi: $ServiceAccount"
} catch {
    throw "Servis hesabi bulunamadi: $ServiceAccount"
}

# --- Yapilandirma -----------------------------------------------------------
Write-Step "Yapilandirma"
if (-not (Test-Path $envFile)) {
    if (-not (Test-Path $envExample)) { throw "Ornek yapilandirma bulunamadi: $envExample" }
    Copy-Item $envExample $envFile
    Write-Warn2 ".env olusturuldu. Kuruluma devam etmeden once doldurun: $envFile"
    Write-Warn2 "SQL parolasi icin once redakt-encrypt-password.cmd dosyasini SERVIS HESABIYLA calistirin."
} else {
    Write-Ok ".env zaten var, degistirilmedi"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Write-Ok "Log klasoru: $logDir"

# --- Izinler ----------------------------------------------------------------
# Yapilandirmada SQL parolasi bulunur; yalnizca servis hesabi ve yoneticiler okuyabilmeli.
Write-Step "Klasor izinleri kisitlaniyor"
$acl = Get-Acl $configDir
$acl.SetAccessRuleProtection($true, $false)   # kalitimi kes
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
foreach ($account in @($ServiceAccount, "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $account, "Read", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $configDir -AclObject $acl
Write-Ok "config klasorunu yalnizca $ServiceAccount, Administrators ve SYSTEM okuyabilir"

# Servis hesabi log klasorune yazabilmeli.
$logAcl = Get-Acl $logDir
$logRule = New-Object Security.AccessControl.FileSystemAccessRule(
    $ServiceAccount, "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
$logAcl.AddAccessRule($logRule)
Set-Acl -Path $logDir -AclObject $logAcl
Write-Ok "Log klasorune yazma izni verildi"

# --- Gorev olustur ----------------------------------------------------------
# Node dogrudan Windows servisi olamaz (servis kontrol mesajlarina yanit vermez).
# Gorev Zamanlayici acilista baslatir, kullanici oturum acmasa da calisir ve
# cokme durumunda yeniden baslatir.
Write-Step "Acilista baslayan gorev olusturuluyor"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Warn2 "Onceki gorev kaldirildi"
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$appScript`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principalObj = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType Password -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Write-Host "   $ServiceAccount hesabinin parolasi istenecek (Windows gorevi icin gereklidir)."
$credential = Get-Credential -UserName $ServiceAccount -Message "Redakt servis hesabi parolasi"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principalObj -Settings $settings `
    -User $credential.UserName -Password $credential.GetNetworkCredential().Password | Out-Null
Write-Ok "Gorev olusturuldu: $TaskName"

# --- Guvenlik duvari --------------------------------------------------------
if (-not $SkipFirewall) {
    Write-Step "Guvenlik duvari kurali"
    $ruleName = "Redakt On-Premise (TCP $Port)"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Domain | Out-Null
    Write-Ok "TCP $Port gelen baglantiya acildi (yalnizca Domain profili)"
} else {
    Write-Warn2 "Guvenlik duvari adimi atlandi"
}

# --- Bitis ------------------------------------------------------------------
Write-Host "`n== Kurulum tamamlandi" -ForegroundColor Cyan
Write-Host @"

Siradaki adimlar:

  1. Yapilandirmayi doldurun:
       $envFile

  2. SQL parolasini sifreleyin (SERVIS HESABIYLA oturum acarak):
       redakt-encrypt-password.cmd
     Cikan SQL_PASSWORD_ENC satirini .env icine yazin, SQL_PASSWORD satirini silin.

  3. Kurulumu dogrulayin:
       redakt-check.cmd

  4. Servisi baslatin:
       Start-ScheduledTask -TaskName $TaskName

  Loglar: $logDir

"@
