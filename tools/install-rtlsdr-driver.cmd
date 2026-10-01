<# : batch part - PowerShell reads everything up to the closing marker as a comment
@echo off
setlocal
set "MN_SELF=%~f0"
set "MN_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "MN_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%MN_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:MN_SELF))) %*"
endlocal & exit /b %ERRORLEVEL%
#>

# MegaNet - tools/install-rtlsdr-driver.cmd
#
#   Gives every RTL-SDR stick plugged into this PC Windows' own WinUSB driver,
#   so Chrome and Edge can offer it to the Serial Monitor's RTL-SDR card
#   (WebUSB) - and rtl_sdr, rtl_tcp, SDR# and SDR++ can use it too. It is the
#   step Zadig does by hand, done for every stick at once.
#
#   Double-click it. It lists the sticks and their drivers first, changes
#   nothing until you say yes, and only then asks Windows for admin rights.
#   From a terminal:
#     install-rtlsdr-driver.cmd -List    report only: change nothing, ask nothing
#     install-rtlsdr-driver.cmd -Yes     install without asking first
#
# This one file is a batch file and a PowerShell script at once. cmd runs the
# few lines above the "#>" - PowerShell reads them as a comment - and they
# hand the whole file to PowerShell, with no change to the PC's execution
# policy. It is plain text: read it in Notepad before running it.
#
# What it does to a stick, and why it is safe:
#
#   * Which device. A Blog V3 or V4 is a composite device: Windows' own
#     composite driver splits it into interface 0 (the radio) and interface 1
#     (an IR receiver), and WinUSB goes on interface 0 - Zadig's "Bulk-In,
#     Interface (Interface 0)". Many V2-era and generic sticks (0bda:2832,
#     "RTL2832U") have one interface only, so the device itself takes WinUSB;
#     there is no "interface 0" to pick, which is where Zadig loses people.
#   * Which driver. Windows' own winusb.inf, model "WinUsb Device": signed by
#     Microsoft and already on every Windows 10 and 11 PC. Nothing is
#     downloaded, no driver package is added, and - unlike Zadig - no
#     certificate is added to the machine's trusted roots. It is Device
#     Manager's Update driver > Browse my computer > Let me pick > Universal
#     Serial Bus devices > WinUsb Device, done through SetupAPI.
#   * One registry value. WinUSB announces a device to programs by the
#     interface GUIDs in its "Device Parameters" key, and Chrome finds a
#     composite stick's interface 0 by them. Zadig writes one; so does this,
#     where none is set.
#   * Undo. Device Manager > the stick > Uninstall device, then re-plug it.
#     Windows has no driver of its own that names an RTL2832U, so it comes
#     back as it was before.
#
# The sticks it looks for are the ones rtlsdr.js asks the browser for
# (RtlSdr.FILTERS); test/rtlsdr.mjs holds the two lists together. Keep this
# file plain ASCII with CRLF line ends (.gitattributes): cmd reads it too.

