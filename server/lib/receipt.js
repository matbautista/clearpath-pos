const net = require('net');
const { PNG } = require('pngjs');

// Minimal ESC/POS command builder — no native dependencies required.
// Works with most thermal receipt printers that accept raw ESC/POS over
// a network socket (common on WiFi/Ethernet thermal printers, port 9100),
// or over a USB printer that has been shared as a raw/generic-text printer
// at the OS level.
const ESC = '\x1b';
const GS = '\x1d';

function center(text) {
  return ESC + 'a' + '\x01' + text + ESC + 'a' + '\x00';
}
function bold(text) {
  return ESC + 'E' + '\x01' + text + ESC + 'E' + '\x00';
}
function cut() {
  return '\n\n\n' + GS + 'V' + '\x00';
}
function line(width) {
  return '-'.repeat(width) + '\n';
}

function padRow(left, right, width) {
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function discountLabel(receipt) {
  if (receipt.discountType === 'senior') return 'Senior Citizen Disc. (20%)';
  if (receipt.discountType === 'pwd') return 'PWD Discount (20%)';
  return 'Discount';
}

// Converts a data: URI (PNG only — the browser normalizes any uploaded image
// format to PNG before it's saved to settings) into a dithered 1-bit bitmap
// sized to fit the printer's dot width, for the ESC/POS raster image command.
function logoToBitmap(logoDataUri, maxWidthDots) {
  const base64 = String(logoDataUri).split(',')[1];
  if (!base64) return null;
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const scale = png.width > maxWidthDots ? maxWidthDots / png.width : 1;
  const width = Math.max(1, Math.round(png.width * scale));
  const height = Math.max(1, Math.round(png.height * scale));

  // Nearest-neighbor downscale to grayscale, compositing alpha over white.
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(png.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(png.width - 1, Math.floor(x / scale));
      const idx = (png.width * srcY + srcX) << 2;
      const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3] / 255;
      gray[y * width + x] = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a);
    }
  }

  // Floyd-Steinberg dithering to 1-bit (bits: 1 = white, 0 = black/printed).
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const oldVal = gray[i];
      const newVal = oldVal < 128 ? 0 : 255;
      bits[i] = newVal === 255 ? 1 : 0;
      const err = oldVal - newVal;
      if (x + 1 < width) gray[i + 1] += err * (7 / 16);
      if (y + 1 < height) {
        if (x > 0) gray[i + width - 1] += err * (3 / 16);
        gray[i + width] += err * (5 / 16);
        if (x + 1 < width) gray[i + width + 1] += err * (1 / 16);
      }
    }
  }
  return { width, height, bits };
}

function bitmapToEscPosRaster(bitmap) {
  const widthBytes = Math.ceil(bitmap.width / 8);
  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    bitmap.height & 0xff, (bitmap.height >> 8) & 0xff,
  ]);
  const data = Buffer.alloc(widthBytes * bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (bitmap.bits[y * bitmap.width + x] === 0) {
        data[y * widthBytes + (x >> 3)] |= 0x80 >> (x % 8);
      }
    }
  }
  // 'binary' (latin1) round-trips byte values 0-255 through a JS string
  // unchanged, matching the encoding sendToNetworkPrinter writes with.
  return Buffer.concat([header, data]).toString('binary');
}

function logoEscPosBlock(receipt, width) {
  if (!receipt.storeLogo) return '';
  try {
    const bitmap = logoToBitmap(receipt.storeLogo, width === 32 ? 200 : 280);
    return center(bitmapToEscPosRaster(bitmap)) + '\n';
  } catch (e) {
    return ''; // Corrupt/unreadable logo — skip it rather than fail the print.
  }
}

