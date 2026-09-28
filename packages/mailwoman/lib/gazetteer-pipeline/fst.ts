/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Per-locale FST gazetteer build (`mailwoman gazetteer build fst`) — the decode-bias FST shipped as
 * `fst-<locale>.bin` in the weights packages, rebuilt with degenerate-surface curation.
 *
 * A name whose normalized surface is a bare function word, a bare street-type word, or a composition
 * of only function words is never inserted as a bias key, because the hazard is removed from the
 * artifact rather than guarded at decode time, so it cannot misfire on lowercase, comma-free,
 * any-locale input. The resolver's candidate tables are untouched, so excluded places stay findable.
 *
 * Exclusion sources are the shipped libpostal dictionaries. The language set is uniform across locales
 * because a FR query hits the en-us FST on the default path.
 *
 * Provenance (policy string + excluded-insertion count) is recorded in the artifact trailer.
 * artifacts are written to `--output` (default: a `fst-per-locale-curated/` sibling of the shipped
 * `fst-per-locale/`) — staged beside, never overwriting.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { resourceDictionaryPathBuilder } from "@mailwoman/core/paths"
import {
	buildFSTFromWOF,
	fstStaleReason,
	peekFSTStampFields,
	readWOFSourceIdentity,
	normalizeTokens,
	serializeFST,
} from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { DEFAULT_ADMIN_DB } from "#gazetteer-pipeline/defaults"

/**
 * The served Latin-script language tiers (see scope.mdx) — uniform curation set for every locale FST.
 */
export const CURATION_LANGUAGES = [
	"en",
	"fr",
	"de",
	"nl",
	"es",
	"it",
	"pt",
	"da",
	"nb",
	"sv",
	"fi",
	"pl",
	"cs",
	"sk",
	"sl",
	"hr",
	"hu",
] as const

/**
 * Identifies which exclusion policy built an FST, so a stale index built under an
 * older policy is detectable rather than silently mixed with a new one.
 */
export const EXCLUSION_POLICY_ID =
	"degenerate-surface-exclusion v1.1 (libpostal stopwords+street_types, 17 langs, + supplemental)"

/**
 * Function-word surfaces the libpostal dictionaries miss.
 *
 * A candidate belongs here only when it is a common function word in a served
 * language whose libpostal stopword file lacks the bare form.
 */
export const SUPPLEMENTAL_DEGENERATE_SURFACES: ReadonlySet<string> = new Set([
	// Dutch/Danish preposition ("op de hoek", "op til"), absent from nl/da stopwords.txt as a bare word.
	"op",
])

/**
 * The shipped per-locale FST set.
 *
 * An overlay absent here ships with no FST, so `--gazetteer-prior` is a silent
 * no-op for it and the run degrades to the base model.
 */
export const FST_LOCALES: ReadonlyMap<string, string[]> = new Map([
	["en-us", ["US"]],
	["fr-fr", ["FR"]],
	["en-gb", ["GB"]],
	["de-de", ["DE"]],
	["es-es", ["ES"]],
	["it-it", ["IT"]],
	// The CJK three serve the autocomplete tier's place FST and the Photon drop-in's
	// type-ahead, while the char-path model reads no FST prior.
	["ja-jp", ["JP"]],
	["zh-cn", ["CN"]],
	["ko-kr", ["KR"]],
])

/**
 * Every FST artifact that is a projection of the WOF admin DB, relative to the wof data-root dir.
 *
 * `fst-street-morphology.bin` and the retired `fst-global-priority.bin` are deliberately absent
 * so they cannot generate freshness rows that read as a rebuild obligation.
 * The CJK three are listed despite having no {@link FST_LOCALES} entry because no tool can rebuild them.
 */
export const ADMIN_DERIVED_FST_ARTIFACTS: readonly string[] = [
	"fst-per-locale/fst-en-us.bin",
	"fst-per-locale/fst-fr-fr.bin",
	"fst-per-locale/fst-en-gb.bin",
	"fst-per-locale/fst-de-de.bin",
	"fst-per-locale/fst-es-es.bin",
	"fst-per-locale/fst-it-it.bin",
	"fst-per-locale/fst-ja-jp.bin",
	"fst-per-locale/fst-zh-cn.bin",
	"fst-per-locale/fst-ko-kr.bin",
]

