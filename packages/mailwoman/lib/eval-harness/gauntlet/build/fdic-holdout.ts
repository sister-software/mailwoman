/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Build the US verified-coordinate held-out pool for the Gauntlet: fdic BankFind publishes every insured bank
 * branch with a real street address and a geocoded lat/lon, a public-domain US truth source absent from
 * mailwoman's training corpus, so it measures genuine US generalization. Writes a semicolon CSV pool to
 * $MAILWOMAN_DATA_ROOT/corpus/staging/fdic-us.csv, build-on-copy, which holdout.ts reservoir-samples in
 * milliseconds instead of streaming the 5 GB BAN file.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { removePath, movePath } from "@mailwoman/core/fs/writers"

const MIN_US_LATITUDE = 17
const MAX_US_LATITUDE = 72
const MIN_US_LONGITUDE = -180
const MAX_US_LONGITUDE = -64

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

/**
 * Sane conus+AK/HI/PR bbox.
 *
 * Drops null-island and mis-geocoded rows so the pool is clean truth.
 */
function plausibleUs(lat: number, lon: number): boolean {
	return (
		Number.isFinite(lat) &&
		Number.isFinite(lon) &&
		lat >= MIN_US_LATITUDE &&
		lat <= MAX_US_LATITUDE &&
		lon >= MIN_US_LONGITUDE &&
		lon <= MAX_US_LONGITUDE
	)
}

/**
 * Retry is on because the page loop is all-or-none: one throttled page aborted the whole build,
 * and the tmp-then-rename tail discards a partial run rather than publishing it.
 *
 * No `minRequestIntervalMs`, because strictly sequential 10,000-row pages already pace themselves.
 */
const fdicClient = new APIClient({ displayName: "fdic", retry: true })

async function fetchPage(offset: number): Promise<Loc[]> {
	const url = `${API}?fields=${FIELDS}&limit=${PAGE}&offset=${offset}&format=json`

	const body = await fdicClient.fetch<{ data?: Array<{ data: Loc }> }>({ url }).then(pluckResponseData)

	return (body.data ?? []).map((d) => d.data)
}

/**
 * Fetch the fdic BankFind branch pool and swap it into the staging path (build-on-copy).
 */
export async function buildFDICHoldout(): Promise<void> {
	const OUT = dataRootPath("corpus", "staging", "fdic-us.csv")
	const tmp = `${OUT}.tmp-${process.pid}`

	if (await pathExists(tmp)) {
		await removePath(tmp)
	}

	const sink = openWriteStream(tmp, { encoding: "utf8" })
	sink.write("address;city;state;zip;lat;lon\n")

	let total = 0
	let written = 0
	let dropped = 0

	for (let offset = 0; ; offset += PAGE) {
		const rows = await fetchPage(offset)

		if (!rows.length) break
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

			// Semicolons cannot appear in a US street address or city, so no escaping is needed.
			sink.write(`${address};${city};${state};${zip};${lat};${lon}\n`)

			written++
		}

		console.error(
			`[fdic] offset ${offset.toLocaleString()} → ${written.toLocaleString()} written, ${dropped.toLocaleString()} dropped`
		)
	}

	await new Promise<void>((resolvePromise) => {
		sink.end(resolvePromise)
	})

	if (await pathExists(OUT)) {
		await movePath(OUT, `${OUT}.prev`)
	}

	await movePath(tmp, OUT)

	if (await pathExists(`${OUT}.prev`)) {
		await removePath(`${OUT}.prev`)
	}

	console.error(
		`[fdic] DONE ${OUT} — ${written.toLocaleString()} of ${total.toLocaleString()} branches (${dropped.toLocaleString()} dropped)`
	)
}