function buildEscPosReceipt(receipt, width = 32) {
  let out = '';
  out += logoEscPosBlock(receipt, width);
  out += center(bold(receipt.storeName) + '\n');
  if (receipt.storeAddress) out += center(receipt.storeAddress + '\n');
  if (receipt.storePhone) out += center(receipt.storePhone + '\n');
  if (receipt.storeTin) out += center(`TIN: ${receipt.storeTin}` + '\n');
  out += line(width);
  out += `Receipt: ${receipt.saleNumber}\n`;
  out += `Date: ${receipt.createdAt}\n`;
  out += `Cashier: ${receipt.cashierName}\n`;
  if (receipt.tableName) out += `Table: ${receipt.tableName}\n`;
  if (receipt.customerName) out += `Customer: ${receipt.customerName}\n`;
  out += line(width);
  for (const item of receipt.items) {
    out += `${item.name}\n`;
    const qtyPrice = `${item.qty} x ${item.price.toFixed(2)}`;
    out += padRow(qtyPrice, item.lineTotal.toFixed(2), width) + '\n';
  }
  out += line(width);
  out += padRow('Subtotal', receipt.subtotal.toFixed(2), width) + '\n';
  if (receipt.discountTotal) out += padRow(discountLabel(receipt), '-' + receipt.discountTotal.toFixed(2), width) + '\n';
  if (receipt.vatExemptTotal) out += padRow('VAT-Exempt Sales', receipt.vatExemptTotal.toFixed(2), width) + '\n';
  if (receipt.taxTotal) out += padRow('Tax', receipt.taxTotal.toFixed(2), width) + '\n';
  // Bold the finished, already-padded row rather than bolding each piece —
  // bold() wraps text in invisible ESC/POS control bytes, and padRow()
  // measures plain .length, so padding pieces that are already bolded eats
  // the padding budget on bytes that take zero space on the printed paper.
  out += bold(padRow('TOTAL', receipt.total.toFixed(2), width)) + '\n';
  out += line(width);
  for (const p of receipt.payments) {
    out += padRow(p.method.toUpperCase(), p.amount.toFixed(2), width) + '\n';
    if (p.changeGiven) out += padRow('Change', p.changeGiven.toFixed(2), width) + '\n';
  }
  if (receipt.discountType && receipt.discountType !== 'none') {
    out += line(width);
    out += `${receipt.discountType === 'senior' ? 'SC' : 'PWD'} ID#: ${receipt.discountIdNumber || ''}\n`;
    out += `Name: ${receipt.discountHolderName || ''}\n`;
  }
  out += line(width);
  out += center((receipt.footer || 'Thank you!') + '\n');
  out += cut();
  return out;
}

