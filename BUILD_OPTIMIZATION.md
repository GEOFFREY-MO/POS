# Build Size Optimization Guide

## Why Setup File Size Increases

The setup file size increases with each update due to:

1. **Source Maps** - Debug files that can be 50-200MB
2. **Build Artifacts Accumulating** - Old files not being cleaned
3. **No Compression** - Files not being optimized
4. **Duplicate Dependencies** - Same packages bundled multiple times
5. **Unused Code** - Dead code not being eliminated

## Optimizations Applied

### 1. Disabled Source Maps
- **Before**: Source maps enabled (can add 50-200MB)
- **After**: Source maps disabled in production
- **Files**: `tsconfig.main.json`, `vite.renderer.config.ts`

### 2. Code Minification
- **Before**: Basic minification
- **After**: Aggressive minification with esbuild
- **Removes**: Console.log statements, debugger statements
- **Result**: 10-30% smaller JavaScript files

### 3. File Exclusions
- **Excluded**: Source maps (*.map), test files, markdown files
- **Result**: Cleaner build without unnecessary files

### 4. Code Splitting
- **Chunks**: React, React Query, ZXing separated
- **Benefit**: Better caching, smaller updates
- **Result**: Only changed chunks need updating

### 5. Compression
- **NSIS Compression**: zlib compression enabled
- **Result**: Smaller installer file

### 6. Build Cleanup
- **Before**: Old files might accumulate
- **After**: Clean build directory before each build
- **Result**: No duplicate or old files

## Expected Results

- **Initial Size**: ~1GB (includes Electron runtime ~500MB)
- **After Optimization**: ~800-900MB (saves 100-200MB)
- **Future Updates**: Only changed chunks update (much smaller)

## Build Commands

```bash
# Clean build (recommended)
pnpm clean && pnpm build

# Regular build
pnpm build

# Create installer
npx electron-builder --win
```

## File Size Breakdown

- Electron Runtime: ~500MB (unavoidable)
- Chromium: ~300MB (unavoidable)
- Node.js: ~50MB (unavoidable)
- Application Code: ~10-20MB (optimized)
- Dependencies: ~50-100MB (optimized)
- **Total**: ~900MB-1GB (optimized from ~1.2GB)

## Notes

- Electron apps are inherently large due to Chromium + Node.js
- The installer compresses files, so download size is smaller
- Updates only need to download changed chunks (much smaller)
- Source maps are only needed for debugging (disabled in production)