/**
 * One artifact's verdict against the admin DB it should have been built from.
 */
export interface FSTFreshnessRow {
	artifact: string
	present: boolean
	/**
	 * `undefined` = current.
	 * Otherwise the prose from `fstStaleReason`.
	 */
	staleReason?: string
	builtAt?: string
	rebuildCommand: string
}

/**
 * Check every admin-derived FST against `dbPath`, for the `gazetteer verify` freshness section.
 *
 * A stale FST makes no statement about whether the database is sound, so this reports
 * rather than fails and leaves the exit code to the caller.
 * The exclusion-policy expectation applies only to locales the current builder can produce,
 * so a frozen artifact is not reported against a policy it cannot rebuild.
 */
export async function checkAdminDerivedFSTFreshness(dbPath: PathBuilderLike): Promise<FSTFreshnessRow[]> {
	const source = await readWOFSourceIdentity(dbPath)

	const rows: FSTFreshnessRow[] = []

	for (const relative of ADMIN_DERIVED_FST_ARTIFACTS) {
		const path = wofDatabasePath(relative)
		const locale = /fst-per-locale\/fst-(?<locale>[a-z]{2}-[a-z]{2})\.bin$/.exec(relative)?.groups?.locale
		const buildable = locale !== undefined && FST_LOCALES.has(locale)

		const rebuildCommand = buildable
			? `mailwoman gazetteer build fst --locales ${locale}`
			: `NO BUILDER — ${locale ?? "this artifact"} has no FST_LOCALES entry (built by the pre-#1318 flow)`

		if (!(await pathExists(path))) {
			rows.push({ artifact: relative, present: false, rebuildCommand })

			continue
		}

		const fields = await peekFSTStampFields(path)

		const staleReason = fstStaleReason(fields, {
			source,
			...(buildable ? { exclusionPolicy: EXCLUSION_POLICY_ID } : {}),
		})

		rows.push({
			artifact: relative,
			present: true,
			...(staleReason === undefined ? {} : { staleReason }),
			...(fields?.provenance?.builtAt ? { builtAt: fields.provenance.builtAt } : {}),
			rebuildCommand,
		})
	}

	return rows
}

/**
 * One dictionary line is `canonical|variant|variant…`, in which every pipe-separated form is a surface.
 */
function surfacesOfLine(line: string): string[] {
	return TextSpliterator.from(line, { delimiter: "|" }).toArray()
}

/**
 * Load the degenerate-surface exclusion sets from the shipped libpostal dictionaries.
 *
 * @returns Normalized-join keys (`normalizeTokens(surface).join(" ")`)
 * so they compare exactly against the builder's insertion keys.
 */
export async function loadDegenerateSurfaces(
	languages: readonly string[] = CURATION_LANGUAGES,
	fold: (surface: string) => string[] = normalizeTokens
): Promise<{
	surfaces: Set<string>
	stopwordTokens: Set<string>
}> {
	// Keyed by fold identity then language set, because the FST and painter worlds
	// fold differently by design and must not share an entry.
	// The returned sets are shared and `buildLocalitySurfaceLexicon` mutates its copy,
	// so this hands back a fresh shallow copy per call and caches only the parse.
	let byLanguages = degenerateSurfacesMemo.get(fold)

	if (!byLanguages) {
		byLanguages = new Map()
		degenerateSurfacesMemo.set(fold, byLanguages)
	}

	const key = languages.join(",")
	let parsed = byLanguages.get(key)

	if (!parsed) {
		parsed = await scanDegenerateSurfaces(languages, fold)
		byLanguages.set(key, parsed)
	}

	return { surfaces: new Set(parsed.surfaces), stopwordTokens: new Set(parsed.stopwordTokens) }
}

