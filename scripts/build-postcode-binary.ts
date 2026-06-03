/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build per-country browser postcode binaries (#240) from the SQLite shards. Emits one
 *   `postcode-<cc>.bin` per locale into `docs/static/mailwoman/` (alongside `fst-en-US.bin`), each
 *   loadable by `@mailwoman/neural`'s `PostcodeBinaryResolver` in the WASM/browser parser.
 *   Per-country so the browser fetches only the locale it needs (the tiered-loading story in the
 *   design doc).
 *
 *   The shard `name` is already the normalized postcode key (DE/FR `68161`/`75008`, NL space-less
 *   `1012LM`, US `94105`), which is exactly what the anchor queries, so it serializes verbatim.
 *
 *   Usage: node --experimental-strip-types scripts/build-postcode-binary.ts\
 *   [--out docs/static/mailwoman] [--locale US:postalcode-us.db] [--locale NL:postalcode-intl.db ...]
 *   Defaults to US (postalcode-us.db) + NL/FR/DE (postalcode-intl.db).
 */

import { serializePostcodeBinary, type PostcodeBinaryEntry } from "@mailwoman/neural/postcode-binary-resolver"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const WOF = "/mnt/playpen/mailwoman-data/wof"

interface LocaleSource {
	country: string
	db: string
}

function parseArgs(): { outDir: string; locales: LocaleSource[] } {
	const args = process.argv.slice(2)
	let outDir = "docs/static/mailwoman"
	const locales: LocaleSource[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out" && args[i + 1]) outDir = args[++i]!
		else if (args[i] === "--locale" && args[i + 1]) {
			const [country, db] = args[++i]!.split(":")
			if (country && db) locales.push({ country, db: db.startsWith("/") ? db : join(WOF, db) })
		}
	}
	if (locales.length === 0) {
		locales.push(
			{ country: "US", db: join(WOF, "postalcode-us.db") },
			{ country: "NL", db: join(WOF, "postalcode-intl.db") },
			{ country: "FR", db: join(WOF, "postalcode-intl.db") },
			{ country: "DE", db: join(WOF, "postalcode-intl.db") }
		)
	}
	return { outDir, locales }
}

function main(): void {
	const { outDir, locales } = parseArgs()

	for (const { country, db } of locales) {
		if (!existsSync(db)) {
			console.error(`skip ${country}: missing ${db}`)
			continue
		}
		const conn = new DatabaseSync(db, { readOnly: true })
		const rows = conn
			.prepare(
				`SELECT name, country, latitude AS lat, longitude AS lon FROM spr
				 WHERE placetype='postalcode' AND is_current!=0 AND country=?`
			)
			.all(country) as Array<{ name: string; country: string; lat: number; lon: number }>
		conn.close()

		const entries: PostcodeBinaryEntry[] = rows.map((r) => ({
			postcode: String(r.name),
			country: String(r.country),
			lat: Number(r.lat),
			lon: Number(r.lon),
		}))
		const bytes = serializePostcodeBinary(entries)
		const outPath = join(outDir, `postcode-${country.toLowerCase()}.bin`)
		writeFileSync(outPath, bytes)
		const placed = entries.filter((e) => e.lat !== 0 || e.lon !== 0).length
		console.error(
			`${country}: ${entries.length.toLocaleString()} codes (${placed.toLocaleString()} placed) → ${outPath} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`
		)
	}
}

main()
