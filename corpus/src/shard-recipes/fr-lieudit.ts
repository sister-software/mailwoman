/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-lieudit` shard recipe — FR lieu-dit (hamlet/place) `dependent_locality` coverage
 *   (`.superpowers/sdd/deploc-world-survey.md`, FR section, 2026-07-22). Streams every BAN
 *   `adresses-<dept>.csv` dump under `--ban-dir` through `@mailwoman/ban/sdk`'s
 *   `extractBANAddrPoints`, which now surfaces a cleaned `lieuDit` per record (junk/dup filtering
 *   lives in `ban/sdk/extract.ts`'s `cleanLieuDit`, not duplicated here). Only rows carrying a clean
 *   lieu-dit survive into the pool; the existing `ban`/`synth-fr` sources and their emitted rows are
 *   untouched — this recipe reads the SAME raw CSVs but emits under its own source name.
 *
 *   Mapping: lieu-dit → `dependent_locality`, commune → `locality`. Rendered to match the formatter's
 *   FR `place`-slot convention (`fix(formatter): render dependent_locality for neither-slot templates`,
 *   b1edc1b7, verified via a `formatAddress` smoke call): house+street on line 1, the lieu-dit ALONE on
 *   line 2, postcode+commune on line 3 — French postal convention (La Poste's line 5).
 *
 *   ~1.69M clean rows survive the filter nationally (26M total BAN rows, 1.81M raw `nom_ld` fills, ~6.6%
 *   junk/dup). The pool is read in full (small string tuples only — no coordinates needed) and
 *   Fisher-Yates shuffled with the seeded PRNG before slicing to `--count`, rather than sampled WITH
 *   replacement — at a `--count` a sizeable fraction of the pool, with-replacement draws would produce a
 *   large duplicate rate (birthday-paradox math: ~190k expected collisions at count=800k over a 1.69M
 *   pool).
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"

import { extractBANAddrPoints } from "@mailwoman/ban/sdk"
import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath } from "@mailwoman/core/utils"

import { stableSourceID } from "../adapter.ts"
import { decomposeFrStreet } from "../adapters/ban/street-decompose.ts"
import { alignRow } from "../align.ts"
import type { CanonicalRow } from "../types.ts"
import { makeMulberry32, type ShardRecipe } from "./scaffold.ts"

const DEFAULT_LICENSE = "Licence Ouverte 2.0" // matches the `ban` adapter's Tier-B election for BAN data

/** One BAN row surviving the lieu-dit filter — the minimal tuple the pool holds. */
interface LieuDitTuple {
	numero: string
	rep: string | null
	street: string
	postcode: string | null
	locality: string
	dependentLocality: string
}

/**
 * Enumerate `adresses-<dept>.csv[.gz]` files in `banDir`, ONE path per département. Excludes the `merged`/`france`
 * aggregates (they duplicate the per-département rows) and, when both a `.csv` and a `.csv.gz` exist for the same dept
 * (observed on disk for 13/2A/48/69/75 — a stale re-fetch artifact), prefers the uncompressed `.csv` — mirrors
 * `ban/scripts/build-address-point-shard.ts`'s `departementFiles`, which hit and fixed this exact double-count trap
 * first.
 */
function departementFiles(banDir: string): string[] {
	const byDept = new Map<string, string>()

	for (const name of readdirSync(banDir).sort()) {
		const m = /^adresses-(.+?)\.csv(\.gz)?$/.exec(name)

		if (!m) continue

		const dept = m[1]!

		if (dept === "merged" || dept === "france") continue

		const existing = byDept.get(dept)

		if (!existing || (existing.endsWith(".gz") && !name.endsWith(".gz"))) {
			byDept.set(dept, join(banDir, name))
		}
	}

	return [...byDept.keys()].sort().map((dept) => byDept.get(dept)!)
}

/** Stream every département file, keeping only rows with a clean `lieuDit` (junk/dup filtering lives in `ban/sdk`). */
async function readLieuDitPool(banDir: string): Promise<LieuDitTuple[]> {
	const files = departementFiles(banDir)

	if (files.length === 0) {
		throw new Error(
			`No BAN adresses-<dept>.csv files found in ${banDir} — fetch BAN first (\`mailwoman corpus fetch ban\`).`
		)
	}

	const pool: LieuDitTuple[] = []
	let scanned = 0

	for (const path of files) {
		let deptCount = 0

		for await (const rec of extractBANAddrPoints(path)) {
			scanned++

			if (!rec.lieuDit || !rec.city) continue

			pool.push({
				numero: rec.numero,
				rep: rec.rep,
				street: rec.street,
				postcode: rec.postcode,
				locality: rec.city,
				dependentLocality: rec.lieuDit,
			})
			deptCount++
		}
		console.error(`  ${path}: ${deptCount.toLocaleString()} clean lieu-dit rows`)
	}
	console.error(
		`  scanned ${scanned.toLocaleString()} BAN rows across ${files.length} départements → pool=${pool.length.toLocaleString()}`
	)

	return pool
}

