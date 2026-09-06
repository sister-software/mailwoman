/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `german` slice recipe — German coverage rows from REAL OpenAddresses tuples (Berlin + Saxony,
 *   cached zips). Each sampled tuple is rendered via {@link synthesizeGermanRow} in BOTH orders —
 *   `--intl-fraction` (default 0.4) in international order (house-first / postcode-after-city), the
 *   rest in idiomatic German order — then aligned to BIO. Generate-mode: it builds a tuple pool
 *   from the cached zips, then draws `--count` rows from it with the passed `random` (so the emit
 *   stream matches the legacy reservoir-sample loop). Ported from scripts/build-german-slice.mjs.
 *
 *   ORDER ROBUSTNESS (2026-06-06): mixing the two renderings stops a native-only slice from teaching
 *   German order so well it reads the US/feed-order eval as a "collapse". See
 *   docs/articles/evals/resolver-geo/2026-06-06-anchor-pilot.md (the order-artifact correction).
 *
 *   TWO REGISTERS THE OA TUPLES DO NOT CARRY (#1946). A comma-free single line — `Neusser Str. 12 Nippes
 *   50733 Köln`, the dictation / one-field-form register — segments as ONE unit at stage 2, and with one
 *   segment the placetype-pair prior never fires, so the model reads `Nippes` as a second street and the
 *   one-value-per-tag projection deletes it. `--comma-free-fraction` renders that many native-order rows
 *   with `" "` as the line separator. And OA rows have no district at all, so `--ortsteil-fraction` rows
 *   borrow a WOF Ortsteil of the tuple's own locality as `dependent_locality` — 67,532 DE neighbourhoods
 *   carry a locality ancestor in the admin database, `Köln-Nippes` among them. The German spelling is
 *   recovered from the `names` table ({@link ortsteilSurface}): WOF's `spr.name` for DE neighbourhoods is
 *   the ASCII-folded label (`Bocklemuend`), which no German ever types.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { stableSourceID } from "#adapters/utils"
import { readZippedCSVRecords, type CorpusRecipe } from "#recipes/scaffold"
import { synthesizeGermanRow, type LocaleBaseTuple } from "#synthesizers/german"
import { alignRow } from "#utils"

/**
 * A German OA source (cached zip) + the Bundesland the file covers (OA's REGION column is empty for DE).
 */
interface GermanSource {
	zip: PathBuilderLike
	csv: string
	region: string
}

/**
 * `region` is the Bundesland the source covers. OA's REGION column is empty for DE, but the region is implied by the
 * per-state file — the international order needs it for the "City, Region Postcode" tail (v0.9.3 / #327). berlin.csv →
 * Berlin (a city-state, region==locality); sn/statewide → Sachsen.
 */
const SOURCES: GermanSource[] = [
	{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", region: "Berlin" },
	{ zip: dataRootPath("oa-cache", "de__sn__statewide.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
]

/**
 * The two ASCII spellings WOF uses for one German label, so a `names.deu` row can be matched to the `spr.name` it
 * spells. WOF folds `Bocklemünd` to `Bocklemuend` in one record and `Schöneberg` to `Schoneberg` in another — the
 * transliteration (`ö` → `oe`, `ß` → `ss`) and the plain diacritic strip (`ö` → `o`) both occur — so a match is against
 * either form, lower-cased.
 */
function foldGerman(surface: string): [transliterated: string, stripped: string] {
	const lower = surface.toLowerCase()

	const stripped = lower
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "")
		.replaceAll("ß", "ss")

	const transliterated = lower
		.replaceAll("ä", "ae")
		.replaceAll("ö", "oe")
		.replaceAll("ü", "ue")
		.replaceAll("ß", "ss")
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "")

	return [transliterated, stripped]
}

/**
 * Whether two surfaces spell the same German label under either of WOF's folds.
 */
function sameGermanLabel(left: string, right: string): boolean {
	const [leftT, leftS] = foldGerman(left)
	const [rightT, rightS] = foldGerman(right)

	return leftT === rightT || leftS === rightS || leftT === rightS || leftS === rightT
}

/**
 * The surface an Ortsteil is written with in an address, from WOF's rows for it.
 *
 * `spr.name` for a DE neighbourhood is the ASCII-folded label; the `names` rows in `deu` carry the German spelling
 * beside unrelated labels for co-located features (`Bocklemuend` → `Bocklemünd`, `Jüdischer Friedhof Bocklemünd`,
 * `Menara-Garten`). The German name is the one that spells the same label as `spr.name` under either of WOF's ASCII
 * folds ({@link foldGerman}); with none, `spr.name` stands. WOF also prefixes some Ortsteile with their city
 * (`Köln-Nippes`), a form no envelope carries once the city is its own line, so a leading `<locality>-` is dropped when
 * something is left after it.
 */
export function ortsteilSurface(sprName: string, deuNames: readonly string[], locality: string): string {
	const german = deuNames.find((name) => sameGermanLabel(name, sprName)) ?? sprName
	const prefix = `${locality}-`

	return german.toLowerCase().startsWith(prefix.toLowerCase()) && german.length > prefix.length
		? german.slice(prefix.length)
		: german
}

/**
 * Every current DE neighbourhood with a locality ancestor, keyed by the folded locality name → Ortsteil surfaces. Empty
 * when the admin database is not readable; the recipe then emits no Ortsteil rows and says so, rather than failing a
 * build over an optional register.
 */
async function readOrtsteilPool(adminDB: string): Promise<Map<string, string[]>> {
	const pool = new Map<string, string[]>()

	if (!(await pathExists(adminDB))) return pool

	using db = new DatabaseClient<WOFDatabase>(adminDB, { readOnly: true })

	const rows = await db
		.selectFrom("spr as s")
		.innerJoin("ancestors as a", "a.id", "s.id")
		.innerJoin("spr as p", "p.id", "a.ancestor_id")
		.select(["s.id as id", "s.name as name", "p.name as locality"])
		.where("s.country", "=", "DE")
		.where("s.placetype", "=", "neighbourhood")
		.where("s.is_current", "=", 1)
		.where("s.is_deprecated", "=", 0)
		.where("a.ancestor_placetype", "=", "locality")
		.execute()

	const deuNames = new Map<number, string[]>()

	for (const row of await db
		.selectFrom("names")
		.select(["id", "name"])
		.where("country", "=", "DE")
		.where("placetype", "=", "neighbourhood")
		.where("language", "=", "deu")
		.execute()) {
		const list = deuNames.get(row.id) ?? []

		list.push(row.name)
		deuNames.set(row.id, list)
	}

	for (const row of rows) {
		if (!row.name || !row.locality) continue

		const surface = ortsteilSurface(row.name, deuNames.get(row.id) ?? [], row.locality)
		const key = row.locality.toLowerCase()
		const list = pool.get(key) ?? []

		if (!list.includes(surface)) {
			list.push(surface)
		}

		pool.set(key, list)
	}

	return pool
}

/**
 * Stream real German tuples out of a cached OA zip.
 */
async function readGermanTuples(source: GermanSource): Promise<LocaleBaseTuple[]> {
	const tuples: LocaleBaseTuple[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		const street = row.street ?? ""
		const locality = row.city ?? ""

		if (!street || !locality) continue
		const house_number = row.number ?? ""
		const postcode = row.postcode ?? ""
		// OA's REGION column is empty for DE — fall back to the source's Bundesland (set per file).
		const region = row.region || source.region || ""
		const key = `${house_number}|${street}|${locality}|${postcode}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, region, postcode })
	}

	return tuples
}

