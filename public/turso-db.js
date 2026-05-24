/**
 * TursoLoader — browser-side loader for Turso (SQLite-compatible) WASM bundles.
 *
 * Responsibilities:
 *  1. Maintain a registry of WASM bundle paths keyed by version string.
 *  2. Lazy-load and cache the `connect` function from each bundle so that the
 *     same WASM is not downloaded twice within a page session.
 *  3. Persist the last-used version in localStorage so future sessions stay on
 *     the same WASM even when #DEFAULT_VERSION is bumped in source.
 *  4. Run caller-supplied DDL statements to initialize the database schema.
 *
 * Usage — in-memory (data lost on reload):
 *   const db = await TursoLoader.connect(':memory:', {
 *     schema: ['CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL)'],
 *   });
 *   const rows = await db.prepare('SELECT * FROM todos').all();
 *
 * Usage — persistent (data survives page reload via Origin Private File System):
 *   const db = await TursoLoader.connect('myapp.db', {
 *     requestStoragePermission: true,   // ask browser not to evict the DB
 *     schema: ['CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL)'],
 *     allowExisting: true,              // safe to re-run DDL on every reload
 *   });
 *   await db.prepare('INSERT INTO todos (text) VALUES (?)').run('Hello');
 *   const rows = await db.prepare('SELECT * FROM todos').all();
 *   //
 *   // The named DB is stored in the browser's Origin Private File System (OPFS).
 *   // It persists across page reloads and browser restarts, scoped to the origin.
 *   // Data is lost only when the user clears site storage or the browser evicts it
 *   // (eviction is suppressed when requestStoragePermission succeeds).
 */
export class TursoLoader {
  // Map of version string → relative path to the ES module bundle.
  // Add entries here (or call registerVersion) when shipping a new WASM build.
  static #registry = new Map([
    ['0.6.0', './turso-wasm/v0.6.0/main.es.js'],
    ['0.6.1', './turso-wasm/v0.6.1/main.es.js'],
  ]);

  // In-memory cache: version string → the `connect` function returned by the bundle.
  // Prevents re-importing the same module on repeated calls within one page load.
  static #cache = new Map();

  // Fallback version used when localStorage has no saved preference.
  static #DEFAULT_VERSION = '0.6.1';

  // localStorage key under which the last-used version is persisted.
  static #STORAGE_KEY = 'turso-wasm-version';

  /**
   * Register a WASM bundle that was not baked into the source registry.
   * Call this before loadVersion/connect if you added a new version at runtime.
   *
   * @param {string} version - Semver string, e.g. '0.7.0'
   * @param {string} path    - URL or relative path to the ES module bundle
   */
  static registerVersion(version, path) {
    TursoLoader.#registry.set(version, path);
  }

  /**
   * Return the version string to use for the current session.
   *
   * The localStorage value always wins over #DEFAULT_VERSION so that bumping
   * the default in source never silently upgrades a user who has an older WASM
   * cached on their device. Falls back to #DEFAULT_VERSION when:
   *   - localStorage is unavailable (private browsing, cross-origin iframe), or
   *   - the saved version is no longer in the registry (e.g. after a cleanup).
   *
   * @returns {string}
   */
  static getSavedVersion() {
    try {
      const saved = localStorage.getItem(TursoLoader.#STORAGE_KEY);
      if (saved && TursoLoader.#registry.has(saved)) return saved;
      return TursoLoader.#DEFAULT_VERSION;
    } catch {
      return TursoLoader.#DEFAULT_VERSION;
    }
  }

  /**
   * Persist `version` in localStorage so future page loads reuse the same WASM.
   * Silently ignores storage errors (private browsing may block writes).
   *
   * @param {string} version
   */
  static saveVersion(version) {
    try {
      localStorage.setItem(TursoLoader.#STORAGE_KEY, version);
    } catch { /* private browsing may block storage */ }
  }

  /**
   * Import the WASM bundle for `version` and return its `connect` function.
   * The result is cached in memory so subsequent calls for the same version
   * are instant (no extra network request or module evaluation).
   *
   * Throws immediately when called from a file:// origin because SharedArrayBuffer
   * (required by the WASM thread model) is only available under HTTP with COOP/COEP
   * headers — which file:// cannot deliver.
   *
   * @param {string} [version] - Defaults to getSavedVersion()
   * @returns {Promise<Function>} The `connect(dbName)` function from the bundle
   */
  static async loadVersion(version = TursoLoader.getSavedVersion()) {
    if (location.protocol === 'file:') {
      throw new Error(
        'TursoLoader requires an HTTP server (file:// is not supported). ' +
        'For local dev: npx serve public/ -p 3000'
      );
    }
    if (TursoLoader.#cache.has(version)) return TursoLoader.#cache.get(version);
    const modulePath = TursoLoader.#registry.get(version);
    if (!modulePath) throw new Error(`Turso version not registered: ${version}`);
    const { connect } = await import(modulePath);
    TursoLoader.#cache.set(version, connect);
    return connect;
  }

  /**
   * Open (or create) a database and return the raw Turso `db` object.
   *
   * Callers use the returned object directly with the Turso API:
   *   await db.prepare('INSERT INTO t VALUES (?)').run(value);
   *   const rows = await db.prepare('SELECT * FROM t').all();
   *   const row  = await db.prepare('SELECT COUNT(*) AS n FROM t').get();
   *
   * ALL db operations must be awaited — forgetting await causes "no such table"
   * errors because schema DDL may not have finished before the next statement.
   *
   * @param {string} dbName - Database name or ':memory:' for an in-memory DB
   * @param {object} [options]
   * @param {string}   [options.version]                - WASM version to load (default: getSavedVersion())
   * @param {boolean}  [options.requestStoragePermission] - Call navigator.storage.persist() to
   *                                                        prevent the browser from evicting the DB
   * @param {string[]} [options.schema]                 - DDL statements to run on first open
   * @param {boolean}  [options.allowExisting]          - Rewrite CREATE TABLE → CREATE TABLE IF NOT EXISTS
   *                                                      so the statements are safe to re-run on reload
   * @returns {Promise<object>} Raw Turso db instance
   */
  static async connect(dbName, options = {}) {
    if (location.protocol === 'file:') {
      throw new Error(
        'TursoLoader requires an HTTP server (file:// is not supported). ' +
        'For local dev: npx serve public/ -p 3000'
      );
    }
    const {
      version = TursoLoader.getSavedVersion(),
      requestStoragePermission = false,
      schema,
      allowExisting = false,
    } = options;

    // Ask the browser to keep the origin's storage quota from being auto-evicted.
    // This is best-effort — the browser may still deny the request.
    if (requestStoragePermission && navigator.storage?.persist) {
      await navigator.storage.persist();
    }

    const connectFn = await TursoLoader.loadVersion(version);
    const db = await connectFn(dbName);

    // Save the version that was actually used so future sessions stay on the
    // same WASM even if #DEFAULT_VERSION is changed in a later library update.
    TursoLoader.saveVersion(version);

    if (schema?.length) {
      for (let sql of schema) {
        // Rewrite bare CREATE TABLE to CREATE TABLE IF NOT EXISTS so that
        // reloading the page doesn't fail when the table already exists.
        if (allowExisting) {
          sql = sql.replace(
            /CREATE\s+TABLE(?!\s+IF\s+NOT\s+EXISTS)/i,
            'CREATE TABLE IF NOT EXISTS'
          );
        }
        // Each DDL must be awaited individually; the Turso WASM API does not
        // support batching multiple statements in a single prepare call.
        await db.prepare(sql).run();
      }
    }

    return db;
  }
}
