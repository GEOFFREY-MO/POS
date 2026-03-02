# SELLA – Offline POS System

Sell smart. Work offline.

Contact: mokamigeoffrey@gmail.com

SELLA is a production offline-first desktop POS for small businesses. It runs entirely on a Windows PC without cloud dependencies: the Electron app starts a local Fastify API and stores data in SQLite.

For complete setup and usage instructions, see the [User Guide](USERGUIDE.md).

Stack: Electron + React + TypeScript + Tailwind, Fastify local API, SQLite (better-sqlite3), Vite, pnpm, Electron Builder (NSIS).

## Repo Layout
```
apps/
  desktop/            # Electron host + preload + React renderer
    src/main/         # Electron main process (windows, IPC, updater)
    src/preload/      # Safe IPC bridge
    src/renderer/     # React UI
      styles/         # Tailwind entry
packages/
  api/                # Local Fastify API (SQLite)
  db/                 # Schema reference
```

## Key Design Choices
- Offline-first: all business data is local in SQLite.
- Electron desktop app starts the API automatically and talks to it via `http://localhost:3333`.
- No browser `prompt()` flows; critical confirmations use in-app modals (works in packaged builds).
- Minimal UI: clean typography, clear actions, fast cashier flow.

## First-Time Setup Wizard
On first launch SELLA guides you through setup including:
- Business name, branch, device
- Receipt fields (PO Box, town, tel, KRA PIN, return policy)
- CU Serial/Invoice numbers
- Backup folder path
- Admin PIN (hashed with scrypt)
- KPI rules for employee performance
- Loyalty points configuration (earn rate, redeem rate)

After setup:
- Admin adds employees with 4-digit PINs
- Employees log in and sell
- Role-based access enforced throughout

## Core Features

### Roles and Security
- Admin and Seller roles fully separated
- Server-side route protection (requireAdmin middleware)
- Client-side navigation guards
- PIN hashing with scrypt and salt
- Token signing with HMAC-SHA256
- Admin can reset employee PINs
- Employees cannot access admin pages

### Sell Page
- Clean cashier-first interface
- Products and services in unified flow
- Quantity adjustments per line
- Base price enforcement for products
- Dynamic pricing for services
- Cart with real-time totals
- Quick payment buttons (exact, +50, +100)

### Payments
- Cash, M-Pesa/Till, Bank transfer
- Split payments (combine multiple methods)
- Payment reference capture
- Change calculation
- Tendered amount validation (blocks sale if insufficient)

### Barcode Scanning
- USB/camera barcode support via ZXing
- Beep sound on successful scan (880Hz)
- 3-second lock to prevent duplicates
- Visual highlight of scanned product
- Quick add-to-cart flow

### Inventory Management
- Products with categories, stock tracking, expiry dates
- Barcode uniqueness validation
- Low-stock alerts (visual highlight + optional sound)
- Bulk low-stock threshold setting
- Admin-only stock adjustments
- Inventory movements audit table

### Services
- Service categories
- Cost price for profit calculation
- Suggested pricing
- KPI eligibility flag

### Receipts
- Thermal format (58-80mm width)
- Business info header (name, branch, PO Box, town, tel)
- KRA PIN display
- Items with code, description, qty, price, extended
- Tax details breakdown
- Payment method and split display
- Tendered amount and change
- Customer name and phone (if provided)
- Loyalty points earned/redeemed
- Return policy footer
- CU Serial and Invoice numbers
- Print and PDF download

### Customer Loyalty
- Optional customer phone/name capture
- Points earned per sale (configurable rate)
- Points redemption at checkout
- Customer points balance lookup
- Loyalty transactions logged
- Admin configures earn/redeem rates
- Sellers can apply but not change rules

### Analytics Dashboard (Admin only)
- Sales trends (daily/weekly/monthly)
- Top-selling products, services, categories
- Payment method distribution (cash/till/bank)
- Low-stock items panel
- Profit trends
- Dark mode compatible charts

### Google Sheets Sync
- Admin configures Google Sheet URL
- Syncs: sales, sale_items, products, returns, sellers, branches, devices, inventory_movements, customers
- Offline queue for pending syncs
- Auto-sync every 5 minutes (optional toggle)
- Exponential backoff retry (5s, 15s, 30s, 60s, 120s)
- Max 5 retry attempts
- Sync status and queue display

### Audit and Compliance
- Inventory movements table (sale, add, adjustment, damage, return, initial)
- Audit logs table for sensitive actions
- Logged actions: sales, product add/edit, price changes, employee add/edit, PIN reset/change, settings changes, returns
- Admin-only access to audit logs

### Returns
- Seller-initiated returns
- Reason capture required
- Optional restock toggle
- Stock automatically updated if restocked
- Inventory movement logged
- Audit trail maintained

### Accounts
- Daily accounts table
- CSV export for external analysis
- Branch filtering

### Employee Management (Admin only)
- Add/edit employees
- Set 4-digit PINs
- Activate/deactivate accounts
- Role assignment (admin/seller)
- KPI tracking

### Dark Mode
- System-wide theme toggle
- All pages dark mode compatible
- Charts use theme-aware colors

### Backup
- Configurable backup folder
- One-click database backup
- Backup status display

## Database and Data Location
SELLA stores the SQLite database in a machine-wide folder so data survives app updates/uninstalls:
- DB path (default): `C:\ProgramData\Sella\data\sella.db`
- Auth secret: `C:\ProgramData\Sella\data\auth.secret`

This is by design for offline POS durability. Use Admin - Start fresh (Reset DB) when you want a clean setup.

## Build a Windows Installer
From the repo root:
```
pnpm -s --filter sella-api build
pnpm -s --filter sella-offline-pos build:win
```

Installer output:
- `apps/desktop/dist/build/SELLA Offline POS – Setup.exe`

## Database Schema (main tables)
- settings: business config, receipt fields, loyalty rates
- branches: multi-branch support
- devices: device registration per branch
- sellers: employees with roles and hashed PINs
- products: inventory with stock tracking
- services: service catalog
- sales: transaction records with payment details
- sale_items: line items per sale
- customers: customer registry with loyalty points
- loyalty_transactions: points earn/redeem history
- returns: return records
- kpi_rules: employee performance rules
- kpi_points: earned KPI per sale
- inventory_movements: stock change audit trail
- audit_logs: sensitive action audit trail
- sync_queue: Google Sheets sync queue with retry tracking
- sync_logs: sync history
- backup_logs: backup history

## Next Version (Roadmap)

### Sella AI (optional, offline)
- Bundle Ollama with the installer for fully offline AI
- Add a toggle in Settings: Enable Sella AI
- Provide an in-app chat called Sella AI focused on business decisions:
  - Best-selling categories/products and trends
  - Stock reorder suggestions based on sales velocity and low-stock thresholds
  - Profit insights and payment method mix
  - Simple natural-language reporting from local data

### Other Improvements Planned
- Deeper multi-branch sync and conflict resolution
- Faster cashier flow and more hardware integrations
- Stronger audit trail and role permissions
- Real Google Sheets API integration with OAuth
