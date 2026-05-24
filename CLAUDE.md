# turso-loader — Claude Context

## Directory Structure

```
turso/
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

For API usage, setup, and deployment, see README.md.

**Always `await` every DB operation.** `prepare()` is synchronous, but `run()` / `get()` / `all()` are async. A missing `await` surfaces as a misleading "no such table" error.

## COOP/COEP Headers

Use `credentialless`, not `require-corp` — `require-corp` blocks CDN resources (fonts, etc.).