[CmdletBinding()]
param(
  [switch]$List,          # report only: change nothing, ask nothing
  [switch]$Yes,           # install without asking first
  [switch]$Elevated,      # internal: the copy Windows started with admin rights
  [string]$ResultFile     # internal: where that copy reports back
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'      # the PnP cmdlets' progress bars, flickering over the list

# VID/PID pairs - the same two as RtlSdr.FILTERS in rtlsdr.js.
$StickIds = @('VID_0BDA&PID_2838', 'VID_0BDA&PID_2832')
# The interface GUID WinUSB registers for a stick set up here. Zadig picks a
# random one per stick; one fixed GUID marks the sticks this tool set up.
$InterfaceGuid = '{D6010F80-187E-4DB5-A1D6-545823B06C83}'
$WinUsbInf = Join-Path $env:windir 'INF\winusb.inf'
$Self = if ($env:MN_SELF) { $env:MN_SELF } else { $PSCommandPath }
$ZadigHelp = 'Zadig (https://zadig.akeo.ie) does the same by hand: Options > List All Devices, pick the stick - ' +
  '"Bulk-In, Interface (Interface 0)" for a V3 or V4, "RTL2832U" for a one-interface stick - choose WinUSB, ' +
  'then Replace (or Install) Driver.'

function Say([string]$text, [string]$color) {
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

# The command line that runs this same file again, with these switches, as a
# -EncodedCommand: no quoting to get wrong, whatever the path holds.
function Get-RerunCommand([string]$switches) {
  $cmd = "`$env:MN_SELF = '" + $Self.Replace("'", "''") + "'; " +
    "& ([ScriptBlock]::Create([IO.File]::ReadAllText(`$env:MN_SELF))) " + $switches
  [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
}

# Pause before the window closes - only when the file was double-clicked
# (Explorer started the cmd.exe that started this), not in a terminal.
function Test-DoubleClicked {
  try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $cmd = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)"
    if (-not $cmd -or $cmd.Name -ne 'cmd.exe' -or $cmd.CommandLine -notmatch '/c') { return $false }
    $shell = Get-CimInstance Win32_Process -Filter "ProcessId=$($cmd.ParentProcessId)"
    return [bool]($shell -and $shell.Name -eq 'explorer.exe')
  } catch { return $false }
}

function Finish([int]$code) {
  if (-not $Elevated -and (Test-DoubleClicked)) { [void](Read-Host 'Press Enter to close') }
  exit $code
}

# ---- the PC this is running on ---------------------------------------------

if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  # A 32-bit PowerShell cannot install drivers on 64-bit Windows: run the 64-bit one.
  $ps = Join-Path $env:windir 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  $sw = @(); if ($List) { $sw += '-List' }; if ($Yes) { $sw += '-Yes' }
  & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand (Get-RerunCommand ($sw -join ' '))
  exit $LASTEXITCODE
}
if (-not [Environment]::Is64BitOperatingSystem) {
  Say 'This installer is for 64-bit Windows. On 32-bit Windows:' Yellow
  Say $ZadigHelp
  Finish 1
}
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Say ('PowerShell is locked down on this PC (' + $ExecutionContext.SessionState.LanguageMode + ' mode), so this cannot run. ' +
    'Ask IT to install the WinUSB driver on the stick, or:') Yellow
  Say $ZadigHelp
  Finish 1
}
if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) -or -not (Test-Path -LiteralPath $WinUsbInf)) {
  Say 'This needs Windows 10 or 11 (Get-PnpDevice and the built-in winusb.inf). On older Windows:' Yellow
  Say $ZadigHelp
  Finish 1
}

