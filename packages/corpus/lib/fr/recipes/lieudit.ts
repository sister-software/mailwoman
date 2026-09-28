/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `fr-lieudit` recipe: FR lieu-dit (hamlet/place) `dependent_locality` coverage.
 *
 * Streams every BAN `adresses-<dept>.csv` dump under `--ban-dir` through `@mailwoman/ban/sdk`'s
 * `extractBANAddrPoints`, which surfaces a cleaned `lieuDit` per record. Only rows carrying a clean
 * lieu-dit survive into the pool.
 *
 * Mapping: lieu-dit to `dependent_locality`, commune to `locality`. Rendered to match the
 * formatter's FR `place`-slot convention. House and street on line 1, the lieu-dit alone on line 2,
 * postcode and commune on line 3, which is French postal convention (La Poste's line 5).
 *
 * The pool is read in full and Fisher-Yates shuffled with the seeded prng before slicing to
 * `--count`. With-replacement draws at a large `--count` would produce a large duplicate rate.
 */

import { extractBANAddrPoints } from "@mailwoman/ban/sdk"
import { formatAddress } from "@mailwoman/codex/address-format"
import type { ComponentTag } from "@mailwoman/codex/component"
import { COUNTRY_SURFACE_FORMS } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { sample, shuffleWith } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { stableSourceID } from "#adapters/utils"
import { decomposeFrStreet } from "#fr/adapters/ban/street-decompose"
import type { CorpusRecipe } from "#recipes/scaffold"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

/**
 * Matches the `ban` adapter's Tier-B election for BAN data.
 */
const DEFAULT_LICENSE = "Licence Ouverte 2.0"

/**
 * One BAN row surviving the lieu-dit filter.
 * The minimal tuple the pool holds.
 */
interface LieuDitTuple {
	numero: string
	rep: string | null
	street: string
	postcode: string | null
	locality: string
	dependentLocality: string
}

/**
 * Enumerate `adresses-<dept>.csv[.gz]` files in `banDir`, one path per département.
 *
 * Excludes the `merged` and `france` aggregates, which duplicate the per-département rows. When
 * both a `.csv` and a `.csv.gz` exist for the same department, the uncompressed `.csv` wins.
 */
async function departementFiles(banDir: PathBuilderLike): Promise<PathBuilder[]> {
	const directory = PathBuilder.from(banDir)
	const byDept = new Map<string, string>()

	for (const name of await Globerator.from("*", { cwd: directory, absolute: false }).toSorted()) {
		const m = /^adresses-(.+?)\.csv(\.gz)?$/.exec(name)

		if (!m) continue

		const dept = m[1]!

		if (dept === "merged" || dept === "france") continue

		const existing = byDept.get(dept)

		if (!existing || (existing.endsWith(".gz") && !name.endsWith(".gz"))) {
			byDept.set(dept, name)
		}
	}

	return [...byDept.keys()].toSorted().map((dept) => directory(byDept.get(dept)!))
}

/**
 * Stream every département file, keeping only rows with a clean `lieuDit`
 * (junk/dup filtering lives in `ban/sdk`).
 */
async function readLieuDitPool(banDir: PathBuilderLike): Promise<LieuDitTuple[]> {
	const files = await departementFiles(banDir)

	if (!files.length) {
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

/**
 * `house_number` = `numero` + folded `rep` ("10 bis"), matching the `ban` adapter's own composition.
 */
function composeHouseNumber(numero: string, rep: string | null): string {
	return rep ? `${numero} ${rep}` : numero
}

/**
 * Recipe registered with the corpus builder.
 */
export const frLieuditRecipe: CorpusRecipe = {
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

		if (!pool.length) {
			throw new Error(`No clean lieu-dit rows found under ${banDir} — see ban/sdk/extract.ts's cleanLieuDit filter.`)
		}

		// The recipe shares one mulberry32 stream between this shuffle and the country-fraction
		// draw below, so a fresh generator here would move every later draw and the committed rows.
		shuffleWith(pool, random)

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

			// The envelope form is the house and street line, the lieu-dit alone on its own line,
			// then the postcode and commune line. That is La Poste's line 5.
			let raw = formatAddress(components, "FR")

			if (!raw) {
				skipped++

				continue
			}

			// Country-append: ~`countryFraction` of the time, append an explicit "France" surface
			// form onto the trailing (postcode+commune) line plus a `country` component. The model
			// relearns to emit country when present without over-firing it on the country-less
			// rows. `countryFraction <= 0` (the default) never draws from `random`, so the
			// byte-stream is unaffected when the flag is unset.
			if (countryFraction > 0 && random() < countryFraction) {
				const forms = COUNTRY_SURFACE_FORMS.FR
				const form = sample(forms, random)
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

			write(stringifyJSON({ ...aligned.row, synth_method: source, synth_base_id: null }))

			emitted++
		}

		console.error(`  emitted=${emitted} skipped=${skipped} country-appended=${countryAppended} pool=${pool.length}`)

		return { emitted, skipped }
	},
}