/**
 * Slice recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const germanRecipe: CorpusRecipe = {
	name: "german",
	description: "German coverage rows from real OA tuples (Berlin/Saxony), both orders → synthesizeGermanRow",
	mode: "generate",
	options: [
		{ flag: "--intl-fraction <f>", description: "Fraction rendered international order. Default 0.4" },
		{
			flag: "--comma-free-fraction <f>",
			description:
				"Fraction of native-order rows rendered with no commas (the single-line register, #1946). Default 0.3",
		},
		{
			flag: "--ortsteil-fraction <f>",
			description: "Fraction of rows carrying a WOF Ortsteil of the locality as dependent_locality. Default 0.3",
		},
		{
			flag: "--admin-db <path>",
			description:
				"WOF admin database for the Ortsteil pool. Default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority-importance.db",
		},
	],
	async run(opts, write) {
		// Emit PRNG: the legacy build-german-slice.mjs seeded mulberry32(opts.seed).
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-german"
		const intlFraction = opts.intlFraction ?? 0.4
		const commaFreeFraction = opts.commaFreeFraction ?? 0.3
		const ortsteilFraction = opts.ortsteilFraction ?? 0.3

		for (const [flag, value] of [
			["--intl-fraction", intlFraction],
			["--comma-free-fraction", commaFreeFraction],
			["--ortsteil-fraction", ortsteilFraction],
		] as const) {
			if (!(value >= 0 && value <= 1)) {
				throw new Error(`${flag} must be in [0, 1], got ${value}`)
			}
		}

		const adminDB = opts.adminDB ?? String(dataRootPath("wof", "admin-global-priority-importance.db"))
		const ortsteile = ortsteilFraction > 0 ? await readOrtsteilPool(adminDB) : new Map<string, string[]>()

		if (ortsteilFraction > 0) {
			console.error(
				ortsteile.size
					? `  Ortsteil pool: ${[...ortsteile.values()].reduce((n, list) => n + list.length, 0)} surfaces under ${ortsteile.size} localities (${adminDB})`
					: `  Ortsteil pool: none — ${adminDB} is not readable, so no row carries a dependent_locality`
			)
		}

		const count = opts.count ?? 4000

		// Pool real tuples from every German source, then sample `count` rows from it.
		const pool: LocaleBaseTuple[] = []

		for (const s of SOURCES) {
			const t = await readGermanTuples(s)

			console.error(`  ${s.csv}: ${t.length} unique tuples`)

			for (const x of t) {
				pool.push(x)
			} // NOT pool.push(...t) — spreading ~840K args overflows the stack
		}

		if (!pool.length) {
			throw new Error(`No German tuples found — are the cached zips present in ${dataRootPath("oa-cache")}?`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		let withOrtsteil = 0
		let commaFree = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const drawn = pool[Math.floor(random() * N)]!
			// Per-row order: `--intl-fraction` of rows render house-first / postcode-after-city (the US/feed
			// layout), the rest in idiomatic German order. Same components either way.
			const order = random() < intlFraction ? "international" : "native"
			// The two registers OA never wrote (#1946), each drawn independently of the order so every combination
			// occurs: an Ortsteil borrowed from the tuple's own locality, and a native line with no commas.
			const localOrtsteile = ortsteile.get(drawn.locality.toLowerCase())

			const ortsteil =
				localOrtsteile && random() < ortsteilFraction
					? localOrtsteile[Math.floor(random() * localOrtsteile.length)]
					: undefined

			const base: LocaleBaseTuple = ortsteil ? { ...drawn, dependent_locality: ortsteil } : drawn
			const separator = order === "native" && random() < commaFreeFraction ? " " : ", "
			const synth = synthesizeGermanRow(base, { random, order, separator })

			if (!synth) {
				skipped++

				continue
			}

			// --golden: emit per-locale-f1 eval rows ({raw, components}) instead of aligned BIO. `order`
			// rides along so the eval can stratify native vs international.
			if (opts.golden) {
				write(JSON.stringify({ raw: synth.raw, components: synth.components, country: "DE", order }) + "\n")

				emitted++

				continue
			}

			const sourceID = stableSourceID(source, {
				street: synth.components.street,
				house_number: synth.components.house_number,
				locality: synth.components.locality,
				postcode: synth.components.postcode,
			})

			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country: "DE",
				locale: synth.locale,
				source,
				source_id: sourceID,
				corpus_version: "0.4.0",
				license: `OpenAddresses DE (Berlin/Saxony) tuples, rendered ${order}-order — see ingest SOURCES`,
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(
				JSON.stringify({
					...aligned.row,
					synth_method: "german",
					synth_order: order,
					synth_separator: separator === " " ? "space" : "comma",
					synth_base_id: null,
				}) + "\n"
			)

			emitted++

			if (ortsteil) {
				withOrtsteil++
			}

			if (separator === " ") {
				commaFree++
			}
		}

		console.error(`  emitted ${emitted}: ${withOrtsteil} with an Ortsteil, ${commaFree} comma-free`)

		return { emitted, skipped }
	},
}
