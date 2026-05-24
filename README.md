# turso-loader

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A library for running [Turso](https://turso.tech/) (SQLite-compatible in-process DB) in the browser.

- Self-hosted WASM with version management (no CDN required)
- Saves the active version to localStorage — existing users are not auto-upgraded when the library updates
- WASM caching via Service Worker (offline support, no re-download on revisit)
- Optional schema initialization and storage permission request

[日本語](README.ja.md)

## Requirements

- **Browser:** Chrome 92+, Firefox 79+, Safari 15.2+, Edge 92+
- **Protocol:** HTTP server required — does not work with `file://`
- **Production:** HTTPS required (SharedArrayBuffer and Service Worker both need a secure context)
- **Headers:** `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` must be set on pages that use this library — required for SharedArrayBuffer, which Turso's WASM threads depend on. Do not apply site-wide; see [Deployment](#deployment) for details and risks.

---

## File Structure

```
turso/
├── serve.json              Local dev server config (COOP/COEP + Service-Worker-Allowed)
├── package.json            WASM package management
├── scripts/
│   └── copy-wasm.js        postinstall: copies WASM to public/turso-wasm/
├── public/                 Library root (deploy target)
│   ├── turso-db.js         TursoLoader class
│   ├── turso-sw.js         Generic Service Worker (configured via URL params)
│   └── turso-wasm/
│       ├── v0.6.0/main.es.js
│       └── v0.6.1/main.es.js
└── demo/
    └── demo.html           TODO app (reference implementation)
```

---

## Setup

```bash
npm install
# → WASM is placed under public/turso-wasm/v0.6.0/ and public/turso-wasm/v0.6.1/
```

## Local Development

```bash
npx serve . -p 3000
# → http://localhost:3000/demo/demo.html
```

> Does not work with `file://`. Always open via an HTTP server.

---

## TursoLoader API

```js
import { TursoLoader } from '/public/turso-db.js';
```

### `TursoLoader.connect(dbName, options)` → `db`

Connects to the DB, initializes the schema, and returns the raw Turso `db` object.

```js
const db = await TursoLoader.connect('myapp.db', {
  version: '0.6.1',               // default: saved localStorage value → #DEFAULT_VERSION
  requestStoragePermission: true,  // calls navigator.storage.persist()
  schema: [
    `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
  ],
  allowExisting: true,             // auto-adds IF NOT EXISTS (default: false)
});

// The return value is the raw Turso API
await db.prepare('INSERT INTO items (name) VALUES (?)').run('Hello');
const rows = await db.prepare('SELECT * FROM items').all();
const row  = await db.prepare('SELECT COUNT(*) AS n FROM items').get();
```

### `TursoLoader.loadVersion(version)` → `connectFn`

Loads only the WASM and returns the `connect` function (does not call `connect()`).

```js
const connectFn = await TursoLoader.loadVersion('0.6.1');
const db = await connectFn('myapp.db');
```

### `TursoLoader.registerVersion(version, path)`

Registers the path for an additional version. Path is relative to `turso-db.js`.

```js
TursoLoader.registerVersion('0.7.0', './turso-wasm/v0.7.0/main.es.js');
```

### `TursoLoader.getSavedVersion()` → `string`

Returns the version saved in localStorage. Falls back to `#DEFAULT_VERSION` if not saved or not in the registry.

### Version Pinning

When `connect()` succeeds, the active version is saved to localStorage. On subsequent visits this value takes priority — **existing users are not auto-upgraded even if `#DEFAULT_VERSION` changes.**

---

## Service Worker

`public/turso-sw.js` is a generic SW configured via URL parameters at registration time.

```js
const swParams = new URLSearchParams({
  shell: ['/myapp/index.html', '/public/turso-db.js'].join(','),
  wasm:  '/turso-wasm/',   // URL substring used to identify WASM fetches
  cache: 'myapp-v1',       // Cache Storage name (use a unique name per app)
});
navigator.serviceWorker.register(`/public/turso-sw.js?${swParams}`, { scope: '/' });
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `shell`   | URLs to pre-cache on install (comma-separated) | none |
| `wasm`    | URL substring to identify WASM fetches | `/turso-wasm/` |
| `cache`   | Cache Storage name | `turso-v1` |

Messages from the SW to the app:
- `{ type: 'UPDATE_DONE' }` — update complete
- `{ type: 'UPDATE_ERROR', message }` — update failed

---

## Change Data Capture (CDC)

CDC is supported in the browser WASM environment (verified with `@tursodatabase/database-wasm`). Enable it per connection with a PRAGMA immediately after `connect()`:

```js
const db = await TursoLoader.connect('myapp.db', { ... });
await db.prepare("PRAGMA capture_data_changes_conn('full')").run();
```

All subsequent INSERT / UPDATE / DELETE operations on that connection are automatically logged to the `turso_cdc` table:

| Column | Type | Description |
|--------|------|-------------|
| `change_id` | INTEGER | Auto-incremented ID |
| `change_time` | INTEGER | Unix timestamp |
| `change_txn_id` | INTEGER | Transaction ID |
| `change_type` | INTEGER | 1=INSERT, 0=UPDATE, -1=DELETE, 2=COMMIT |
| `table_name` | TEXT | Affected table |
| `before` | BLOB | Row state before change |
| `after` | BLOB | Row state after change |

```js
const changes = await db.prepare('SELECT * FROM turso_cdc ORDER BY change_id').all();
```

Available modes: `id` (rowid only), `before`, `after`, `full` (before + after). A custom table name can be appended: `'full,my_changes'`.

> **Note:** CDC cannot be used together with MVCC.

---

## Adding a WASM Version

1. Add to `dependencies` in `package.json`:

```json
"database-wasm-0.7.0": "npm:@tursodatabase/database-wasm@0.7.0"
```

2. Run `npm install` → `public/turso-wasm/v0.7.0/main.es.js` is generated automatically.

3. Add to `#registry` in `public/turso-db.js`:

```js
['0.7.0', './turso-wasm/v0.7.0/main.es.js'],
```

---

## Deployment

Copy `public/` and `demo/` (if used) to a static host.

**Required headers (pages using turso-loader only):**

```
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Embedder-Policy: credentialless
```

> **Warning:** Do not apply these headers site-wide. They affect cross-origin popup windows (e.g. OAuth) and strip credentials from cross-origin requests. Apply only to the pages that use this library.

**Required header (`public/turso-sw.js` only):**

```
Service-Worker-Allowed: /
```

nginx example:

```nginx
# Apply only to pages that use turso-loader
location = /your-app-page.html {
    add_header Cross-Origin-Opener-Policy  same-origin;
    add_header Cross-Origin-Embedder-Policy credentialless;
}

location = /public/turso-sw.js {
    add_header Service-Worker-Allowed /;
}
```