if (-not ('MegaNetWinUsb' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

// SetupAPI's own road to "Let me pick a driver": one device, Windows' own
// winusb.inf as the only INF to look in, its "WinUsb Device" model selected
// and installed. Structures are the 64-bit (8-byte packed) layouts.
#pragma warning disable 169, 649
public static class MegaNetWinUsb
{
    const uint DI_NEEDRESTART = 0x00000080, DI_NEEDREBOOT = 0x00000100, DI_ENUMSINGLEINF = 0x00010000;
    const uint DI_FLAGSEX_ALLOWEXCLUDEDDRVS = 0x00000800;
    const uint SPDIT_CLASSDRIVER = 1, DICS_FLAG_GLOBAL = 1, DIREG_DEV = 1;
    const uint DIF_INSTALLDEVICE = 2, DIIDFLAG_NOFINISHINSTALLUI = 2;
    static readonly IntPtr INVALID = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SP_DEVINSTALL_PARAMS {
        public uint cbSize; public uint Flags; public uint FlagsEx; public IntPtr hwndParent;
        public IntPtr InstallMsgHandler; public IntPtr InstallMsgHandlerContext; public IntPtr FileQueue;
        public UIntPtr ClassInstallReserved; public uint Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DriverPath;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SP_DRVINFO_DATA {
        public uint cbSize; public uint DriverType; public UIntPtr Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Description;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string MfgName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ProviderName;
        public System.Runtime.InteropServices.ComTypes.FILETIME DriverDate;
        public ulong DriverVersion;
    }

    // The fixed part only: HardwareID runs on past the end of the struct.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SP_DRVINFO_DETAIL_DATA {
        public uint cbSize;
        public System.Runtime.InteropServices.ComTypes.FILETIME InfDate;
        public uint CompatIDsOffset; public uint CompatIDsLength; public UIntPtr Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string SectionName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string InfFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string DrvDescription;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 1)] public string HardwareID;
    }

    [DllImport("setupapi.dll", SetLastError = true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr classGuid, IntPtr hwnd);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiOpenDeviceInfo(IntPtr set, string instanceId, IntPtr hwnd, uint flags, ref SP_DEVINFO_DATA dev);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiGetDeviceInstallParams(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DEVINSTALL_PARAMS p);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiSetDeviceInstallParams(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DEVINSTALL_PARAMS p);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiBuildDriverInfoList(IntPtr set, ref SP_DEVINFO_DATA dev, uint type);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiEnumDriverInfo(IntPtr set, ref SP_DEVINFO_DATA dev, uint type, uint index, ref SP_DRVINFO_DATA drv);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiGetDriverInfoDetail(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DRVINFO_DATA drv, IntPtr buf, uint size, out uint need);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiSetSelectedDriver(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DRVINFO_DATA drv);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiCallClassInstaller(uint fn, IntPtr set, ref SP_DEVINFO_DATA dev);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr SetupDiCreateDevRegKey(IntPtr set, ref SP_DEVINFO_DATA dev, uint scope, uint hwProfile, uint keyType, IntPtr inf, string section);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("newdev.dll", SetLastError = true)]
    static extern bool DiInstallDevice(IntPtr hwnd, IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DRVINFO_DATA drv, uint flags, out bool reboot);

    static IntPtr Open(string id, out SP_DEVINFO_DATA dev) {
        IntPtr set = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
        if (set == INVALID) throw new Win32Exception();
        dev = new SP_DEVINFO_DATA();
        dev.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
        if (!SetupDiOpenDeviceInfo(set, id, IntPtr.Zero, 0, ref dev)) {
            int err = Marshal.GetLastWin32Error();
            SetupDiDestroyDeviceInfoList(set);
            throw new Win32Exception(err);
        }
        return set;
    }

    // The "WinUsb Device" model (install section WINUSB) of winusb.inf, as a
    // driver for this device. The INF's other models are the Billboard and
    // ADB devices; its lower-filter entry has no hardware ID and is not listed.
    static SP_DRVINFO_DATA FindWinUsb(IntPtr set, ref SP_DEVINFO_DATA dev, string inf) {
        var p = new SP_DEVINSTALL_PARAMS();
        p.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINSTALL_PARAMS));
        if (!SetupDiGetDeviceInstallParams(set, ref dev, ref p)) throw new Win32Exception();
        p.Flags |= DI_ENUMSINGLEINF;
        p.FlagsEx |= DI_FLAGSEX_ALLOWEXCLUDEDDRVS;
        p.DriverPath = inf;
        if (!SetupDiSetDeviceInstallParams(set, ref dev, ref p)) throw new Win32Exception();
        if (!SetupDiBuildDriverInfoList(set, ref dev, SPDIT_CLASSDRIVER)) throw new Win32Exception();
        int fixedSize = Marshal.SizeOf(typeof(SP_DRVINFO_DETAIL_DATA));
        int sectionAt = (int)Marshal.OffsetOf(typeof(SP_DRVINFO_DETAIL_DATA), "SectionName");
        const int size = 16384;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try {
            for (uint i = 0; ; i++) {
                var d = new SP_DRVINFO_DATA();
                d.cbSize = (uint)Marshal.SizeOf(typeof(SP_DRVINFO_DATA));
                if (!SetupDiEnumDriverInfo(set, ref dev, SPDIT_CLASSDRIVER, i, ref d)) break;
                Marshal.WriteInt32(buf, fixedSize);
                uint need;
                if (!SetupDiGetDriverInfoDetail(set, ref dev, ref d, buf, size, out need)) continue;
                string section = Marshal.PtrToStringUni(IntPtr.Add(buf, sectionAt));
                if (string.Equals(section, "WINUSB", StringComparison.OrdinalIgnoreCase)) return d;
            }
        } finally { Marshal.FreeHGlobal(buf); }
        throw new InvalidOperationException("Windows' WinUSB driver (\"WinUsb Device\" in " + inf + ") was not offered for this device.");
    }

    // A dry run: finds the driver Install would put on the device, changes nothing.
    public static string Check(string id, string inf) {
        SP_DEVINFO_DATA dev;
        IntPtr set = Open(id, out dev);
        try {
            SP_DRVINFO_DATA d = FindWinUsb(set, ref dev, inf);
            return d.Description + " (" + d.ProviderName + ")";
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }

    // Writes the interface GUID if the device has none, then installs WinUSB
    // on it. Needs admin rights. Returns true if Windows wants a restart.
    public static bool Install(string id, string inf, string guid) {
        SP_DEVINFO_DATA dev;
        IntPtr set = Open(id, out dev);
        try {
            IntPtr h = SetupDiCreateDevRegKey(set, ref dev, DICS_FLAG_GLOBAL, 0, DIREG_DEV, IntPtr.Zero, null);
            if (h == INVALID) throw new Win32Exception();
            using (RegistryKey key = RegistryKey.FromHandle(new SafeRegistryHandle(h, true))) {
                if (key.GetValue("DeviceInterfaceGUIDs") == null && key.GetValue("DeviceInterfaceGUID") == null)
                    key.SetValue("DeviceInterfaceGUIDs", new string[] { guid }, RegistryValueKind.MultiString);
            }
            SP_DRVINFO_DATA d = FindWinUsb(set, ref dev, inf);
            if (!SetupDiSetSelectedDriver(set, ref dev, ref d)) throw new Win32Exception();
            bool reboot;
            if (DiInstallDevice(IntPtr.Zero, set, ref dev, ref d, DIIDFLAG_NOFINISHINSTALLUI, out reboot)) return reboot;
            int err = Marshal.GetLastWin32Error();
            // The older road to the same place: the class installer, given the selected driver.
            if (!SetupDiCallClassInstaller(DIF_INSTALLDEVICE, set, ref dev)) throw new Win32Exception(err);
            var p = new SP_DEVINSTALL_PARAMS();
            p.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINSTALL_PARAMS));
            return SetupDiGetDeviceInstallParams(set, ref dev, ref p) && (p.Flags & (DI_NEEDREBOOT | DI_NEEDRESTART)) != 0;
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }
}
'@
}