function sendToNetworkPrinter(target, data) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = target.split(':');
    const port = Number(portStr) || 9100;
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Printer connection timed out'));
    }, 5000);
    socket.connect(port, host, () => {
      socket.write(data, 'binary', () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
    });
    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function buildPlainTextReceipt(receipt, width = 32) {
  let out = '';
  const centerPlain = (t) => {
    const pad = Math.max(0, Math.floor((width - t.length) / 2));
    return ' '.repeat(pad) + t;
  };
  out += centerPlain(receipt.storeName) + '\n';
  if (receipt.storeAddress) out += centerPlain(receipt.storeAddress) + '\n';
  if (receipt.storePhone) out += centerPlain(receipt.storePhone) + '\n';
  if (receipt.storeTin) out += centerPlain(`TIN: ${receipt.storeTin}`) + '\n';
  out += line(width);
  out += `Receipt: ${receipt.saleNumber}\n`;
  out += `Date: ${receipt.createdAt}\n`;
  out += `Cashier: ${receipt.cashierName}\n`;
  if (receipt.tableName) out += `Table: ${receipt.tableName}\n`;
  if (receipt.customerName) out += `Customer: ${receipt.customerName}\n`;
  out += line(width);
  for (const item of receipt.items) {
    out += `${item.name}\n`;
    const qtyPrice = `${item.qty} x ${item.price.toFixed(2)}`;
    out += padRow(qtyPrice, item.lineTotal.toFixed(2), width) + '\n';
  }
  out += line(width);
  out += padRow('Subtotal', receipt.subtotal.toFixed(2), width) + '\n';
  if (receipt.discountTotal) out += padRow(discountLabel(receipt), '-' + receipt.discountTotal.toFixed(2), width) + '\n';
  if (receipt.vatExemptTotal) out += padRow('VAT-Exempt Sales', receipt.vatExemptTotal.toFixed(2), width) + '\n';
  if (receipt.taxTotal) out += padRow('Tax', receipt.taxTotal.toFixed(2), width) + '\n';
  out += padRow('TOTAL', receipt.total.toFixed(2), width) + '\n';
  out += line(width);
  for (const p of receipt.payments) {
    out += padRow(p.method.toUpperCase(), p.amount.toFixed(2), width) + '\n';
    if (p.changeGiven) out += padRow('Change', p.changeGiven.toFixed(2), width) + '\n';
  }
  if (receipt.discountType && receipt.discountType !== 'none') {
    out += line(width);
    out += `${receipt.discountType === 'senior' ? 'SC' : 'PWD'} ID#: ${receipt.discountIdNumber || ''}\n`;
    out += `Name: ${receipt.discountHolderName || ''}\n`;
  }
  out += line(width);
  out += centerPlain(receipt.footer || 'Thank you!') + '\n';
  return out;
}

// Kitchen tickets are intentionally price-free — just what to make. `label`
// distinguishes the kitchen's copy from the table/customer's copy when both
// are printed off the same order (see POST /:id/send-to-kitchen).
function buildKitchenTicketEscPos(ticket, width = 32, label = 'KITCHEN ORDER') {
  let out = '';
  out += center(bold(label) + '\n');
  out += center(bold(ticket.tableName) + '\n');
  out += line(width);
  out += `Order: ${ticket.saleNumber}\n`;
  out += `Time: ${ticket.createdAt}\n`;
  out += line(width);
  for (const item of ticket.items) {
    out += bold(`${item.qty} x ${item.name}`) + '\n';
    if (item.notes) out += `  Note: ${item.notes}\n`;
  }
  out += line(width);
  out += cut();
  return out;
}

// Z-Reading: end-of-shift cash reconciliation, for the same thermal printer
// receipts use — mirrors buildEscPosReceipt's store-header block so both
// look consistent coming off the same till.
function buildZReadingEscPos(data, width = 32) {
  let out = '';
  out += center(bold(data.storeName) + '\n');
  if (data.storeAddress) out += center(data.storeAddress + '\n');
  if (data.storePhone) out += center(data.storePhone + '\n');
  if (data.storeTin) out += center(`TIN: ${data.storeTin}` + '\n');
  out += line(width);
  out += center(bold('Z-READING') + '\n');
  out += line(width);
  out += `Staff: ${data.userName}\n`;
  out += `Opened: ${data.openedAt}\n`;
  out += `Closed: ${data.closedAt || '-'}\n`;
  out += line(width);
  out += padRow('Orders', String(data.saleCount), width) + '\n';
  out += padRow('Net Sales', data.netSales.toFixed(2), width) + '\n';
  for (const [method, amount] of Object.entries(data.byMethod || {})) {
    out += padRow(method.toUpperCase(), amount.toFixed(2), width) + '\n';
  }
  out += padRow('Refunds', '-' + data.refunds.toFixed(2), width) + '\n';
  out += line(width);
  out += padRow('Opening Cash', data.openingCash.toFixed(2), width) + '\n';
  out += padRow('Expected Cash', data.expectedCash.toFixed(2), width) + '\n';
  out += padRow('Counted Cash', (data.closingCash != null ? data.closingCash : 0).toFixed(2), width) + '\n';
  out += bold(padRow('Difference', (data.cashDiff != null ? data.cashDiff : 0).toFixed(2), width)) + '\n';
  out += line(width);
  out += cut();
  return out;
}

function buildKitchenTicketText(ticket, width = 32, label = 'KITCHEN ORDER') {
  let out = '';
  out += `${label}\n`;
  out += `${ticket.tableName}\n`;
  out += line(width);
  out += `Order: ${ticket.saleNumber}\n`;
  out += `Time: ${ticket.createdAt}\n`;
  out += line(width);
  for (const item of ticket.items) {
    out += `${item.qty} x ${item.name}\n`;
    if (item.notes) out += `  Note: ${item.notes}\n`;
  }
  out += line(width);
  return out;
}

module.exports = {
  buildEscPosReceipt, buildPlainTextReceipt, sendToNetworkPrinter,
  buildKitchenTicketEscPos, buildKitchenTicketText, buildZReadingEscPos,
};
