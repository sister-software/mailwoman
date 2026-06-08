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
 *   **GB is special.** `postalcode-gb.db` holds 2.7M _unit_ postcodes (`SO4 3RX`) — a 35 MB binary,
 *   far past the browser budget and finer than an anchor needs. So GB is aggregated to the
 *   **outward code** (`SO4`, the district — ~3k of them), centroid-averaged over its placed units.
 *   The extractor falls back to the outward code for a GB-shaped unit that misses the full lookup
 *   (see `extractPostcodeAnchors`). Other countries serialize verbatim.
 *
 *   Usage: node --experimental-strip-types scripts/build-postcode-binary.ts\
 *   [--out docs/static/mailwoman] [--locale US:postalcode-us.db] [--locale NL:postalcode-intl.db ...]
 *   Defaults to US + NL/FR/DE/ES/IT (postalcode-intl.db) + GB (postalcode-gb.db,
 *   outward-aggregated).
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
			{ country: "DE", db: join(WOF, "postalcode-intl.db") },
			{ country: "ES", db: join(WOF, "postalcode-intl.db") },
			{ country: "IT", db: join(WOF, "postalcode-intl.db") },
			{ country: "GB", db: join(WOF, "postalcode-gb.db") }
		)
	}
	return { outDir, locales }
}

/**
 * GB outward code: the part before the space when the inward half is `\d[A-Z]{2}` (`SO4 3RX` →
 * `SO4`).
 */
function gbOutward(name: string): string | null {
	const sp = name.indexOf(" ")
	if (sp < 1) return null
	const inward = name.slice(sp + 1)
	return /^\d[A-Z]{2}$/.test(inward) ? name.slice(0, sp) : null
}

/**
 * Aggregate GB unit postcodes to outward codes, averaging the placed-unit centroids. Drops units
 * that don't parse as a GB unit postcode (kept verbatim is wrong at this granularity). Returns one
 * entry per outward code.
 */
function aggregateGbOutward(
	rows: Array<{ name: string; country: string; lat: number; lon: number }>
): PostcodeBinaryEntry[] {
	const acc = new Map<string, { latSum: number; lonSum: number; placed: number }>()
	for (const r of rows) {
		const out = gbOutward(String(r.name).toUpperCase())
		if (!out) continue
		const a = acc.get(out) ?? { latSum: 0, lonSum: 0, placed: 0 }
		if (r.lat !== 0 || r.lon !== 0) {
			a.latSum += Number(r.lat)
			a.lonSum += Number(r.lon)
			a.placed += 1
		}
		acc.set(out, a)
	}
	const entries: PostcodeBinaryEntry[] = []
	for (const [out, a] of acc) {
		entries.push({
			postcode: out,
			country: "GB",
			lat: a.placed > 0 ? a.latSum / a.placed : 0,
			lon: a.placed > 0 ? a.lonSum / a.placed : 0,
		})
	}
	return entries
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

		const entries: PostcodeBinaryEntry[] =
			country === "GB"
				? aggregateGbOutward(rows)
				: rows.map((r) => ({
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