# ---- the sticks ------------------------------------------------------------

function Get-Prop([string]$id, [string]$key) {
  try { (Get-PnpDeviceProperty -InstanceId $id -KeyName $key -ErrorAction Stop).Data } catch { $null }
}

function Get-InterfaceGuids([string]$id) {
  $k = 'HKLM:\SYSTEM\CurrentControlSet\Enum\' + $id + '\Device Parameters'
  try {
    $v = Get-ItemProperty -LiteralPath $k -ErrorAction Stop
    @($v.DeviceInterfaceGUIDs) + @($v.DeviceInterfaceGUID) | Where-Object { $_ }
  } catch { @() }
}

# Every stick plugged in, with the device that has to carry WinUSB (the stick
# itself, or a composite stick's interface 0) and what holds that now.
function Get-Sticks {
  $pattern = '^USB\\(' + (($StickIds | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\\'
  $found = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match $pattern })
  foreach ($d in $found) {
    $id = $d.InstanceId
    $name = Get-Prop $id 'DEVPKEY_Device_BusReportedDeviceDesc'
    if (-not $name) { $name = $d.FriendlyName }
    $serial = ($id -split '\\')[-1]
    if ($serial -match '&') { $serial = '' }          # a port-based ID, not a serial number
    $service = [string](Get-Prop $id 'DEVPKEY_Device_Service')
    $composite = ($service -eq 'usbccgp') -or (@(Get-Prop $id 'DEVPKEY_Device_CompatibleIds') -contains 'USB\COMPOSITE')
    $target = $id; $where = 'the stick'
    if ($composite -and $service -ne 'WinUSB') {
      $target = @(Get-Prop $id 'DEVPKEY_Device_Children') | Where-Object { $_ -match '&MI_00\\' } | Select-Object -First 1
      $where = 'interface 0'
    }
    $s = [pscustomobject]@{
      Id = $id; Name = $name; Serial = $serial; Target = $target; Where = $where
      Service = ''; Need = $false; Replaces = ''; State = ''
    }
    if (-not $target) {
      $s.State = 'a composite stick whose interface 0 Windows has not set up - re-plug it, then run this again'
    } else {
      if ($target -ne $id) { $s.Service = [string](Get-Prop $target 'DEVPKEY_Device_Service') } else { $s.Service = $service }
      $problem = [int](Get-Prop $target 'DEVPKEY_Device_ProblemCode')
      if ($s.Service -eq 'WinUSB') {
        if ($problem) {
          $s.State = "WinUSB, but Windows reports problem code $problem - re-plug it, or try another USB port"
        } elseif ($where -eq 'interface 0' -and -not (Get-InterfaceGuids $target)) {
          $s.Need = $true
          $s.State = 'WinUSB, but with no interface GUID - Chrome and Edge cannot find interface 0'
        } else {
          $s.State = 'WinUSB - ready for the browser'
        }
      } elseif (-not $s.Service) {
        $s.Need = $true
        $s.State = 'no driver - Windows has none for it, so the browser cannot see it'
      } else {
        $s.Need = $true
        $s.Replaces = $s.Service
        if ($s.Service -match '^libusb(0|K)$') {
          $s.State = "$($s.Service) (libusb-win32 / libusbK) - SDR# may work, the browser cannot use it"
        } else {
          $s.State = "$($s.Service) - a TV (DVB-T) or other driver holds it, so the browser cannot"
        }
      }
    }
    $s
  }
}

