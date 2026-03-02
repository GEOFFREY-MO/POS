# Testing the New Optimized Scanner Version

## Option 1: Test Without Uninstalling (Recommended)

This method lets you test the new version side-by-side with your installed version.

### Step 1: Build the New Version

Open PowerShell in the project root (`C:\POS`) and run:

```powershell
# Build the API
cd packages\api
pnpm build
cd ..\..

# Build the desktop app
cd apps\desktop
pnpm build
```

### Step 2: Run the New Version Directly

After building, you can run the new version directly from the unpacked folder:

```powershell
# Navigate to the unpacked build folder
cd apps\desktop\dist\build\win-unpacked

# Run the executable
.\"SELLA – Offline POS System.exe"
```

**Note:** The new version will use the **same database** (`C:\ProgramData\Sella\data\sella.db`) as your installed version, so:
- ✅ All your data will be available
- ✅ You can test the scanner with real products
- ⚠️ Both versions share the same database (they won't conflict, but changes in one will appear in the other)

### Step 3: Test the Optimized Scanner

1. **Open the Sell page** in the new version
2. **Test scanner performance:**
   - Scan a barcode → Should focus and detect **very quickly** (no lag)
   - Scan the same barcode quickly → Should only add once (3-second cooldown)
   - Scan different barcodes → Should add immediately
   - Test in low light → Should still work well
   - Test with Iriun/external camera → Should work smoothly

3. **Compare with old version:**
   - The new version should be noticeably faster
   - No lag during scanning
   - Faster autofocus

---

## Option 2: Create a Fresh Installer (For Full Testing)

If you want to create a new installer to replace the old version:

### Step 1: Build Everything

```powershell
# From project root (C:\POS)
cd packages\api
pnpm build
cd ..\..

cd apps\desktop
pnpm build
```

### Step 2: Create the Installer

You'll need to configure electron-builder. For now, you can test using Option 1 above.

---

## Option 3: Development Mode (Fastest Testing)

For the fastest testing cycle with hot reload:

```powershell
# From project root
cd apps\desktop
pnpm dev
```

This will:
- Start the app in development mode
- Auto-reload when you make changes
- Show developer tools for debugging

**Note:** Development mode uses the same database, so your data is safe.

---

## What to Test

### Scanner Performance Tests:

1. **Speed Test:**
   - ✅ Scanner should start immediately
   - ✅ Camera should focus within 1-2 seconds
   - ✅ No lag when scanning

2. **Accuracy Test:**
   - ✅ Scan same barcode fast → Only adds once
   - ✅ Wait 3+ seconds → Can scan same barcode again
   - ✅ Different barcodes → Add immediately

3. **Low Light Test:**
   - ✅ Scanner works in dim light
   - ✅ Flashlight toggle works (if camera supports it)

4. **External Camera Test:**
   - ✅ Works with Iriun camera
   - ✅ Works with USB webcams
   - ✅ Camera selection dropdown works

### Expected Improvements:

- ⚡ **Faster focus** - Camera should focus almost instantly
- ⚡ **No lag** - Scanning should be smooth, no stuttering
- ⚡ **Faster detection** - Barcodes detected within 200-500ms
- ⚡ **Smoother UI** - No freezing or lag during scanning

---

## Troubleshooting

### If the new version doesn't start:

1. Make sure you built it first:
   ```powershell
   cd apps\desktop
   pnpm build
   ```

2. Check if the executable exists:
   ```powershell
   Test-Path "apps\desktop\dist\build\win-unpacked\SELLA – Offline POS System.exe"
   ```

3. Check for errors in the console when running

### If scanner still lags:

1. Check camera permissions
2. Try a different camera (use the camera selector dropdown)
3. Check if other apps are using the camera

---

## Quick Test Checklist

- [ ] New version builds successfully
- [ ] App starts without errors
- [ ] Scanner opens on Sell page
- [ ] Camera focuses quickly (< 2 seconds)
- [ ] Scanning is smooth (no lag)
- [ ] Same barcode cooldown works (3 seconds)
- [ ] Different barcodes add immediately
- [ ] Low light scanning works
- [ ] External camera (Iriun) works

---

## After Testing

If the new version works well, you can:
1. Keep using the unpacked version (Option 1)
2. Or create a new installer to replace the old version

Your data is safe - both versions use the same database location.




