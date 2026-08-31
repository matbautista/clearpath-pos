#requires -Version 5.1
<#
.SYNOPSIS
  Bridges the app's direct ESC/POS network printing (server/lib/receipt.js's
  sendToNetworkPrinter) to a USB thermal printer that has no driver capable of
  rendering a full GDI/browser print job (e.g. a "Generic / Text Only" driver,
  which silently drops images and mangles anything beyond plain text).

.DESCRIPTION
  Listens on 127.0.0.1:<Port> (loopback only — the app runs on this same
  machine and is the only intended caller; this is not meant to be reachable
  from the LAN). Each TCP connection's raw bytes (built by receipt.js, logo
  included, as real ESC/POS) are read until the client closes the socket,
  then submitted as a single RAW print job straight to the named Windows
  printer via the spooler API (winspool.drv) — bypassing GDI entirely, so the
  printer receives exactly the bytes the app built, unmodified. No printer
  sharing, no vendor driver required; only the already-installed generic
  driver's RAW-datatype support is used.

.PARAMETER PrinterName
  Windows printer name to send raw jobs to. Defaults to the current default printer.

.PARAMETER Port
  TCP port to listen on. Must match "Thermal printer target" in the app's
  Settings page (e.g. 127.0.0.1:9100). Defaults to 9100.
#>
param(
    [string]$PrinterName = $(
        (Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default }).Name
    ),
    [int]$Port = 9100
)

$ErrorActionPreference = 'Stop'

if (-not $PrinterName) {
    throw "No printer name given and no default Windows printer is set. Pass -PrinterName explicitly."
}

# Standard raw-printing pattern via winspool.drv (Microsoft KB Q322090) — submits
# a byte buffer as a single RAW-datatype print job, sent to the port unmodified.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendBytesToPrinter(string printerName, byte[] data)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ClearPath POS Receipt";
        di.pDataType = "RAW";
        bool success = false;
        if (OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
        {
            try
            {
                if (StartDocPrinter(hPrinter, 1, di))
                {
                    try
                    {
                        if (StartPagePrinter(hPrinter))
                        {
                            IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(data.Length);
                            try
                            {
                                Marshal.Copy(data, 0, pUnmanagedBytes, data.Length);
                                int written;
                                success = WritePrinter(hPrinter, pUnmanagedBytes, data.Length, out written);
                            }
                            finally
                            {
                                Marshal.FreeCoTaskMem(pUnmanagedBytes);
                            }
                            EndPagePrinter(hPrinter);
                        }
                    }
                    finally
                    {
                        EndDocPrinter(hPrinter);
                    }
                }
            }
            finally
            {
                ClosePrinter(hPrinter);
            }
        }
        return success;
    }
}
'@

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Thermal printer bridge listening on 127.0.0.1:$Port -> '$PrinterName'" -ForegroundColor Green

while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $stream = $client.GetStream()
        $ms = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 8192
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $ms.Write($buffer, 0, $read)
        }
        $data = $ms.ToArray()
        if ($data.Length -gt 0) {
            $ok = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $data)
            if ($ok) {
                Write-Host "$(Get-Date -Format 'HH:mm:ss') Printed $($data.Length) bytes to '$PrinterName'" -ForegroundColor Green
            } else {
                Write-Host "$(Get-Date -Format 'HH:mm:ss') Print job failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" -ForegroundColor Red
            }
        }
    } catch {
        Write-Host "$(Get-Date -Format 'HH:mm:ss') Error handling print job: $($_.Exception.Message)" -ForegroundColor Red
    } finally {
        $client.Close()
    }
}
