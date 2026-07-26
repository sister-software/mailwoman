/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-locale FST gazetteer build (`mailwoman gazetteer build fst`) — the decode-bias FST shipped as
 *   `fst-<locale>.bin` in the weights packages (#1318), rebuilt WITH degenerate-surface curation.
 *
 *   THE CURATION (the "serialize runtime decisions into static indexes" doctrine): a name whose whole
 *   normalized surface is a bare function word ("la" — the case-folded Los Angeles alias colliding
 *   with the French article), a bare street-type word ("boulevard", "lane" — real US places that are
 *   street vocabulary everywhere else), or a composition of nothing but function words ("de la") is
 *   NEVER inserted as a bias key. This is the ASR-contextual-biasing "prune the bias list" discipline
 *   and Carmen's index-time token hygiene: the hazard is removed from the artifact rather than
 *   guarded at decode time, so it cannot misfire on lowercase, comma-free, any-locale input. The FST
 *   is a bias list, not the gazetteer of record — the resolver's candidate tables are untouched, so
 *   excluded places stay findable; they just stop nudging the decoder on degenerate keys.
 *
 *   Exclusion sources are the SHIPPED libpostal dictionaries (`core/data/libpostal/dictionaries/`):
 *   per-language `stopwords.txt` (whole-surface + compositional clauses) and `street_types.txt`
 *   (whole-surface clause only — "Avenue Road" is a real name; "de la" is not). The language set is
 *   the served Latin-script tiers, uniform across locales (a FR query hits the en-us FST on the
 *   default path, so per-locale language scoping would under-curate).
 *
 *   Provenance (policy string + excluded-insertion count) is recorded in the artifact trailer.
 *   Artifacts are written to --output (default: a `fst-per-locale-curated/` sibling of the shipped
 *   `fst-per-locale/` dir) — staged BESIDE, never overwriting; the swap into the shipped path is
 *   operator-gated after the battery.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath, repoRootPathBuilder } from "@mailwoman/core/utils"
