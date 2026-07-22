/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stream rooftop address records out of a BAN `adresses-<dept>.csv` dump (adresse.data.gouv.fr). The
 *   dump is a `;`-delimited, header-first CSV in which EVERY row already carries the full tuple —
 *   `numero`, `rep`, `nom_voie`, `code_postal`, `nom_commune`, `lon`/`lat` — so there is no OSM-style
 *   "association gap" (a point with no street): BAN is a structured government register, not a
 *   community tag soup. We stream line-by-line (the national set is 26M rows / ~5 GB uncompressed);
 *   `.csv.gz` inputs are transparently gunzipped.
 *
 *   The columns are located BY NAME off the header row (never by fixed position) so a future BAN
 *   schema addition can't silently shift the tuple. Values contain no embedded `;` (the dumps are
 *   uniform-arity — verified 23 fields across every département), so a plain split is both correct and
 *   fast; a literal `"` inside a field (rare) is kept verbatim, never treated as a CSV quote wrapper.
 *
 *   Also reads `nom_ld` ("nom du lieu-dit"), the hamlet/place name filled on 6.94% of rows nationally —
 *   surfaced as {@link BANAddrRecord.lieuDit}, cleaned of the survey-documented junk/dup patterns via
 *   {@link cleanLieuDit} (`.superpowers/sdd/deploc-world-survey.md`, FR section, 2026-07-22).
 */

import { createReadStream } from "node:fs"
import { createGunzip } from "node:zlib"

import { CSVSpliterator } from "spliterator"

/** One BAN address point. Every field but `rep`/`postcode`/`city`/`lieuDit` is guaranteed present by the source. */
export interface BANAddrRecord {
	/** `numero` — the house number (numeric in BAN; the `rep` suffix is carried separately). */
	numero: string
	/** `rep` — the repetition indicator (`bis`, `ter`, `quater`, `a`, `b`, …), or null when absent. */
	rep: string | null
	/** `nom_voie` — the street/voie name, already in full form ("Route de …", "Rue du …"). */
	street: string
	/** `code_postal` — the 5-digit postcode (nullable: a handful of lieu-dit rows omit it). */
	postcode: string | null
	/** `nom_commune` — the commune (locality) name. */
	city: string | null
	/**
	 * `nom_ld` ("nom du lieu-dit") — the hamlet/place name below the commune, cleaned via {@link cleanLieuDit}. Filled on
	 * 6.94% of BAN rows nationally; null on the rest AND on any row whose raw value is junk/duplicate (see
	 * {@link cleanLieuDit} for the filter breakdown — survey: `.superpowers/sdd/deploc-world-survey.md`, FR section,
	 * 2026-07-22).
	 */
	lieuDit: string | null
	lon: number
	lat: number
}

/** The BAN CSV columns this ingest reads (validated against the first parsed row — header drift fails LOUDLY). */
const REQUIRED_COLUMNS = ["numero", "rep", "nom_voie", "code_postal", "nom_commune", "nom_ld", "lon", "lat"] as const

/**
 * Literal header-leak: an upstream ingestion bug in the government CSV emits the column name itself as a `nom_ld` value
 * on some rows (survey: 24,305 rows nationally, 1.3% of filled `nom_ld`).
 */
const LIEU_DIT_HEADER_LEAK = "lieudit_complement_nom"

/**
 * Placeholder sentinel (`_1`, `_23`, …) — not a place name (survey: 1,671 rows, 0.09% of filled).
 */
const LIEU_DIT_PLACEHOLDER_PATTERN = /^_[0-9]+$/

/**
 * `"ancienne commune : <name>"` — real signal (a merged commune's former name), but the survey explicitly flags it as
 * needing a strip/parse step rather than raw-label use (survey: 3,709 rows, 0.2% of filled). Dropped here rather than
 * mis-emitted as a literal lieu-dit surface; parsing this bucket into its own signal is deferred, unscoped work.
 */
