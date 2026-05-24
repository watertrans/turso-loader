# turso-loader

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

ブラウザで [Turso](https://turso.tech/)（SQLite 互換インプロセス DB）を動かすためのライブラリ。

- WASM をセルフホスト・バージョン管理（CDN 不要）
- 使用バージョンを localStorage に記憶し、ライブラリ更新後も自動アップグレードしない
- Service Worker による WASM キャッシュ（オフライン動作・再訪問時の再ダウンロードなし）
- スキーマ初期化・ストレージ許可をオプションで制御

[English](README.md)

## 動作要件

- **ブラウザ:** Chrome 92+、Firefox 79+、Safari 15.2+、Edge 92+
- **プロトコル:** HTTP サーバー必須 — `file://` では動作しない
- **本番環境:** HTTPS 必須（SharedArrayBuffer・Service Worker ともにセキュアコンテキストが必要）
- **ヘッダー:** このライブラリを使用するページに `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: credentialless` を設定すること — Turso の WASM スレッドが SharedArrayBuffer を使うため必須。サイト全体に適用しないこと。詳細とリスクは[デプロイ](#デプロイ)を参照。

---

## ファイル構成

```
turso/
├── serve.json              ローカル開発用サーバー設定（COOP/COEP + Service-Worker-Allowed）
├── package.json            WASM パッケージ管理
├── scripts/
│   └── copy-wasm.js        postinstall: WASM を public/turso-wasm/ にコピー
├── public/                 ライブラリ本体（デプロイ対象）
│   ├── turso-db.js         TursoLoader クラス
│   ├── turso-sw.js         汎用 Service Worker（URL パラメータで設定）
│   └── turso-wasm/
│       ├── v0.6.0/main.es.js
│       └── v0.6.1/main.es.js
└── demo/
    └── demo.html           TODO アプリ（参考実装）
```

---

## セットアップ

```bash
npm install
# → public/turso-wasm/v0.6.0/ と public/turso-wasm/v0.6.1/ に WASM が配置される
```

## ローカル開発

```bash
npx serve . -p 3000
# → http://localhost:3000/demo/demo.html
```

> `file://` では動作しません。必ず HTTP サーバー経由で開いてください。

---

## TursoLoader API

```js
import { TursoLoader } from '/public/turso-db.js';
```

### `TursoLoader.connect(dbName, options)` → `db`

DB に接続してスキーマを初期化し、生の Turso `db` オブジェクトを返す。

```js
const db = await TursoLoader.connect('myapp.db', {
  version: '0.6.1',             // 省略時: localStorage の保存値 → #DEFAULT_VERSION
  requestStoragePermission: true, // navigator.storage.persist() を呼ぶ
  schema: [
    `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
  ],
  allowExisting: true,          // IF NOT EXISTS を自動付与（省略時: false）
});

// 返り値は生の Turso API
await db.prepare('INSERT INTO items (name) VALUES (?)').run('Hello');
const rows = await db.prepare('SELECT * FROM items').all();
const row  = await db.prepare('SELECT COUNT(*) AS n FROM items').get();
```

### `TursoLoader.loadVersion(version)` → `connectFn`

WASM のみロードして `connect` 関数を返す（`connect()` は呼ばない）。

```js
const connectFn = await TursoLoader.loadVersion('0.6.1');
const db = await connectFn('myapp.db');
```

### `TursoLoader.registerVersion(version, path)`

追加バージョンのパスを登録する。パスは `turso-db.js` からの相対パス。

```js
TursoLoader.registerVersion('0.7.0', './turso-wasm/v0.7.0/main.es.js');
```

### `TursoLoader.getSavedVersion()` → `string`

localStorage に保存された使用バージョンを返す。未保存またはレジストリに存在しない場合は `#DEFAULT_VERSION`。

### バージョン固定の仕組み