const degenerateSurfacesMemo = new Map<
	(surface: string) => string[],
	Map<string, { surfaces: Set<string>; stopwordTokens: Set<string> }>
>()

async function scanDegenerateSurfaces(
	languages: readonly string[],
	fold: (surface: string) => string[]
): Promise<{
	surfaces: Set<string>
	stopwordTokens: Set<string>
}> {
	const dictionariesDir = resourceDictionaryPathBuilder("libpostal")
	const surfaces = new Set<string>()
	const stopwordTokens = new Set<string>()

	for (const lang of languages) {
		for (const [file, isStopwords] of [
			["stopwords.txt", true],
			["street_types.txt", false],
		] as const) {
			const path = dictionariesDir(lang, file)

			if (!(await pathExists(path))) continue

			for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
				for (const surface of surfacesOfLine(line)) {
					const tokens = fold(surface)

					if (!tokens.length) continue
					surfaces.add(tokens.join(" "))

					// Compositional clause sources from stopwords only: single-token entries,
					// so multi-word stopword phrases ("à côté de") never leak their content words in.
					if (isStopwords && tokens.length === 1) {
						stopwordTokens.add(tokens[0]!)
					}
				}
			}
		}
	}

	for (const s of SUPPLEMENTAL_DEGENERATE_SURFACES) {
		const tokens = fold(s)

		if (!tokens.length) continue
		surfaces.add(tokens.join(" "))

		if (tokens.length === 1) {
			stopwordTokens.add(tokens[0]!)
		}
	}

	return { surfaces, stopwordTokens }
}

/**
 * Surface-ambiguity scan: one pass over the whole admin DB (every country, the builder's default placetypes)
 * producing normalized-surface → distinct-country count.
 *
 * The count is deliberately global so a US-scoped FST still knows a surface is also a place elsewhere.
 * Primary spr names and all alt names feed it.
 */
export async function computeSurfaceCountryCounts(source: PathBuilderLike): Promise<Map<string, number>> {
	const dbPath = resolvePath(source)
	const { mtimeMs, size } = await statPath(dbPath)
	const memoKey = `${dbPath}\0${mtimeMs}\0${size}`
	const hit = surfaceCountryCountsMemo.get(memoKey)

	if (hit) return hit

	const counts = scanSurfaceCountryCounts(dbPath)
	surfaceCountryCountsMemo.set(memoKey, counts)

	return counts
}

/**
 * Memo for {@link computeSurfaceCountryCounts}, keyed on (path, mtimeMs, size) because the WOF admin
 * DB is a sealed readonly artifact a rebuild replaces, so a path-only key would serve a stale scan.
 *
 * The returned map is shared with every caller.
 * Callers treat it as read-only. a future mutating caller must copy first.
 */
const surfaceCountryCountsMemo = new Map<string, Map<string, number>>()

function scanSurfaceCountryCounts(dbPath: string): Map<string, number> {
	using db = new DatabaseClient<WOFDatabase>(dbPath, { open: true })
	const placetypes = ["country", "region", "county", "locality", "localadmin", "borough", "neighbourhood"]
	const ph = placetypes.map(() => "?").join(",")
	// A Set per surface OOMs a default heap at millions of rows, so store the first country
	// as a bare string and promote to an overflow Set only on the second distinct country.
	const first = new Map<string, string>()
	const overflow = new Map<string, Set<string>>()

	const paint = (surface: string, country: string): void => {
		const key = normalizeTokens(surface).join(" ")

		if (!key || !country) return
		const seen = first.get(key)

		if (seen === undefined) {
			first.set(key, country)

			return
		}

		if (seen === country) return
		let set = overflow.get(key)

		if (set === undefined) {
			set = new Set([seen])
			overflow.set(key, set)
		}

		set.add(country)
	}

	const primary = db.prepare(`SELECT country, name FROM spr WHERE is_current = 1 AND placetype IN (${ph})`)

	for (const row of primary.iterate(...placetypes) as Iterable<{ country: string; name: string }>) {
		paint(row.name, row.country)
	}

	const alts = db.prepare(
		`SELECT s.country AS country, n.name AS name FROM names n JOIN spr s ON s.id = n.id
		 WHERE s.is_current = 1 AND s.placetype IN (${ph})`
	)

	for (const row of alts.iterate(...placetypes) as Iterable<{ country: string; name: string }>) {
		paint(row.name, row.country)
	}

	const counts = new Map<string, number>()

	for (const key of first.keys()) {
		counts.set(key, overflow.get(key)?.size ?? 1)
	}

	return counts
}

