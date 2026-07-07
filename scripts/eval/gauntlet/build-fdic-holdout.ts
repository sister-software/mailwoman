/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the US verified-coord held-out pool for the Gauntlet (C6). FDIC BankFind publishes every insured
 *   bank branch (~78k) with a real street address AND a geocoded LAT/LON — a clean US truth source that is
 *   NOT in mailwoman's training corpus (Overture/NAD/BAN), so it measures genuine US generalization, the
 *   complement to the FR/BAN draw. Public domain (US Government work).
 *
 *   Writes a semicolon CSV pool (address;city;state;zip;lat;lon) to $MAILWOMAN_DATA_ROOT/corpus/staging/
 *   fdic-us.csv, build-on-copy. The pool is the FAST draw — holdout.ts reservoir-samples it in milliseconds
 *   instead of streaming the 5 GB BAN file. Re-run to refresh (FDIC re-indexes ~monthly).
 *
 *   Run: node scripts/eval/gauntlet/build-fdic-holdout.ts
 */

import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs"

import { mailwomanDataRoot } from "mailwoman/resolver-backend"

const OUT = `${mailwomanDataRoot()}/corpus/staging/fdic-us.csv`
const API = "https://banks.data.fdic.gov/api/locations"
const PAGE = 10_000
const FIELDS = "ADDRESS,CITY,STALP,ZIP,LATITUDE,LONGITUDE"

interface Loc {
	ADDRESS?: string
	CITY?: string
	STALP?: string
	ZIP?: string
	LATITUDE?: number
	LONGITUDE?: number
}

/** Sane CONUS+AK/HI/PR bbox — drops null-island and mis-geocoded rows so the pool is clean truth. */
function plausibleUs(lat: number, lon: number): boolean {
	return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 17 && lat <= 72 && lon >= -180 && lon <= -64
}

async function fetchPage(offset: number): Promise<Loc[]> {
	const url = `${API}?fields=${FIELDS}&limit=${PAGE}&offset=${offset}&format=json`
	const res = await fetch(url)

	if (!res.ok) throw new Error(`FDIC ${res.status} at offset ${offset}`)
	const body = (await res.json()) as { data?: Array<{ data: Loc }> }

	return (body.data ?? []).map((d) => d.data)
}

const tmp = `${OUT}.tmp-${process.pid}`

if (existsSync(tmp)) {
	rmSync(tmp)
}
const sink = createWriteStream(tmp, { encoding: "utf8" })
sink.write("address;city;state;zip;lat;lon\n")

let total = 0
let written = 0
let dropped = 0

for (let offset = 0; ; offset += PAGE) {
	const rows = await fetchPage(offset)

	if (rows.length === 0) break
	total += rows.length

	for (const r of rows) {
		const address = (r.ADDRESS ?? "").trim()
		const city = (r.CITY ?? "").trim()
		const state = (r.STALP ?? "").trim()
		const zip = (r.ZIP ?? "").trim()
		const lat = Number(r.LATITUDE)
		const lon = Number(r.LONGITUDE)

		if (!address || !city || !state || !plausibleUs(lat, lon)) {
			dropped++
			continue
		}
		// Semicolons can't appear in a US street address/city; no escaping needed.
		sink.write(`${address};${city};${state};${zip};${lat};${lon}\n`)
		written++
	}
	console.error(
		`[fdic] offset ${offset.toLocaleString()} → ${written.toLocaleString()} written, ${dropped.toLocaleString()} dropped`
	)
}

await new Promise<void>((resolvePromise) => sink.end(resolvePromise))

if (existsSync(OUT)) {
	renameSync(OUT, `${OUT}.prev`)
}
renameSync(tmp, OUT)

if (existsSync(`${OUT}.prev`)) {
	rmSync(`${OUT}.prev`)
}

console.error(
	`[fdic] DONE ${OUT} — ${written.toLocaleString()} of ${total.toLocaleString()} branches (${dropped.toLocaleString()} dropped)`
)