`connect()` が成功すると使用バージョンを localStorage に保存する。次回以降はこの値が優先されるため、**ライブラリの `#DEFAULT_VERSION` が変わっても既存ユーザーは自動アップグレードされない。**

---

## Service Worker の使い方

`public/turso-sw.js` は汎用 SW。登録時に URL パラメータで設定する。

```js
const swParams = new URLSearchParams({
  shell: ['/myapp/index.html', '/public/turso-db.js'].join(','),
  wasm:  '/turso-wasm/',   // WASM URL のマッチ文字列
  cache: 'myapp-v1',       // Cache Storage の名前（アプリごとに変える）
});
navigator.serviceWorker.register(`/public/turso-sw.js?${swParams}`, { scope: '/' });
```

| パラメータ | 説明 | デフォルト |
|-----------|------|-----------|
| `shell`   | インストール時に事前キャッシュする URL（カンマ区切り） | なし |
| `wasm`    | WASM フェッチを識別する URL 部分文字列 | `/turso-wasm/` |
| `cache`   | Cache Storage 名 | `turso-v1` |

SW からアプリへのメッセージ:
- `{ type: 'UPDATE_DONE' }` — 更新完了
- `{ type: 'UPDATE_ERROR', message }` — 更新失敗

---

## Change Data Capture (CDC)

CDC はブラウザ WASM 環境で動作します（`@tursodatabase/database-wasm` で確認済み）。`connect()` の直後に PRAGMA で接続ごとに有効化します：

```js
const db = await TursoLoader.connect('myapp.db', { ... });
await db.prepare("PRAGMA capture_data_changes_conn('full')").run();
```

以降その接続で行った INSERT / UPDATE / DELETE はすべて `turso_cdc` テーブルに自動記録されます：

| カラム | 型 | 説明 |
|--------|-----|------|
| `change_id` | INTEGER | 自動採番 ID |
| `change_time` | INTEGER | Unix タイムスタンプ |
| `change_txn_id` | INTEGER | トランザクション ID |
| `change_type` | INTEGER | 1=INSERT、0=UPDATE、-1=DELETE、2=COMMIT |
| `table_name` | TEXT | 対象テーブル名 |
| `before` | BLOB | 変更前の行データ |
| `after` | BLOB | 変更後の行データ |

```js
const changes = await db.prepare('SELECT * FROM turso_cdc ORDER BY change_id').all();
```

モード: `id`（rowid のみ）、`before`、`after`、`full`（前後両方）。カスタムテーブル名を末尾に付加することも可能: `'full,my_changes'`。

> **注意:** CDC は MVCC と併用できません。

---

## WASM バージョンの追加

1. `package.json` の `dependencies` に追記:

```json
"database-wasm-0.7.0": "npm:@tursodatabase/database-wasm@0.7.0"
```

2. `npm install` → `public/turso-wasm/v0.7.0/main.es.js` が自動生成される

3. `public/turso-db.js` の `#registry` に追記:

```js
['0.7.0', './turso-wasm/v0.7.0/main.es.js'],
```

---

## デプロイ

`public/` と `demo/`（使う場合）を静的ホスティングにコピーする。

**必須ヘッダー（turso-loader を使うページのみ）:**

```
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Embedder-Policy: credentialless
```

> **注意:** サイト全体に適用しないこと。これらのヘッダーはクロスオリジンのポップアップ（OAuth 等）を妨害し、クロスオリジンリクエストからクレデンシャルを除去する。このライブラリを使うページにのみ設定すること。

**必須ヘッダー（`public/turso-sw.js` のみ）:**

```
Service-Worker-Allowed: /
```

nginx の例:

```nginx
# turso-loader を使うページにのみ適用する
location = /your-app-page.html {
    add_header Cross-Origin-Opener-Policy  same-origin;
    add_header Cross-Origin-Embedder-Policy credentialless;
}

location = /public/turso-sw.js {
    add_header Service-Worker-Allowed /;
}
```
