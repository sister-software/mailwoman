# @mailwoman/resolver-wof-wasm

Browser-side WOF resolver backed by [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm). Drop-in `PlaceLookup` implementation for the browser-side mailwoman demo (Phase B of the demo plan — see [sister-software/mailwoman#98](https://github.com/sister-software/mailwoman/issues/98)).

Pair with [`@mailwoman/resolver-wof-sqlite`](https://www.npmjs.com/package/@mailwoman/resolver-wof-sqlite)'s `mailwoman-wof-build-slim` CLI to produce a ~35 MB slim distribution suitable for static-asset deployment, then load it from a URL at runtime.

## Status

**v0.1.0 — scaffold + minimal `findPlace`.** Supports text + placetype + country + limit. Full ranking surface (parentId descendant filter, proximity boost, bbox hard filter, population weighting) lands in v0.2.0 once the shared query builder is extracted from `@mailwoman/resolver-wof-sqlite`.

## Quick start

```ts
import { loadSlimWofDatabase, WofWasmPlaceLookup } from "@mailwoman/resolver-wof-wasm"

// Load the slim DB. Either fetch from a URL or pass raw Uint8Array bytes.
const { db } = await loadSlimWofDatabase({
	source: "/static/wof-hot.db", // or a Uint8Array from bundler import
	wasmUrl: new URL("../node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm", import.meta.url).href,
})

const lookup = new WofWasmPlaceLookup({ db })

const matches = await lookup.findPlace({
	text: "Springfield",
	placetype: "locality",
	country: "US",
	limit: 5,
})

for (const m of matches) {
	console.log(m.id, m.name, m.lat, m.lon, "score:", m.score)
}

lookup.close()
```

## Loading strategies

`loadSlimWofDatabase` currently fetches the whole DB and opens it in memory via `sqlite3_deserialize`. For the ~35 MB default slim build that's a one-RTT transfer + a one-shot in-memory open — typically sub-second on broadband, and after that every query is in-process WASM.

For larger DBs or low-bandwidth users, the future path is to swap the loader for an HTTP-VFS implementation (à la `sql.js-httpvfs`) so SQLite pages get fetched lazily via byte-range. The `WofWasmPlaceLookup` class is loader-agnostic — only the loader changes.

## Bundling

This package ships compiled TypeScript only. The `@sqlite.org/sqlite-wasm` runtime (`.wasm` + worker JS) is a peer asset your bundler needs to serve. For Vite:

```ts
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm?url"
```

For webpack: use `asset/resource` rules on the `.wasm` extension and pass the resolved URL via the `wasmUrl` option.

## Why not extend `WofSqlitePlaceLookup`?

`WofSqlitePlaceLookup` is hard-bound to `node:sqlite` (the Node 22+ built-in). Subclassing across the Node/WASM line means dragging Node-only types into a browser package. We chose composition over inheritance: both classes implement the same `PlaceLookup` interface and (v0.2.0+) call the same shared query builder, but stay independently importable.

## License

AGPL-3.0-only (mirrors the rest of the mailwoman tree).
