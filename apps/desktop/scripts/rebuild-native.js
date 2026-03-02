const { execSync } = require('child_process');
const path = require('path');

console.log('Rebuilding better-sqlite3 for Electron...');
try {
  execSync('npx electron-rebuild -f -w better-sqlite3', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: '0',
    },
  });
  console.log('✓ Native modules rebuilt successfully');
} catch (error) {
  console.error('✗ Failed to rebuild native modules:', error.message);
  process.exit(1);
}



