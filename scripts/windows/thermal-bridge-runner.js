// Thin Node wrapper around Start-ThermalPrinterBridge.ps1 so PM2 can manage it
// the same reliable way it manages the main app (PM2's Windows "interpreter:
// none" fork mode doesn't spawn a raw .exe script path correctly).
const { spawn } = require('child_process');
const path = require('path');

const scriptPath = path.join(__dirname, 'Start-ThermalPrinterBridge.ps1');
const printerName = process.env.THERMAL_PRINTER_NAME || 'Clear Path POS-58';
const port = process.env.THERMAL_PRINTER_BRIDGE_PORT || '9100';

const child = spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
  '-PrinterName', printerName, '-Port', port,
], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code === null ? 1 : code));
