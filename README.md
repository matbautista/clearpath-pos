# Clear Path POS

A simple, locally-run, web-based Point of Sale system. It runs entirely on your own
computer (Mac, Windows, or Linux) — no cloud account, no internet connection required
for day-to-day use — and you use it by opening a page in your browser.

## What's included

- **Register**: tap product tiles or scan a barcode to build a sale, split/partial
  tender across cash, card, GCash, Maya, or other, automatic tax + change calculation.
- **Tables (order now, bill later)**: for restaurants — tap a table to open its tab,
  add items as the customer orders, hit **Send to Kitchen** to fire a round to the
  kitchen printer (or preview it on screen if none is configured) without charging
  anything yet, keep adding rounds as the meal goes on, then **Bill Out** when they're
  ready to pay. Per-item notes (e.g. "no onions") print on the kitchen ticket. Stock is
  deducted when a round is sent, not when it's paid, since the kitchen prepares on
  order.
- **Receipts**: browser printing (works with any printer, including most 58mm/80mm
  thermal receipt printers set as your system default printer), direct ESC/POS
  printing to a network thermal printer, and optional email receipts.
- **Inventory**: SKU/barcode catalog, categories, stock tracking, low-stock alerts,
  manual stock adjustments (restocks, counts).
- **Refunds & voids**: void a whole sale, or refund specific line items/quantities —
  stock is automatically restored.
- **Order Channels**: tag each sale as walk-in/dine-in or a delivery marketplace
  (FoodPanda, GrabFood, or any you add) with its own commission rate, so Reports can
  show gross vs. net (after-commission) revenue per channel.
- **Reports**: today/week/month revenue, order counts, top-selling products, sales
  history, plus a Metrics tab with revenue/order trend charts (daily, weekly, or
  monthly), revenue by channel, and customer analytics (top spenders, most orders,
  most consistent regulars).
- **Sales Archive**: once a calendar year is more than 2 years old, export it to a
  JSON file and move it out of the live database from **Settings** — keeps Reports
  fast on a database that's been running for years, without deleting anything.
  Archived years stay browsable (and downloadable) from the same page.
- **Cash Drawer / Z-Reading**: open a shift with a starting cash amount, and close it
  to get an end-of-day summary (cash/card/GCash/Maya totals, expected vs. counted
  cash, over/short).
- **Senior Citizen / PWD discount**: applies the mandatory 20% discount and VAT
  exemption (RA 9994 / RA 10754) from the register — tap **🎫 SC/PWD** in the cart,
  enter the OSCA/PWD ID number and cardholder name (required, and printed on the
  receipt), then uncheck any line items that don't qualify. The discount is computed
  on the VAT-exclusive price per the standard BIR formula.
- **Customers**: basic contact info, purchase history, loyalty points — managed from
  admin/manager accounts; cashiers can still attach an existing customer to a sale
  at checkout for loyalty points.
- **Staff accounts**: PIN login, three roles — cashier (Register, Tables, and their
  own Cash Drawer), manager (+ inventory, customers, reports, refunds, settings),
  admin (+ staff accounts). The first Admin and Cashier accounts are protected
  default accounts and can't be deactivated (though their PINs and names can still
  be changed) — add more staff accounts for real day-to-day logins.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer, on Mac, Windows, or Linux.

## Setup

```bash
npm install
npm start
```

The first run creates a local SQLite database in `data/pos.db` (seeded with a demo
admin/cashier login and a handful of sample products) and opens your browser to
`http://localhost:4000`. If your browser doesn't open automatically, open that
address yourself.

Default logins:
- **Admin**, PIN `1234`
- **Cashier**, PIN `0000`

Change these PINs (or add real staff) from **Staff** once logged in as Admin.

To stop the server, go back to the terminal window and press `Ctrl+C`.

## Configuration

Copy `.env.example` to `.env` to customize the port, session secret, and optional
email settings:

```bash
cp .env.example .env
```

- `PORT` — defaults to 4000.
- `SESSION_SECRET` — change this to any random string.
- `SMTP_*` — fill these in to enable "Email receipt" from the register. Leave blank
  to disable email receipts (browser and thermal printing still work either way).

Store name, address, phone, TIN, logo, receipt footer, tax rate, currency symbol, and
thermal printer settings are all editable from the **Settings** page in the app (no
restart needed). The logo appears on browser-printed and emailed receipts, and — if
your printer supports ESC/POS raster images — on thermal receipts too; print quality
and support for this varies by printer model, so a text-only receipt (no logo) is
always the safe fallback if yours doesn't render it well.

## Payments (cash, card, GCash, Maya)

This POS does not connect to a live payment network — there's no card network or
GCash/Maya merchant integration wired in, since that requires your own merchant
account/API credentials with your processor or Xendit/PayMongo/etc. Instead, keep
your existing card terminal or GCash/Maya QR code at the counter as usual, and use
this register to record which method was used (with an optional reference/approval
code) so it flows into your reports and end-of-day reconciliation.

## A note on BIR compliance

This app computes the Senior Citizen / PWD discount and VAT exemption correctly and
prints the ID number/name BIR expects on the receipt, but it is not an
accredited Cash Register Machine / Point-of-Sale (CRM/POS) system — actually issuing
BIR-compliant official receipts requires registering your specific setup with the BIR
and getting a Permit to Use. Check with your accountant or the BIR on what's required
for your business before relying on this for official receipts.

## Thermal receipt printers

- **USB printers**: share the printer as your OS's default/system printer, then use
  the "Print (browser)" button on the receipt — it opens a small, receipt-formatted
  print dialog.
- **Network (WiFi/Ethernet) printers**: most thermal printers accept raw ESC/POS
  data on port 9100. In **Settings**, turn on "Enable Thermal Printing" and enter the
  printer's address as `192.168.1.50:9100` (use your printer's actual IP). Then use
  "Print (thermal)" on the receipt to send directly to it — no drivers needed.
- **Kitchen printer** (restaurants): a separate network printer, configured
  independently in **Settings** under "Kitchen Printer" — set its own IP so it's not
  the same device as the customer-facing receipt printer. It's used automatically
  whenever staff hit "Send to Kitchen" on a table order.

## Data & backups

Everything (products, sales, customers, staff, settings) lives in a single file:
`data/pos.db`. To back up, just copy that file elsewhere while the app isn't running.
To start fresh, stop the server and delete `data/pos.db` (a new seeded one is created
on next start).

## Running on multiple registers / devices

The server listens on all network interfaces, so other devices on the same local
network (e.g. a tablet at a second counter) can use it too — no extra config needed.
Start the server on the main computer as usual, then on the other device's browser
visit `http://<that computer's local IP>:4000` (find the IP with `ipconfig` on
Windows or `ifconfig`/`ipconfig getifaddr en0` on Mac/Linux). Both devices share the
same inventory and sales data in real time. This still requires no internet
connection — only a local network (WiFi router or switch). If you don't want other
devices to reach it, run the server on a machine that's not on a shared network, or
add firewall rules to block the port from other devices.
