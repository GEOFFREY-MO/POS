# SELLA POS – User Guide

Complete guide to setting up and using SELLA Offline POS System.

Contact: mokamigeoffrey@gmail.com

---

## Table of Contents

1. [Installation](#1-installation)
2. [First-Time Setup](#2-first-time-setup)
3. [Logging In](#3-logging-in)
4. [Admin Guide](#4-admin-guide)
5. [Seller Guide](#5-seller-guide)
6. [Making a Sale](#6-making-a-sale)
7. [Processing Returns](#7-processing-returns)
8. [Inventory Management](#8-inventory-management)
9. [Customer Loyalty](#9-customer-loyalty)
10. [Receipts](#10-receipts)
11. [Analytics and Reports](#11-analytics-and-reports)
12. [Google Sheets Sync](#12-google-sheets-sync)
13. [Backup and Restore](#13-backup-and-restore)
14. [Settings and Configuration](#14-settings-and-configuration)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Installation

### System Requirements
- Windows 10 or later (64-bit)
- 4 GB RAM minimum
- 500 MB disk space
- No internet required (offline-first)

### Installing SELLA POS

1. Download `SELLA Offline POS – Setup.exe`
2. Double-click the installer
3. Follow the installation wizard:
   - Choose installation location (default recommended)
   - Select "Install for all users" if multiple users will use this PC
4. Click Install and wait for completion
5. Launch SELLA from the desktop shortcut or Start menu

### Data Storage Location
SELLA stores your business data at:
```
C:\ProgramData\Sella\data\sella.db
```
This location ensures your data survives app updates and reinstalls.

---

## 2. First-Time Setup

When you launch SELLA for the first time, the Setup Wizard guides you through initial configuration.

### Step 1: Business Information

| Field | Description | Example |
|-------|-------------|---------|
| Business Name | Your company name (appears on receipts) | Mama Njeri Shop |
| Logo Path | Optional path to logo image | C:\logo.png |
| PO Box | Postal address for receipts | P.O. Box 12345 |
| Town | Business location | Nairobi |
| Tel No | Contact phone number | 0712 345 678 |

### Step 2: Tax and Compliance

| Field | Description | Example |
|-------|-------------|---------|
| KRA PIN | Kenya Revenue Authority PIN | A123456789B |
| Return Policy | Policy text for receipts | Returns within 7 days with receipt |
| CU Serial No | Control Unit serial (if applicable) | CU12345 |
| CU Invoice No | Starting invoice number | INV001 |

### Step 3: Branch and Device

| Field | Description | Example |
|-------|-------------|---------|
| Branch Name | Location/branch identifier | Main Branch |
| Currency | Currency code | KES |
| Tax/VAT Rate | Default tax rate (decimal) | 0.16 |
| Device Name | This terminal's name | Till-1 |

### Step 4: Admin Account

| Field | Description | Example |
|-------|-------------|---------|
| Admin Name | Administrator username | Admin |
| Admin PIN | 4-digit secure PIN | 1234 |

Important: Remember your Admin PIN. You will need it to access admin features and reset employee PINs.

### Step 5: KPI Rules (Optional)

| Field | Description | Example |
|-------|-------------|---------|
| Points per extra value unit | KPI points for upselling | 0.1 |
| Points per service | KPI points per service sold | 1 |
| Bonus threshold | Points needed for bonus | 100 |
| Bonus points | Extra points at threshold | 10 |

### Step 6: Loyalty Configuration

| Field | Description | Example |
|-------|-------------|---------|
| Points rate | Points earned per KES spent | 0.01 (1 point per 100 KES) |
| Redeem rate | KES value per point redeemed | 1 |

### Step 7: Receipt Settings

| Field | Description | Example |
|-------|-------------|---------|
| Receipt Header | Custom header text | Welcome to our store! |
| Receipt Footer | Custom footer message | Thank you for shopping with us |
| Backup Path | Folder for database backups | C:\Backups\Sella |

Click "Save and continue" to complete setup.

---

## 3. Logging In

### Login Screen

1. Select your name from the employee dropdown
2. Enter your 4-digit PIN
3. Click "Login"

If login fails:
- Check that you selected the correct employee
- Verify your PIN is exactly 4 digits
- Contact Admin if you forgot your PIN

### Roles

| Role | Access |
|------|--------|
| Admin | Full access to all features |
| Seller | Sell, Returns, View Inventory, My Sales |

---

## 4. Admin Guide

As Admin, you have full control over the POS system.

### Navigation Menu (Admin)

- Dashboard: Analytics overview
- Sell: Point of sale
- Products: Inventory management
- Services: Service catalog
- Employees: Staff management
- Accounts: Daily accounts and exports
- Reports: Detailed reports
- Admin: Settings and configuration

### Adding Employees

1. Go to Admin page
2. Scroll to "Add Employee" section
3. Fill in:
   - Name: Employee's display name
   - Role: Select "seller" or "admin"
   - PIN: 4-digit PIN for login
   - Active: Toggle on/off
4. Click "Add Employee"

### Resetting Employee PINs

1. Go to Admin page
2. Find the employee in the list
3. Click "Reset PIN" button
4. Enter new 4-digit PIN
5. Click "Reset"

The employee can now log in with the new PIN.

### Changing Your Own PIN

1. Go to Admin page
2. Find "Change Admin PIN" section
3. Enter current PIN
4. Enter new PIN
5. Click "Change PIN"

---

## 5. Seller Guide

As a Seller, you focus on sales and customer service.

### Navigation Menu (Seller)

- Sell: Make sales
- Returns: Process customer returns
- Products: View inventory (read-only)
- Services: View services (read-only)
- My Sales: Your sales history

### Your Dashboard

The Sell page is your primary workspace showing:
- Product/Service selection
- Cart with current items
- Payment options
- Receipt generation

---

## 6. Making a Sale

### Adding Products to Cart

Method 1: Click to Add
1. Browse products in the grid
2. Click on a product to add it
3. Quantity defaults to 1

Method 2: Search
1. Type product name in search box
2. Click the matching product

Method 3: Barcode Scan
1. Use USB barcode scanner
2. Scan product barcode
3. Product adds automatically with beep sound

### Adding Services to Cart

1. Click "Service" tab
2. Browse or search services
3. Click to add
4. Enter final price (services have dynamic pricing)

### Adjusting Cart Items

For each item in cart you can:
- Change quantity: Edit the Qty field
- Adjust price: Edit the Final price field (cannot go below base for products)
- Add discount/increase: Use the Adjust field (negative = discount)
- Add note: Type in the Note field
- Remove: Click "Remove" button

### Processing Payment

1. Review cart totals:
   - Extra value (upsell amount)
   - Total amount due
   - Amount paid
   - Change due

2. Select payment method:
   - Cash: Enter cash amount received
   - Till (M-Pesa): Enter amount and optional reference
   - Bank: Enter amount and optional reference
   - Split: Combine multiple payment types

3. Quick payment buttons:
   - "Cash exact": Sets cash to exact total
   - "Cash +50": Adds 50 to total
   - "Cash +100": Adds 100 to total

4. For split payments:
   - Enter amount for each payment type
   - Total must equal or exceed amount due

5. Click "Complete Sale"

### Adding Customer for Loyalty

1. Enter customer phone number in lookup field
2. System shows available points
3. Enter points to redeem (optional)
4. Points earned appear after sale

### After Sale

- Receipt displays automatically
- Click "Print" to print receipt
- Click "Download PDF" for digital copy
- Cart clears for next sale

---

## 7. Processing Returns

Sellers can process returns for products.

### Creating a Return

1. Go to Returns page
2. Select the product being returned
3. Enter quantity
4. Enter reason for return
5. Toggle "Restock" if item goes back to inventory
6. Click "Process Return"

### Return Effects

- If restocked: Product quantity increases
- Inventory movement logged
- Audit trail created
- Return appears in returns list

---

## 8. Inventory Management

### Viewing Products (All Users)

1. Go to Products page
2. Browse product list
3. See stock levels, prices, barcodes
4. Low stock items highlighted in red

### Adding Products (Admin Only)

1. Go to Products page
2. Fill in product details:
   - Name: Product name
   - Barcode: Unique barcode (optional)
   - Category: Product category
   - Cost Price: What you pay
   - Base Price: Minimum selling price
   - Tax Rate: Product tax rate
   - Stock Qty: Initial stock
   - Low Stock Alert: Alert threshold
   - Expiry Date: Optional expiry

3. Click "Add Product"

### Editing Products (Admin Only)

1. Find product in list
2. Click on editable fields
3. Make changes
4. Changes save automatically

### Bulk Import (Admin Only)

1. Prepare CSV file with columns:
   - name, barcode, category, costPrice, basePrice, taxRate, stockQty, lowStockAlert

2. Go to Products page
3. Click "Import CSV"
4. Select your file
5. Review and confirm

### Stock Adjustments (Admin Only)

1. Find product in list
2. Edit the Stock Qty field
3. Change logs to inventory movements
4. Audit trail created

### Low Stock Alerts

Products show red highlight when:
- Stock quantity is at or below low stock alert level
- Optional beep sound plays (configurable in Admin)

---

## 9. Customer Loyalty

### How Points Work

- Customers earn points on purchases
- Points rate set by Admin (e.g., 1 point per 100 KES)
- Points can be redeemed for discounts
- Redeem rate set by Admin (e.g., 1 KES per point)

### Earning Points

1. During sale, enter customer phone
2. Complete the sale
3. Points automatically credited to customer

### Redeeming Points

1. Enter customer phone in lookup field
2. System shows available points
3. Enter points to redeem
4. Amount deducted from total
5. Remaining points shown on receipt

### Viewing Customer Points (Admin)

- Customer records stored in database
- Points balance tracked per phone number
- Loyalty transactions logged

---

## 10. Receipts

### Receipt Contents

Header:
- Business name and branch
- PO Box, Town, Tel
- Date and time
- Transaction number

Body:
- Item code, description, quantity
- Unit price and extended price
- Subtotals

Payment:
- Payment method(s)
- Amount tendered (cash/till/bank breakdown)
- Change given

Tax:
- Tax code and rates
- Vatable amounts
- VAT amounts

Footer:
- Total items and weights
- Served by (employee name)
- Till number
- Customer info (if provided)
- Points earned/redeemed
- KRA PIN
- Return policy
- CU Serial and Invoice numbers

### Printing Receipts

1. After completing sale, receipt displays
2. Click "Print" button
3. Select your thermal printer
4. Receipt prints in 58-80mm format

### Saving as PDF

1. After completing sale, receipt displays
2. Click "Download PDF"
3. Choose save location
4. PDF saved for records

---

## 11. Analytics and Reports

Admin-only access to business insights.

### Dashboard Charts

Sales Trends:
- Daily, weekly, monthly sales totals
- Visual line chart

Profit Trends:
- Gross profit over time
- Based on cost vs selling prices

Payment Distribution:
- Cash vs Till vs Bank breakdown
- Stacked area chart

Top Performers:
- Best-selling products
- Best-selling services
- Best-selling categories

Low Stock:
- Products needing restock
- Current vs alert levels

### Accounts Page

Daily Accounts:
- Table of sales by day
- Totals for cash, till, bank
- Grand totals

Export:
- Click "Export CSV"
- Opens in Excel or Google Sheets
- Use for accounting and analysis

### Reports Page

Detailed reports including:
- KPI reports
- Extra value analysis
- Date range filtering

---

## 12. Google Sheets Sync

Sync your data to Google Sheets for external analysis.

### Setting Up Sync

1. Create a Google Sheet
2. Copy the sheet URL
3. Go to Admin page
4. Paste URL in "Google Sheet URL" field
5. Click "Save link"

### Manual Sync

1. Go to Admin page
2. Click "Push to Sheets (queue)"
3. Data queued for sync
4. Status shows in queue list

### Auto Sync

1. Enable "Auto-sync every 5 min" checkbox
2. System automatically syncs when online
3. Works in background

### What Gets Synced

- Sales and sale items
- Products and inventory
- Returns
- Employees
- Branches and devices
- Inventory movements
- Customers

### Sync Queue

View sync status:
- Green: Success
- Amber: Retrying
- Red: Failed

Failed syncs retry automatically with increasing delays:
- 1st retry: 5 seconds
- 2nd retry: 15 seconds
- 3rd retry: 30 seconds
- 4th retry: 1 minute
- 5th retry: 2 minutes

---

## 13. Backup and Restore

### Creating a Backup

1. Go to Admin page
2. Find "Backups" section
3. Click "Backup now"
4. Backup saved to configured folder

### Backup Location

Default: The path you set during setup
Backup files named with timestamp

### Restoring Data

To restore from backup:
1. Close SELLA
2. Navigate to `C:\ProgramData\Sella\data\`
3. Replace `sella.db` with your backup file
4. Rename backup to `sella.db`
5. Restart SELLA

---

## 14. Settings and Configuration

### Accessing Settings

Admin page contains all configuration options.

### Business Settings

Update via Setup or direct database:
- Business name
- Contact information
- Receipt text
- Tax rates

### Alert Settings

In Admin page:
- Low-stock sound alert (toggle on/off)
- Plays beep when products fall below threshold

### Sync Settings

In Admin page:
- Google Sheet URL
- Auto-sync toggle

### Theme

- Click moon/sun icon in top bar
- Toggles between light and dark mode
- Preference saved automatically

---

## 15. Troubleshooting

### Cannot Log In

Problem: PIN rejected
Solutions:
1. Verify correct employee selected
2. Check PIN is exactly 4 digits
3. Ask Admin to reset your PIN
4. Check if account is active

### Blank Screen on Launch

Problem: App shows white/blank screen
Solutions:
1. Wait 10-15 seconds for API to start
2. Close and reopen the app
3. Check Windows Event Viewer for errors
4. Reinstall if problem persists

### Barcode Scanner Not Working

Problem: Scans not registering
Solutions:
1. Ensure scanner is in USB HID mode
2. Focus must be on the app window
3. Check product has matching barcode in system
4. Try manual product search

### Receipt Not Printing

Problem: Print button does nothing
Solutions:
1. Check printer is connected and powered
2. Verify printer selected in Windows
3. Try "Download PDF" as alternative
4. Check printer paper loaded

### Sync Failing

Problem: Google Sheets sync errors
Solutions:
1. Check internet connection
2. Verify Sheet URL is correct and accessible
3. Check sync queue for error messages
4. Wait for automatic retry

### Low Stock Alert Not Sounding

Problem: No beep on low stock
Solutions:
1. Check "Low-stock sound alert" is enabled in Admin
2. Verify computer sound is not muted
3. Check low stock threshold is set on products

### Data Recovery

Problem: Need to recover data
Solutions:
1. Check backup folder for recent backups
2. Database located at `C:\ProgramData\Sella\data\sella.db`
3. Do not delete ProgramData folder during uninstall

### Starting Fresh

To completely reset the system:
1. Go to Admin page
2. Click "Start fresh (Reset DB)"
3. Type RESET to confirm
4. All data will be deleted
5. Setup wizard will appear

---

## Quick Reference

### Keyboard Shortcuts

| Action | Key |
|--------|-----|
| Search products | Type in search box |
| Add to cart | Click product |
| Focus cart | Tab through fields |

### Daily Workflow

Morning:
1. Log in with your PIN
2. Verify cash drawer float
3. Check low stock alerts

During Day:
1. Process sales
2. Handle returns as needed
3. Check inventory periodically

End of Day:
1. Go to Accounts page
2. Review daily totals
3. Export CSV if needed
4. Run backup (Admin)
5. Log out

### Common Tasks

| Task | Location |
|------|----------|
| Make a sale | Sell page |
| Check stock | Products page |
| Process return | Returns page |
| Add employee | Admin page |
| View reports | Dashboard / Reports |
| Backup data | Admin page |
| Sync to Sheets | Admin page |

---

## Support

For assistance:
- Email: mokamigeoffrey@gmail.com
- Check README.md for technical details
- Review audit logs for transaction history

---

Version: 1.0
Last Updated: January 2026









