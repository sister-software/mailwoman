/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads GeoNames physical features (seas and undersea terrain, water, landforms, parks and vegetation) from a
 *   country dump and emits rows that label each feature's name as `venue`.
 *
 *   A search for `Mariana Trench` or `Lake Tahoe, California` asks for a place that has a name and no address.
 *   The corpus held no such rows before this source (#2897), so the parser had never read a bare physical-feature
 *   name. Each feature renders bare, with its own country, and with its region where GeoNames records one.
 *
 *   The dump holds 5,076,239 such features in 16,318 (country, feature code) cells on 2026-11-02, and 991,667 of them
 *   are streams (feature code `STM`). A cell keeps at most {@linkcode GEONAMES_FEATURES_PER_CELL} features, chosen by the lowest hash of their
 *   geonameid, so every feature code of every country is represented and no one class dominates.
 */

import { componentsPresentIn } from "@mailwoman/codex/address/format"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	GEONAMES_DEFAULT_LICENSE,
	GEONAMES_MAIN_COLUMNS as COL,
	loadAdmin1,
	loadCountries,
} from "#adapters/geonames/adapter"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * The source ID on rows from this adapter.
 */
export const GEONAMES_FEATURES_ADAPTER_ID = "geonames-features"

/**
 * The GeoNames feature classes this adapter reads: undersea (`U`), water (`H`),
 * terrain (`T`), parks and areas (`L`) and vegetation (`V`).
 */
export const GEONAMES_FEATURE_CLASSES: ReadonlySet<string> = new Set(["U", "H", "T", "L", "V"])

/**
 * The most features one (country, feature code) cell contributes.
 *
 * At 25 the dump yields 176,158 features, about 528,000 rows, against 95,086
 * features at 10 and 272,765 at 50.
 */
export const GEONAMES_FEATURES_PER_CELL = 25

/**
 * One feature the cap kept.
 */
interface KeptFeature {
	hash: number
	geonameid: string
}

/**
 * The geonameids each cell keeps: its {@linkcode GEONAMES_FEATURES_PER_CELL} lowest hashes.
 */
async function keptFeatureIDs(input: PathBuilder, country: string | undefined): Promise<Set<string>> {
	const cells = new Map<string, KeptFeature[]>()

	for await (const rec of readUnquotedTSV(input)) {
		const cls = rec[COL.featureClass] ?? ""

		if (!GEONAMES_FEATURE_CLASSES.has(cls)) continue
		const cc = (rec[COL.country] ?? "").trim()

		if (!cc || (country && cc !== country)) continue
		const geonameid = (rec[COL.geonameid] ?? "").trim()

		if (!geonameid || !(rec[COL.name] ?? "").trim()) continue
		const key = `${cc}\t${rec[COL.featureCode] ?? ""}`
		const kept = cells.get(key) ?? []
		const hash = hashFNV1a(geonameid)

		if (kept.length < GEONAMES_FEATURES_PER_CELL) {
			kept.push({ hash, geonameid })
			cells.set(key, kept)
		} else {
			let highest = 0

			for (let i = 1; i < kept.length; i++)
				if (kept[i]!.hash > kept[highest]!.hash) {
					highest = i
				}

			if (hash < kept[highest]!.hash) {
				kept[highest] = { hash, geonameid }
			}
		}
	}

	return new Set([...cells.values()].flatMap((kept) => kept.map((feature) => feature.geonameid)))
}

/**
 * Creates the GeoNames physical-feature adapter.
 */
export function createGeonamesFeaturesAdapter(): CorpusAdapter {
	return {
		id: GEONAMES_FEATURES_ADAPTER_ID,
		defaultLicense: GEONAMES_DEFAULT_LICENSE,
		// A natural feature is no premise, office or facility, and it stays out of the premise street index.
		addressRole: AddressRole.Other,
		register: SourceRegister.GeoNames,
		surface: SurfaceOrigin.Rendered,
		description:
			"GeoNames physical features (CC-BY-4.0): seas, undersea terrain, water bodies, landforms, parks and forests, labeled as venue.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// The input is one dump (`allCountries.txt`) or a directory of country dumps (`US.txt`, `MP.txt`).
			const input = PathBuilder.from(opts.inputPath)
			const inputIsDirectory = await isDirectory(input)
			const dir = inputIsDirectory ? input : input.dirname()

			const dumps = inputIsDirectory
				? (
						await Globerator.from(opts.country ? `${opts.country}.txt` : "[A-Z][A-Z].txt", {
							cwd: input.toString(),
						}).toArray()
					)
						.toSorted(compareByScalarValue)
						.map((name: string) => input(name))
				: [input]

			const admin1 = await loadAdmin1(dir)
			const countries = await loadCountries(dir)
			let emitted = 0

			for (const dump of dumps) {
				yield* rowsOf(dump)
			}

			async function* rowsOf(dump: PathBuilder): AsyncIterable<CanonicalRow> {
				const kept = await keptFeatureIDs(dump, opts.country)

				for await (const rec of readUnquotedTSV(dump)) {
					if (opts.signal?.aborted) break

					if (typeof opts.limit === "number" && emitted >= opts.limit) break
					const geonameid = (rec[COL.geonameid] ?? "").trim()

					if (!kept.has(geonameid)) continue
					const cc = (rec[COL.country] ?? "").trim()
					const venue = (rec[COL.name] ?? "").trim()
					const region = admin1.get(`${cc}.${(rec[COL.admin1] ?? "").trim()}`)
					const country = countries.get(cc)

					const variants: Array<{ slot: string; comp: CanonicalRow["components"]; raw: string }> = [
						{ slot: "v", comp: { venue }, raw: venue },
					]

					if (country) {
						variants.push({ slot: "vc", comp: { venue, country }, raw: `${venue}, ${country}` })
					}

					if (region && region !== venue) {
						variants.push({ slot: "vr", comp: { venue, region }, raw: `${venue}, ${region}` })
					}

					for (const variant of variants) {
						if (typeof opts.limit === "number" && emitted >= opts.limit) break
						const aligned = componentsPresentIn(variant.comp, variant.raw)

						if (!aligned.venue) continue

						yield {
							raw: variant.raw,
							components: aligned,
							country: cc,
							source: GEONAMES_FEATURES_ADAPTER_ID,
							source_id: `${GEONAMES_FEATURES_ADAPTER_ID}-${geonameid}-${variant.slot}`,
							license: GEONAMES_DEFAULT_LICENSE,
						}

						emitted++
					}
				}
			}
		},
	}
}

/**
 * The adapter instance registered with the corpus builder.
 */
export const geonamesFeaturesAdapter = createGeonamesFeaturesAdapter()