/** `house_number` = `numero` + folded `rep` ("10 bis"), matching the `ban` adapter's own composition. */
function composeHouseNumber(numero: string, rep: string | null): string {
	return rep ? `${numero} ${rep}` : numero
}

/**
 * Render the raw address string: house+street line, the lieu-dit ALONE on its own line, postcode+commune line — the
 * exact shape `formatAddress` produces for FR's `place`-slot mapping (verified via a smoke call before this recipe was
 * written; see the module docstring).
 */
function composeRaw(
	house: string,
	street: string,
	dependentLocality: string,
	postcode: string | null,
	locality: string
): string {
	const lines: string[] = []
	const streetLine = `${house} ${street}`.trim()

	if (streetLine) {
		lines.push(streetLine)
	}
	lines.push(dependentLocality)
	const cityLine = [postcode, locality].filter(Boolean).join(" ").trim()

	if (cityLine) {
		lines.push(cityLine)
	}

	return lines.join("\n")
}

/** Fisher-Yates shuffle, in place, with the recipe's seeded PRNG — reproducible sampling without replacement. */
function shuffleInPlace<T>(arr: T[], random: () => number): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
	}
}

export const frLieuditRecipe: ShardRecipe = {
	name: "fr-lieudit",
	description: "FR lieu-dit rows: BAN nom_ld → dependent_locality (commune → locality), lieu-dit on its own line",
	mode: "generate",
	options: [
		{
			flag: "--ban-dir <dir>",
			description: "BAN adresses-<dept>.csv directory. Default $MAILWOMAN_DATA_ROOT/corpus/sources/ban",
		},
		{
			flag: "--country-fraction <f>",
			description: "Fraction of rows that append an explicit 'France' surface form + a `country` component. Default 0",
		},
	],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-fr-lieudit"
		const count = opts.count ?? 800_000
		const banDir = opts.banDir ?? dataRootPath("corpus", "sources", "ban")
		const countryFraction = opts.countryFraction ?? 0

		if (!(countryFraction >= 0 && countryFraction <= 1)) {
			throw new Error(`--country-fraction must be in [0, 1], got ${countryFraction}`)
		}

		const pool = await readLieuDitPool(banDir)

		if (pool.length === 0) {
			throw new Error(`No clean lieu-dit rows found under ${banDir} — see ban/sdk/extract.ts's cleanLieuDit filter.`)
		}

		shuffleInPlace(pool, random)
		const selected = pool.slice(0, Math.min(count, pool.length))

		let emitted = 0
		let skipped = 0
		let countryAppended = 0

		for (const t of selected) {
			const house = composeHouseNumber(t.numero, t.rep)
			const decomposed = decomposeFrStreet(t.street)

			const components: Partial<Record<ComponentTag, string>> = {
				house_number: house,
				dependent_locality: t.dependentLocality,
				locality: t.locality,
			}

			if (decomposed.prefix) {
				components.street_prefix = decomposed.prefix
			}

			if (decomposed.street) {
				components.street = decomposed.street
			}

			if (t.postcode) {
				components.postcode = t.postcode
			}

			let raw = composeRaw(house, t.street, t.dependentLocality, t.postcode, t.locality)

			if (!raw) {
				skipped++
				continue
			}

			// Country-append (the fr-admin-split #728 pattern, generalized): ~`countryFraction` of the time
			// append an explicit "France" surface form onto the trailing (postcode+commune) line + a
			// `country` component — the model relearns to emit country WHEN present without over-firing it
			// on the (still-majority) country-less rows. `countryFraction <= 0` (the default) never draws
			// from `random`, so the byte-stream is unaffected when the flag is unset.
			if (countryFraction > 0 && random() < countryFraction) {
				const forms = COUNTRY_SURFACE_FORMS.FR
				const form = forms[Math.floor(random() * forms.length)]!
				raw = `${raw}, ${form}`
				components.country = form
				countryAppended++
			}

			const sourceID = stableSourceID(source, {
				street: t.street,
				house_number: house,
				dependent_locality: t.dependentLocality,
				locality: t.locality,
				postcode: t.postcode ?? undefined,
			})
			const canonical: CanonicalRow = {
				raw,
				components,
				country: "FR",
				locale: "fr-FR",
				source,
				source_id: sourceID,
				corpus_version: "",
				license: DEFAULT_LICENSE,
			}
			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(JSON.stringify({ ...aligned.row, synth_method: source, synth_base_id: null }) + "\n")
			emitted++
		}

		console.error(`  emitted=${emitted} skipped=${skipped} country-appended=${countryAppended} pool=${pool.length}`)

		return { emitted, skipped }
	},
}