import { buildFSTFromWOF } from "@mailwoman/resolver-wof-sqlite/fst-builder"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { serializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"

/** The served Latin-script language tiers (see SCOPE.mdx) — uniform curation set for every locale FST. */
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

export const EXCLUSION_POLICY_ID =
	"degenerate-surface-exclusion v1.1 (libpostal stopwords+street_types, 17 langs, + supplemental)"

/**
 * Function-word surfaces the libpostal dictionaries MISS. Each entry carries its justification — this list is curated,
 * not a dumping ground; a candidate belongs here only when it is a common function word in a served language whose
 * libpostal stopword file lacks the bare form.
 */
export const SUPPLEMENTAL_DEGENERATE_SURFACES: ReadonlySet<string> = new Set([
	// Dutch/Danish preposition ("op de hoek", "op til") — absent from libpostal nl/da stopwords.txt as
	// a bare word. Shipped-index victim: the Overland Park "OP" initialism alias (wof 85945755).
	"op",
])

/** The shipped per-locale FST set (provenance-recovered country scoping; en-nz deliberately has none). */
export const FST_LOCALES: ReadonlyMap<string, string[]> = new Map([
	["en-us", ["US"]],
	["fr-fr", ["FR"]],
	["en-gb", ["GB"]],
	["de-de", ["DE"]],
])

/** One dictionary line = canonical|variant|variant… — every pipe-separated form is a surface. */
function surfacesOfLine(line: string): string[] {
	return line
		.split("|")
		.map((s) => s.trim())
		.filter(Boolean)
}

/**
 * Load the degenerate-surface exclusion sets from the shipped libpostal dictionaries. Returns normalized-join keys
 * (`normalizeTokens(surface).join(" ")`) so they compare exactly against the builder's insertion keys.
 */
export function loadDegenerateSurfaces(languages: readonly string[] = CURATION_LANGUAGES): {
	surfaces: Set<string>
	stopwordTokens: Set<string>
} {
	const dictionariesDir = String(repoRootPathBuilder("core", "data", "libpostal", "dictionaries"))
	const surfaces = new Set<string>()
	const stopwordTokens = new Set<string>()

	for (const lang of languages) {
		for (const [file, isStopwords] of [
			["stopwords.txt", true],
			["street_types.txt", false],
		] as const) {
			const path = join(dictionariesDir, lang, file)

			if (!existsSync(path)) continue

			for (const line of readFileSync(path, "utf8").split("\n")) {
				for (const surface of surfacesOfLine(line)) {
					const tokens = normalizeTokens(surface)

					if (tokens.length === 0) continue
					surfaces.add(tokens.join(" "))

					// Compositional clause sources from stopwords ONLY — single-token entries, so
					// multi-word stopword phrases ("à côté de") never leak their content words in.
					if (isStopwords && tokens.length === 1) {
						stopwordTokens.add(tokens[0]!)
					}
				}
			}
		}
	}

	for (const s of SUPPLEMENTAL_DEGENERATE_SURFACES) {
		const tokens = normalizeTokens(s)

		if (tokens.length === 0) continue
		surfaces.add(tokens.join(" "))

		if (tokens.length === 1) {
			stopwordTokens.add(tokens[0]!)
		}
	}

	return { surfaces, stopwordTokens }
}

/**
 * Surface-ambiguity scan (survey #4): one pass over the WHOLE admin DB (every country, the builder's default
 * placetypes) producing normalized-surface → distinct-country count. Shared across all four locale builds — the count
 * is deliberately global so a US-scoped FST still knows "pierre" is also a place-surface elsewhere (and, one day, that
 * "paris" is). Primary spr names + all alt names.
 */
export function computeSurfaceCountryCounts(dbPath: string): Map<string, number> {
	const db = new DatabaseSync(dbPath, { open: true })
	const placetypes = ["country", "region", "county", "locality", "localadmin", "borough", "neighbourhood"]
	const ph = placetypes.map(() => "?").join(",")
	// Memory shape matters: the names table runs to millions of rows (GeoNames alias folds included)
	// and a Set per surface OOMs a default heap. Most surfaces are single-country, so store the FIRST
	// country as a bare string and promote to an overflow Set only on the second distinct country;
	// rows stream via iterate() — never materialize the rowset.
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
	db.close()

	const counts = new Map<string, number>()

	for (const key of first.keys()) {
		counts.set(key, overflow.get(key)?.size ?? 1)
	}

	return counts
}

export interface BuildLocaleFSTsOpts {
	/** Locales to build (default: every FST_LOCALES key). */
	locales?: string[]
	/** WOF admin DB (default: `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`). */
	dbPath?: string
	/** Output dir (default: `$MAILWOMAN_DATA_ROOT/wof/fst-per-locale-curated`). Never the shipped dir. */
	outputDir?: string
	/** Skip the curation (an A/B control build with the SAME current DB). */
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

export function buildLocaleFSTs(opts: BuildLocaleFSTsOpts = {}): BuiltLocaleFST[] {
	const locales = opts.locales ?? [...FST_LOCALES.keys()]
	const dbPath = opts.dbPath ?? String(dataRootPath("wof", "admin-global-priority.db"))
	const outputDir = resolve(opts.outputDir ?? String(dataRootPath("wof", "fst-per-locale-curated")))
	const progress = opts.onProgress ?? (() => {})

	const exclusion = opts.uncurated ? undefined : loadDegenerateSurfaces()

	if (exclusion) {
		progress(
			`curation: ${exclusion.surfaces.size} whole surfaces + ${exclusion.stopwordTokens.size} stopword tokens (${EXCLUSION_POLICY_ID})`
		)
	}
	// Ambiguity classes (survey #4) ride the curated builds only — the uncurated control stays a pure
	// pre-curation byte baseline. One global scan shared by every locale.
	const surfaceCountryCounts = opts.uncurated ? undefined : computeSurfaceCountryCounts(dbPath)

	if (surfaceCountryCounts) {
		progress(`ambiguity: ${surfaceCountryCounts.size} surfaces scanned across all countries`)
	}
	mkdirSync(outputDir, { recursive: true })

	const built: BuiltLocaleFST[] = []

	for (const locale of locales) {
		const countries = FST_LOCALES.get(locale)

		if (!countries) throw new Error(`unknown FST locale ${locale} — add it to FST_LOCALES with its country scope`)

		progress(`building fst-${locale} (countries=[${countries}]) from ${dbPath}`)
		const { matcher, provenance } = buildFSTFromWOF({
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
		const outPath = join(outputDir, `fst-${locale}${opts.uncurated ? ".uncurated" : ""}.bin`)
		const bytes = serializeFST(matcher, provenance)
		writeFileSync(outPath, bytes)
		built.push({
			locale,
			path: outPath,
			bytes: bytes.length,
			nameInsertions: provenance.nameInsertions,
			excludedInsertions: provenance.excludedInsertions ?? 0,
		})
		progress(
			`  wrote ${outPath} (${(bytes.length / 1e6).toFixed(1)} MB, ${provenance.nameInsertions} insertions, ${provenance.excludedInsertions ?? 0} excluded)`
		)
	}

	return built
}