function Show-Sticks($sticks) {
  $n = 0
  foreach ($s in $sticks) {
    $n++
    $label = "  $n. $($s.Name)" + $(if ($s.Serial) { "  s/n $($s.Serial)" } else { '' })
    Say $label
    $color = if ($s.State -like 'WinUSB - ready*') { 'Green' } elseif ($s.Need) { 'Yellow' } else { 'Red' }
    Say ("     $($s.Id)" + $(if ($s.Where -eq 'interface 0') { ', interface 0' } else { '' }) + ": $($s.State)") $color
  }
}

function Install-Here($todo) {
  $out = @()
  foreach ($s in $todo) {
    try {
      $reboot = [MegaNetWinUsb]::Install($s.Target, $WinUsbInf, $InterfaceGuid)
      $out += ($s.Target + "`t" + $(if ($reboot) { 'reboot' } else { 'ok' }) + "`t")
    } catch {
      $out += ($s.Target + "`terror`t" + $_.Exception.Message)
    }
  }
  $out
}

# ---- the copy Windows started with admin rights ----------------------------

if ($Elevated) {
  $lines = @()
  try { $lines = @(Install-Here @(Get-Sticks | Where-Object { $_.Need -and $_.Target })) }
  catch { $lines = @("`terror`t" + $_.Exception.Message) }
  if ($ResultFile) { Set-Content -LiteralPath $ResultFile -Value $lines -Encoding UTF8 } else { $lines | ForEach-Object { Say $_ } }
  exit 0
}

# ---- list, ask, install ----------------------------------------------------

Say ''
Say 'MegaNet - WinUSB for RTL-SDR sticks' Cyan
Say ''
$sticks = @(Get-Sticks)
if (-not $sticks.Count) {
  Say 'No RTL-SDR stick is plugged in (USB 0bda:2838 or 0bda:2832). Plug one in and run this again.' Yellow
  Finish 2
}
Say 'RTL-SDR sticks plugged in:'
Show-Sticks $sticks
Say ''