const LIEU_DIT_ANCIENNE_COMMUNE_PREFIX_PATTERN = /^ancienne commune\s*:/i

/**
 * Clean a raw `nom_ld` value against the survey's junk/dup breakdown. Of the 6.94% of BAN rows carrying a `nom_ld`
 * value, ~6.6% of those are junk or an exact duplicate of the commune name — this filters them out so only the clean
 * ~93.4% (~1.69M rows nationally) survive to {@link BANAddrRecord.lieuDit}. Exported for testing.
 */
export function cleanLieuDit(raw: string | undefined, commune: string | null): string | null {
	const trimmed = raw?.trim()

	if (!trimmed) return null

	if (trimmed === LIEU_DIT_HEADER_LEAK) return null

	if (LIEU_DIT_PLACEHOLDER_PATTERN.test(trimmed)) return null

	if (LIEU_DIT_ANCIENNE_COMMUNE_PREFIX_PATTERN.test(trimmed)) return null

	// Exact duplicate of the commune name (case-insensitive) — no new signal, would just relabel
	// locality twice (survey: 89,977 rows, 5.0% of filled).
	if (commune && trimmed.localeCompare(commune, undefined, { sensitivity: "base" }) === 0) return null

	return trimmed
}

/** Throw if the dump's header is missing a required column — a rename upstream must not silently skip every row. */
function assertRequiredColumns(row: Record<string, unknown>): void {
	for (const name of REQUIRED_COLUMNS) {
		if (!(name in row)) {
			throw new Error(`BAN CSV header is missing required column "${name}" (got: ${Object.keys(row).join(", ")})`)
		}
	}
}

/** A readable stream over `csvPath`, transparently gunzipping a `.csv.gz` input. */
function openCSV(csvPath: string): NodeJS.ReadableStream {
	const raw = createReadStream(csvPath)

	return csvPath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw
}

/**
 * Stream every address point from one BAN département dump, geometry taken straight from the source `lon`/`lat`
 * (WGS84). Rows with a non-finite coordinate or an empty `nom_voie`/`numero` are skipped (yield-side filtering is the
 * caller's job for anything finer). The `rep` suffix is normalised to lower-case or null.
 */
export async function* extractBANAddrPoints(csvPath: string): AsyncGenerator<BANAddrRecord> {
	// CSVSpliterator (quote-correct since spliterator 3.2.0) replaces the 2026-07-09 hand-rolled
	// `split(";")` that leaked CSV quotes into lieu-dit street keys (#1044): quoted fields unwrap,
	// doubled inner quotes fold, and a quoted `;` no longer mis-splits the row.
	let checkedHeader = false

	for await (const row of CSVSpliterator.fromAsync<Record<string, string>>(openCSV(csvPath), {
		mode: "object",
		columnDelimiter: ";",
		// Opt-in end-to-end quoting: wrapping quotes strip, doubled quotes unescape, quoted `;` does
		// not split — the #1044 fix proper.
		enableQuoteHandling: true,
	})) {
		if (!checkedHeader) {
			assertRequiredColumns(row)
			checkedHeader = true
		}
		const numero = row.numero?.trim()
		const street = row.nom_voie?.trim()

		if (!numero || !street) continue
		// Guard the empty-string trap: `Number("")` is 0 (finite), which would write a bogus (0,0) point —
		// so require a non-empty coord string BEFORE parsing, then the finite check catches garbage.
		const lonStr = row.lon?.trim()
		const latStr = row.lat?.trim()

		if (!lonStr || !latStr) continue
		const lon = Number(lonStr)
		const lat = Number(latStr)

		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
		const rep = row.rep?.trim()
		const postcode = row.code_postal?.trim()
		const city = row.nom_commune?.trim()
		const lieuDit = cleanLieuDit(row.nom_ld, city || null)

		yield {
			numero,
			rep: rep ? rep.toLowerCase() : null,
			street,
			postcode: postcode || null,
			city: city || null,
			lieuDit,
			lon,
			lat,
		}
	}
}
