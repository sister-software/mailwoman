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

import { pathExists, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { pathExistsSync } from "@mailwoman/core/fs/readers-sync"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { dataRootPath, resourceDictionaryPath } from "@mailwoman/core/utils"
import { join, resolve } from "@mailwoman/platform/path"
import { buildFSTFromWOF } from "@mailwoman/resolver-wof-sqlite/fst-builder"
import { fstStaleReason, peekFSTStampFields, readWOFSourceIdentity } from "@mailwoman/resolver-wof-sqlite/fst-freshness"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { serializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { TextSpliterator } from "spliterator"

/**
 * The served Latin-script language tiers (see SCOPE.mdx) — uniform curation set for every locale FST.
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
 * Identifies which exclusion policy built an FST. Stamped into the artifact so a stale index built under an older
 * policy is detectable rather than silently mixed with a new one.
 */
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

/**
 * The shipped per-locale FST set (provenance-recovered country scoping; en-nz deliberately has none).
 *
 * An overlay ABSENT here ships with no FST, which makes `--gazetteer-prior` a silent no-op for it — the artifact
 * resolves to `undefined` and the run degrades to the base model with extra steps. That is why membership is worth
 * earning rather than assuming: `es-es` and `it-it` were added once a board row proved the cost. `en-au`, `en-in` and
 * `en-nz` remain out because those overlays are country-scope-only today, so there is no measured case for them yet.
 */
export const FST_LOCALES: ReadonlyMap<string, string[]> = new Map([
	["en-us", ["US"]],
	["fr-fr", ["FR"]],
	["en-gb", ["GB"]],
	["de-de", ["DE"]],
	["es-es", ["ES"]],
	["it-it", ["IT"]],
])

/**
 * Every FST artifact that is a projection of the WOF admin DB, relative to the wof data-root dir.
 *
 * `fst-street-morphology.bin` is deliberately ABSENT: it is built from the in-repo libpostal dictionaries, so the admin
 * DB's md5 says nothing about whether it is current and stamping it against one would be a lie the guard then enforces.
 * The CJK three ARE here despite having no entry in {@link FST_LOCALES} — they were built by the pre-#1318 flow,
 * nothing can rebuild them today, and they stay FROZEN pending the CJK arc's importance-source and WOF-geometry
 * questions; that is a fact the check should surface rather than hide. `fst-global-priority.bin` (317 MB, retired
 * 2026-08-06 — see RELEASING.md) is deliberately GONE from this list: a retired artifact must not keep generating
 * freshness rows that read as a rebuild obligation. The public HF object outlives the template on purpose; removing it
 * is a separate, operator-approved step (#1493).
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
	 * `undefined` = current. Otherwise the prose from `fstStaleReason`.
	 */
	staleReason?: string
	builtAt?: string
	rebuildCommand: string
}

/**
 * Check every admin-derived FST against `dbPath`, for the `gazetteer verify` freshness section.
 *
 * WHY IT REPORTS RATHER THAN FAILS. `gazetteer verify` gates a DATABASE, and a stale FST says nothing about whether
 * that database is sound — the arrow runs the other way. The artifacts also cannot be rebuilt as a side effect of a
 * verify: a locale FST build is minutes, its output is staged, and the swap is operator-gated because an FST changes
 * decoder behaviour. So the section exists to make the drift visible at the moment the operator is already looking at
 * the gazetteer, with the command that starts fixing it. The caller decides what to do with the exit code; today it
 * does nothing, and that is deliberate.
 *
 * The exclusion-policy expectation applies ONLY to locales the current builder can produce. Naming a policy for
 * `fst-ja-jp.bin` would report the true-but-useless "(none) → v1.1" on an artifact no command can rebuild, burying the
 * reason that matters.
 */
export async function checkAdminDerivedFSTFreshness(dbPath: string): Promise<FSTFreshnessRow[]> {
	const source = await readWOFSourceIdentity(dbPath)
	const wofRoot = String(dataRootPath("wof"))

	return ADMIN_DERIVED_FST_ARTIFACTS.map((relative): FSTFreshnessRow => {
		const path = join(wofRoot, relative)
		const locale = /fst-per-locale\/fst-(?<locale>[a-z]{2}-[a-z]{2})\.bin$/.exec(relative)?.groups?.locale
		const buildable = locale !== undefined && FST_LOCALES.has(locale)

		const rebuildCommand = buildable
			? `mailwoman gazetteer build fst --locales ${locale}`
			: `NO BUILDER — ${locale ?? "this artifact"} has no FST_LOCALES entry (built by the pre-#1318 flow)`

		if (!pathExistsSync(path)) return { artifact: relative, present: false, rebuildCommand }

		const fields = peekFSTStampFields(path)

		const staleReason = fstStaleReason(fields, {
			source,
			...(buildable ? { exclusionPolicy: EXCLUSION_POLICY_ID } : {}),
		})

		return {
			artifact: relative,
			present: true,
			...(staleReason === undefined ? {} : { staleReason }),
			...(fields?.provenance?.builtAt ? { builtAt: fields.provenance.builtAt } : {}),
			rebuildCommand,
		}
	})
}

/**
 * One dictionary line = canonical|variant|variant… — every pipe-separated form is a surface.
 */
function surfacesOfLine(line: string): string[] {
	return line
		.split("|")
		.map((s) => s.trim())
		.filter((surface) => surface.length > 0)
}

/**
 * Load the degenerate-surface exclusion sets from the shipped libpostal dictionaries. Returns normalized-join keys
 * (`normalizeTokens(surface).join(" ")`) so they compare exactly against the builder's insertion keys.
 */
export async function loadDegenerateSurfaces(
	languages: readonly string[] = CURATION_LANGUAGES,
	fold: (surface: string) => string[] = normalizeTokens
): Promise<{
	surfaces: Set<string>
	stopwordTokens: Set<string>
}> {
	// Memoized like loadPersonNameSurfaces: static dictionaries, so process-lifetime with no
	// invalidation key. Keyed by fold IDENTITY then language set — the FST and painter worlds fold
	// differently by design and must not share an entry. Without this the fixture-layer test paid
	// ~1s of dictionary parsing per build (10 builds, 11.2s); with it the file runs in ~1s.
	//
	// ⚠ The returned sets are SHARED and `buildLocalitySurfaceLexicon` MUTATES its copy (it unions
	// the directionals and the evidence supplemental set into `degenerate`). So this hands back a
	// fresh shallow copy per call and caches only the parse.
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
	const dictionariesDir = resourceDictionaryPath("libpostal")
	const surfaces = new Set<string>()
	const stopwordTokens = new Set<string>()

	for (const lang of languages) {
		for (const [file, isStopwords] of [
			["stopwords.txt", true],
			["street_types.txt", false],
		] as const) {
			const path = join(dictionariesDir, lang, file)

			if (!(await pathExists(path))) continue

			for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
				for (const surface of surfacesOfLine(line)) {
					const tokens = fold(surface)

					if (!tokens.length) continue
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
 * Surface-ambiguity scan (survey #4): one pass over the WHOLE admin DB (every country, the builder's default
 * placetypes) producing normalized-surface → distinct-country count. Shared across all four locale builds — the count
 * is deliberately global so a US-scoped FST still knows "pierre" is also a place-surface elsewhere (and, one day, that
 * "paris" is). Primary spr names + all alt names.
 */
export async function computeSurfaceCountryCounts(dbPath: string): Promise<Map<string, number>> {
	const { mtimeMs, size } = await statPath(dbPath)
	const memoKey = `${dbPath}\0${mtimeMs}\0${size}`
	const hit = surfaceCountryCountsMemo.get(memoKey)

	if (hit) return hit

	const counts = scanSurfaceCountryCounts(dbPath)
	surfaceCountryCountsMemo.set(memoKey, counts)

	return counts
}

/**
 * Memo for {@link computeSurfaceCountryCounts}, keyed on (path, mtimeMs, size).
 *
 * The scan streams the whole `spr` + `names` surface — millions of rows — and the locality-surface build calls it once
 * per country set. The FR and US passes in one process paid it twice; measured 2026-08-02 that pair was 236.9s of a
 * 253s CI leg.
 *
 * NOT keyed on path alone. The WOF admin DB is a sealed readonly artifact that a rebuild REPLACES, so a path-only memo
 * would serve a stale scan against a new file for the life of the process.
 *
 * The returned map is SHARED with every caller. Both consumers treat it as read-only — the FST builder's
 * `FSTBuildOpts.surfaceCountryCounts` is typed `ReadonlyMap`, and the locality-surface builder only probes it — so no
 * copy is made. A future caller that mutates must copy first.
 */
const surfaceCountryCountsMemo = new Map<string, Map<string, number>>()

function scanSurfaceCountryCounts(dbPath: string): Map<string, number> {
	using db = new DatabaseClient<WOFDatabase>(dbPath, { open: true })
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
	 * WOF admin DB (default: `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`).
	 */
	dbPath?: string
	/**
	 * Output dir (default: `$MAILWOMAN_DATA_ROOT/wof/fst-per-locale-curated`). Never the shipped dir.
	 */
	outputDir?: string
	/**
	 * Skip the curation (an A/B control build with the SAME current DB).
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
	const dbPath = opts.dbPath ?? String(dataRootPath("wof", "admin-global-priority.db"))
	const outputDir = resolve(opts.outputDir ?? String(dataRootPath("wof", "fst-per-locale-curated")))
	const progress = opts.onProgress ?? (() => {})

	const exclusion = opts.uncurated ? undefined : await loadDegenerateSurfaces()

	if (exclusion) {
		progress(
			`curation: ${exclusion.surfaces.size} whole surfaces + ${exclusion.stopwordTokens.size} stopword tokens (${EXCLUSION_POLICY_ID})`
		)
	}

	// Ambiguity classes (survey #4) ride the curated builds only — the uncurated control stays a pure
	// pre-curation byte baseline. One global scan shared by every locale.
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

		const outPath = join(outputDir, `fst-${locale}${opts.uncurated ? ".uncurated" : ""}.bin`)
		const bytes = serializeFST(matcher, provenance)
		await writeLocalFile(bytes, outPath)

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