export interface BuildLocaleFSTsOpts {
	/**
	 * Locales to build (default: every FST_LOCALES key).
	 */
	locales?: string[]
	/**
	 * WOF admin DB (default: `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db`).
	 */
	dbPath?: PathBuilderLike
	/**
	 * Output dir (default: `$MAILWOMAN_DATA_ROOT/db/wof/fst-per-locale-curated`).
	 *
	 * Never the shipped dir.
	 */
	outputDir?: PathBuilderLike
	/**
	 * Skip the curation (an A/B control build with the same current DB).
	 */
	uncurated?: boolean
	onProgress?: (line: string) => void
}

export interface BuiltLocaleFST {
	locale: string
	path: string
	bytes: number
	nameInsertions: number
	excludedInsertions: number
}

export async function buildLocaleFSTs(opts: BuildLocaleFSTsOpts = {}): Promise<BuiltLocaleFST[]> {
	const locales = opts.locales ?? [...FST_LOCALES.keys()]
	const dbPath = opts.dbPath ?? wofDatabasePath(DEFAULT_ADMIN_DB)
	const outputDir = resolvePathBuilder(opts.outputDir ?? wofDatabasePath("fst-per-locale-curated"))
	const progress = opts.onProgress ?? (() => {})

	const exclusion = opts.uncurated ? undefined : await loadDegenerateSurfaces()

	if (exclusion) {
		progress(
			`curation: ${exclusion.surfaces.size} whole surfaces + ${exclusion.stopwordTokens.size} stopword tokens (${EXCLUSION_POLICY_ID})`
		)
	}

	// Ambiguity classes ride the curated builds only.
	// The uncurated control stays a pure pre-curation byte baseline.
	// Every locale shares one global scan.
	const surfaceCountryCounts = opts.uncurated ? undefined : await computeSurfaceCountryCounts(dbPath)

	if (surfaceCountryCounts) {
		progress(`ambiguity: ${surfaceCountryCounts.size} surfaces scanned across all countries`)
	}

	await makeDirectories(outputDir)

	const built: BuiltLocaleFST[] = []

	for (const locale of locales) {
		const countries = FST_LOCALES.get(locale)

		if (!countries) throw new Error(`unknown FST locale ${locale} — add it to FST_LOCALES with its country scope`)

		progress(`building fst-${locale} (countries=[${countries}]) from ${dbPath}`)

		const { matcher, provenance } = await buildFSTFromWOF({
			dbPath,
			countries,
			...(exclusion
				? {
						excludeSurfaces: exclusion.surfaces,
						excludeAllTokensOf: exclusion.stopwordTokens,
						exclusionPolicy: EXCLUSION_POLICY_ID,
					}
				: {}),
			...(surfaceCountryCounts ? { surfaceCountryCounts } : {}),
			onProgress: (phase, detail) => progress(`  [${phase}] ${detail ?? ""}`),
		})

		const outPath = outputDir(`fst-${locale}${opts.uncurated ? ".uncurated" : ""}.bin`)
		const bytes = serializeFST(matcher, provenance)
		await writeLocalFile(bytes, outPath)

		built.push({
			locale,
			path: outPath.toString(),
			bytes: bytes.length,
			nameInsertions: provenance.nameInsertions,
			excludedInsertions: provenance.excludedInsertions ?? 0,
		})

		progress(
			`  wrote ${outPath} (${ByteFormatter.formatIEC(bytes.length)}, ${provenance.nameInsertions} insertions, ${provenance.excludedInsertions ?? 0} excluded)`
		)
	}

	return built
}
