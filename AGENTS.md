# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

SELLA is an offline-first desktop POS (Point of Sale) system built as a pnpm monorepo. See `README.md` for full feature details and repo layout.

### Services

| Service | Port | How to start |
|---------|------|-------------|
| Fastify API | 3333 | `pnpm dev` in `packages/api` |
| Vite renderer (React) | 5173 | `pnpm run dev:renderer` in `apps/desktop` |
| Electron (full app) | N/A | See below |

No external services (databases, Docker, Redis) are required. SQLite is embedded via `better-sqlite3`.

### Running the API standalone

```
cd packages/api && pnpm dev
```

The API auto-creates its SQLite database at `packages/api/data/offline-pos.sqlite` in dev mode.

### Running the renderer in a browser (without Electron)

Start the API first, then:

```
cd apps/desktop && pnpm run dev:renderer
```

Open `http://localhost:5173` in Chrome. The React app connects to the API at `http://localhost:3333`. This is the fastest way to test UI changes without Electron overhead.

### Running with Electron (headless Linux)

Electron requires Xvfb on headless Linux. Start Xvfb, the API, then Electron:

```
Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99
```

The `dev-main.cjs` entry point requires `ts-node` (added as a dev dependency). Launch Electron with:

```
cd apps/desktop && VITE_DEV_SERVER_URL=http://localhost:5173 npx electron dev-main.cjs
```

Note: the `dev:main` script (`tsx watch src/main/index.ts`) does not work because `tsx` runs in Node.js context and cannot access Electron APIs. Use the `electron` binary with `dev-main.cjs` instead.

### Known issues

- `packages/api/src/server.ts` had a duplicate `const settingsRow` declaration (lines ~1717 and ~1752) causing both `tsc` and `tsx`/`esbuild` to fail. Fixed by renaming the second to `taxSettingsRow`.
- The Electron main process hardcodes `DB_PATH` to a Windows path (`C:\ProgramData\Sella\data\sella.db`). On Linux, the API spawned by Electron will fail to write there, but the standalone API uses a local `data/` directory.

### Build commands

See `README.md` "Build a Windows Installer" section. Summary:

```
pnpm -s --filter sella-api build
pnpm -s --filter @offline-pos/desktop build
```

### Linting / Testing

Root `pnpm lint` and `pnpm test` are placeholder stubs. No ESLint or test framework is configured.
