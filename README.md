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
  JSON file and move it out of the live database from **Reports** — keeps Reports
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
  manager/waiter accounts; cashiers can still attach an existing customer to a sale
  at checkout for loyalty points.
- **Staff accounts**: PIN login, four roles — cashier (build and charge orders on
  Register/Tables, own Cash Drawer), waiter (build/send orders on Register/Tables,
  never charges, manages Customers), manager (view-only on Register/Tables/Cash
  Drawer; full access to Inventory, Customers, and Reports, including refunds/voids;
  can activate/deactivate staff), admin (full access to Inventory, Staff, and
  Settings; view-only everywhere else). The default account for each role is
  protected — it can't be deactivated or have its role changed (though its PIN and
  name can still be changed) — add more staff accounts for real day-to-day logins.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer, on Mac, Windows, or Linux.

## Setup

```bash
npm install
npm start
```

The first run creates a local SQLite database in `data/pos.db` (seeded with demo
admin/manager/cashier/waiter logins and a handful of sample products) and opens your
browser to `http://localhost:4000`. If your browser doesn't open automatically, open
that address yourself.

Default logins:
- **Admin**, PIN `826497`
- **Manager 1**, PIN `000000`
- **Cashier 1**, PIN `123456`
- **Waiter 1**, PIN `098765`

Each role also seeds a couple of extra starter accounts (Manager 2, Cashier 2,
Waiter 2-4) so you don't have to create logins from scratch for a small team — these
start **inactive**; turn them on from **Staff** once logged in as Admin.

Only the first account of each role (Admin, Manager 1, Cashier 1, Waiter 1) is a
protected default — its role is locked (it can't be turned into a Cashier, etc.), so
there's always at least one login for each role — but you can still change its PIN
and name, or add real staff, from **Staff**.

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

## Deploying on Windows

A common setup: the server runs on a Windows desktop, and staff use it from a tablet
over the same WiFi/LAN (see [Running on multiple registers / devices](#running-on-multiple-registers--devices)
above for the browser side).

### Automated setup (recommended for a non-technical person doing the install)

Copy this whole project folder onto the Windows desktop, then open
`scripts/windows/` and follow `READ ME FIRST.txt` — it comes down to
right-clicking `Install-ClearPathPOS.bat` and choosing "Run as administrator".
No commands need to be typed. The script installs Node.js if missing, runs
`npm install`, generates a `.env` with a random session secret, opens the
firewall for the app's port, disables sleep on AC power, installs the app as
a PM2 service that auto-starts on boot, adds a desktop shortcut, and finishes
with a popup showing the address to use on the tablet. It's safe to re-run if
anything fails partway (e.g. no internet mid-download). `Show-Tablet-Address.bat`
in the same folder can be re-run any time later to look up that address again.

### Updating to a newer version

Double-click `Update-ClearPathPOS.bat` in `scripts/windows/` (no Administrator
prompt needed for this one). It pulls the latest code from GitHub, reinstalls
dependencies, and restarts the app. `data/pos.db` and `.env` are never touched —
the first run also takes a quick backup copy of `data/pos.db` into
`data/backups/` before doing anything else, just in case.

If this install was set up by copying the folder by hand rather than with
`git clone`, the first update run turns it into a proper git checkout of the
same GitHub repo (installing Git for Windows automatically if it's missing) so
this and future updates are simple from then on. Only files tracked in the
repo get overwritten — `data/`, `.env`, and `node_modules/` are all gitignored
and are left exactly as they are.

### Manual setup

The app itself needs nothing Windows-specific — `npm install && npm start` works
the same as on Mac/Linux — but a few things are worth setting up deliberately so
the server is actually there when the restaurant needs it (this is exactly what
the automated script above does; only follow these steps by hand if you'd rather
not run it, or want to understand/customize what it's doing):

- **Install Node.js.** Get the LTS installer from [nodejs.org](https://nodejs.org)
  (18 or newer). Then run `npm install` once from the project folder in a Command
  Prompt or PowerShell window — this also compiles/fetches the one native dependency
  (`better-sqlite3`). It ships prebuilt binaries for Windows, so this normally just
  works, but it's worth doing this step once on the actual machine you'll deploy to
  rather than assuming it behaves the same as on Mac.
- **Allow it through Windows Firewall.** The first time you run `npm start`, Windows
  will prompt to allow Node.js network access — allow it for **Private networks**
  (not Public). If you don't get prompted (or blocked it by mistake), add it manually
  under *Windows Defender Firewall → Allow an app through firewall*.
- **Keep the machine awake.** If Windows sleeps, or locks in a way that suspends
  background processes, the server goes down mid-shift and every tablet loses
  connection. Under *Settings → System → Power*, set sleep to **Never** while
  plugged in. It's fine for the display to turn off — only the sleep/suspend state
  matters.
- **Start the server automatically.** Right now, someone has to open a terminal and
  run `npm start` after every reboot. Two options, depending on how hands-off you
  want it:
  - **Simple**: put a shortcut to a `.bat` file (containing `cd /d C:\path\to\app`
    then `npm start`) in the Startup folder
    (`shell:startup` in the Run dialog) — it launches automatically whenever that
    user logs in.
  - **More robust**: run it as a background service with [PM2](https://pm2.keymetrics.io/),
    which restarts the app automatically if it ever crashes and can start before
    anyone logs in:
    ```
    npm install -g pm2 pm2-windows-startup
    pm2-startup install
    pm2 start server/index.js --name clearpath-pos
    pm2 save
    ```
- **Give the desktop a stable local IP.** By default a router can hand out a
  different IP after a reboot, which breaks whatever URL the tablet has bookmarked.
  Set a DHCP reservation for the desktop's MAC address in your router's admin page
  (or assign it a static IP), so `http://<ip>:4000` always points to the same place.
- **Back up `data/pos.db` on a schedule.** See [Data & backups](#data--backups) above
  for what's in it. On Windows, Task Scheduler can run a daily copy command (e.g.
  `robocopy` to an external drive or network share) without anyone remembering to do
  it by hand.
- **On the tablet**, just open a browser to `http://<desktop-ip>:4000` — no app
  install needed. Chrome and Edge both support "Add to Home screen," which gives it
  an app-like icon and launches full-screen without browser chrome, closer to a
  dedicated POS terminal.