$todo = @($sticks | Where-Object { $_.Need -and $_.Target })
if (-not $todo.Count) {
  if (@($sticks | Where-Object { $_.State -notlike 'WinUSB - ready*' }).Count) {
    Say 'Nothing here a driver install would fix - see the note against the stick above.' Yellow
    Finish 1
  }
  Say 'Nothing to do: every stick already has WinUSB.' Green
  Say 'In MegaNet: Serial Monitor > + RTL-SDR > Choose USB stick... (Chrome or Edge).'
  Finish 0
}

# A dry run first, as the user: is Windows' WinUSB on offer for each of them?
foreach ($s in $todo) {
  try { [void][MegaNetWinUsb]::Check($s.Target, $WinUsbInf) }
  catch {
    Say ("Windows will not offer its WinUSB driver for $($s.Name): " + $_.Exception.Message) Red
    Say $ZadigHelp
    Finish 1
  }
}

$names = ($todo | ForEach-Object { $_.Name + $(if ($_.Where -eq 'interface 0') { ' (interface 0)' } else { '' }) }) -join ', '
Say ("To do: install Windows' WinUSB driver on $names.")
foreach ($s in @($todo | Where-Object { $_.Replaces })) {
  Say ("  This replaces the $($s.Replaces) driver on $($s.Name). A TV app that used it will lose the stick; " +
    'SDR#, SDR++, rtl_tcp and the browser will have it.') Yellow
}
if ($List) {
  Say 'Run it again without -List to install.'
  Finish 1
}
if (-not $Yes) {
  $a = Read-Host 'Install now? Windows will ask for admin rights. [Y/n]'
  if ($a -and $a -notmatch '^\s*y') { Say 'Nothing changed.'; Finish 1 }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  $lines = @(Install-Here $todo)
} else {
  if (-not $Self -or -not (Test-Path -LiteralPath $Self)) {
    Say 'Cannot ask for admin rights from here: run this file itself (double-click it), or run it from an admin terminal.' Red
    Finish 1
  }
  $result = Join-Path ([IO.Path]::GetTempPath()) ('meganet-rtlsdr-' + [guid]::NewGuid().ToString('N') + '.txt')
  $exe = (Get-Process -Id $PID).Path
  try {
    Start-Process -FilePath $exe -Verb RunAs -Wait -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', (Get-RerunCommand ("-Elevated -ResultFile '" + $result.Replace("'", "''") + "'")))
  } catch {
    Say 'Windows did not grant admin rights (the prompt was cancelled or refused), so nothing changed.' Yellow
    Finish 1
  }
  $lines = @()
  if (Test-Path -LiteralPath $result) {
    $lines = @(Get-Content -LiteralPath $result)
    Remove-Item -LiteralPath $result -ErrorAction SilentlyContinue
  } else {
    $lines = @("`terror`tThe admin copy of this installer did not report back.")
  }
}

Say ''
$failed = $false
foreach ($line in $lines) {
  if (-not $line) { continue }
  $f = $line -split "`t", 3
  $s = $todo | Where-Object { $_.Target -eq $f[0] } | Select-Object -First 1
  $who = if ($s) { $s.Name } else { 'the installer' }
  switch ($f[1]) {
    'ok'     { Say "Installed WinUSB on $who." Green }
    'reboot' { Say "Installed WinUSB on $who - Windows wants a restart before it takes effect." Yellow }
    default  { Say ("Could not install WinUSB on ${who}: " + $f[2]) Red; $failed = $true }
  }
}
if ($failed) { Say ''; Say $ZadigHelp }

Start-Sleep -Seconds 2                # let Windows start the stick on its new driver
Say ''
Say 'Now:'
$after = @(Get-Sticks)
Show-Sticks $after
Say ''
if (@($after | Where-Object { $_.State -notlike 'WinUSB - ready*' }).Count) {
  Say 'Not every stick is ready yet - see the notes above. Re-plugging a stick, then running this again, often settles it.' Yellow
  Finish 1
}
Say 'Done. In MegaNet: Serial Monitor > + RTL-SDR > Choose USB stick... (Chrome or Edge).' Green
Say 'The stick is listed by its own name (e.g. "RTL2832U" or "Blog V4"). The browser needs no restart;'
Say 'if the stick is not in its list, unplug it and plug it back in.'
Finish 0
