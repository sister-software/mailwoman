/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the street-type and locality-surface evidence lexicons.
 */

import { wordNorm } from "@mailwoman/codex"
import { DE_BUNDESLAENDER, DE_STATE_NAME_TO_CODE, type GermanStateCode } from "@mailwoman/codex/de"
import { US_STATE_ABBREVIATIONS, US_STATE_NAMES } from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { resourceDictionaryPathBuilder, repoRootPathBuilder } from "@mailwoman/core/paths"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { dirname, type PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

import { computeSurfaceCountryCounts, CURATION_LANGUAGES, loadDegenerateSurfaces } from "#gazetteer-pipeline/fst"

/**
 * The maximum letter count of a surface treated as an abbreviation.
 */
const MAX_ABBREVIATION_LETTERS = 3

/**
 * The minimum importance for a one-token locality surface, about 10,000 population.
 */
export const ONE_TOKEN_IMPORTANCE_FLOOR = 0.25
/**
 * The minimum importance for a one-token surface that is also a person name, about 78,000 population.
 */
export const PERSON_NAME_IMPORTANCE_FLOOR = 0.45

const LOCALITY_BIT = { locality: 1, locality_homograph: 2 }

/**
 * Splits a surface into lowercase tokens the way both anchor painters do.
 *
 * It strips leading and trailing punctuation from each word and keeps internal punctuation.
 * This differs from the FST fold.
 */
export function painterFold(surface: string): string[] {
	return surface
		.split(/\s+/)
		.map((w) => w.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter((word) => word.length)
		.map((w) => w.toLowerCase())
}

/**
 * Degenerate surfaces excluded from evidence lexicons in addition to the shared FST list.
 */
export const EVIDENCE_SUPPLEMENTAL_DEGENERATE_SURFACES: readonly string[] = ["school", "state"]

/**
 * Loads libpostal directional words, folded with `fold`.
 *
 * The evidence lexicons exclude these words.
 * The shared FST curation list does not.
 */
export async function loadDirectionalSurfaces(fold: (surface: string) => string[] = painterFold): Promise<Set<string>> {
	// The cache is keyed by fold function because different folds give different surfaces.
	let hit = directionalSurfacesMemo.get(fold)

	if (!hit) {
		hit = await scanDirectionalSurfaces(fold)
		directionalSurfacesMemo.set(fold, hit)
	}

	return hit
}

const directionalSurfacesMemo = new Map<(surface: string) => string[], Set<string>>()

async function scanDirectionalSurfaces(fold: (surface: string) => string[]): Promise<Set<string>> {
	const dictionariesDir = resourceDictionaryPathBuilder("libpostal")
	const surfaces = new Set<string>()

	for (const lang of CURATION_LANGUAGES) {
		const path = dictionariesDir(lang, "directionals.txt")

		if (!(await pathExists(path))) continue

		for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
			for (const surface of line.split("|")) {
				const tokens = fold(surface)

				if (tokens.length) {
					surfaces.add(tokens.join(" "))
				}
			}
		}
	}

	return surfaces
}

/**
 * Returns the folded US state names and abbreviations.
 */
export function loadUSRegionVocabulary(fold: (surface: string) => string[] = painterFold): Set<string> {
	const surfaces = new Set<string>()

	for (const s of [...US_STATE_ABBREVIATIONS, ...US_STATE_NAMES]) {
		const tokens = fold(s)

		if (tokens.length) {
			surfaces.add(tokens.join(" "))
		}
	}

	return surfaces
}

/**
 * German city-states, whose state names are also locality names.
 */
const DE_CITY_STATES: ReadonlySet<GermanStateCode> = new Set(["BE", "HB", "HH"])

/**
 * Returns the folded German state names and aliases, excluding the city-states.
 */
export function loadDERegionVocabulary(fold: (surface: string) => string[] = painterFold): Set<string> {
	const surfaces = new Set<string>()

	const add = (s: string) => {
		const tokens = fold(s)

		if (tokens.length) {
			surfaces.add(tokens.join(" "))
		}
	}

	for (const [alias, code] of DE_STATE_NAME_TO_CODE) {
		if (DE_CITY_STATES.has(code)) continue

		add(alias)
	}

	for (const info of Object.values(DE_BUNDESLAENDER)) {
		if (DE_CITY_STATES.has(info.code as GermanStateCode)) continue

		add(info.name)
		add(info.english)
	}

	return surfaces
}

/**
 * Returns whether `alt` is a shorter contiguous token run inside `primary`.
 */
export function isSubPhraseAlias(alt: readonly string[], primary: readonly string[]): boolean {
	if (!alt.length || alt.length >= primary.length) return false

	outer: for (let start = 0; start + alt.length <= primary.length; start++) {
		for (let i = 0; i < alt.length; i++) {
			if (primary[start + i] !== alt[i]) continue outer
		}

		return true
	}

	return false
}

/**
 * Loads the one-token person-name surfaces from libpostal's given names, surnames, and personal titles.
 *
 * The result is cached for the life of the process and shared between callers.
 * Callers must copy the set before changing it.
 */
export async function loadPersonNameSurfaces(): Promise<Set<string>> {
	personNameSurfacesMemo ??= await scanPersonNameSurfaces()

	return personNameSurfacesMemo
}

/**
 * The cache for {@link loadPersonNameSurfaces}.
 *
 * It never needs invalidating because the inputs are static files.
 */
let personNameSurfacesMemo: Set<string> | undefined

async function scanPersonNameSurfaces(): Promise<Set<string>> {
	const dictionariesDir = resourceDictionaryPathBuilder("libpostal")

	const files: PathBuilder[] = [dictionariesDir("all", "given_names.txt"), dictionariesDir("all", "surnames.txt")]

	for (const lang of CURATION_LANGUAGES) {
		files.push(dictionariesDir(lang, "personal_titles.txt"))
	}

	const names = new Set<string>()

	for (const f of files) {
		if (!(await pathExists(f))) continue

		for (const line of TextSpliterator.from(await readLocalTextFile(f))) {
			for (const surface of line.split("|")) {
				const tokens = painterFold(surface)

				if (tokens.length === 1) {
					names.add(tokens[0]!)
				}
			}
		}
	}

	return names
}

/**
 * Returns whether a one-token surface is prominent enough to be locality evidence.
 *
 * `ownImportance` is the highest importance among places with this name.
 * `parentImportance` is the highest importance among the parent localities of neighbourhoods with this name.
 *
 * A person-name surface must clear the higher floor on its own importance,
 * because a neighbourhood named after a person in a large city would otherwise pass on
 * its parent's importance and match street names such as "Rue Joseph".
 */
export function clearsProminenceFloor(
	surface: string,
	ownImportance: number,
	personNames: ReadonlySet<string>,
	parentImportance = 0
): boolean {
	if (personNames.has(surface)) return ownImportance >= PERSON_NAME_IMPORTANCE_FLOOR

	return Math.max(ownImportance, parentImportance) >= ONE_TOKEN_IMPORTANCE_FLOOR
}

/**
 * Options for {@link buildLocalitySurfaceLexicon}.
 */
export interface BuildLocalitySurfaceLexiconOpts {
	/**
	 * The countries whose locality names become evidence.
	 * Defaults to US and FR.
	 */
	countries?: string[]
	/**
	 * The placetypes to read.
	 * Defaults to `locality`, `localadmin`, and `neighbourhood`.
	 */
	placetypes?: string[]
	/**
	 * The WOF admin database.
	 * Defaults to `admin-global-priority.db` under the data root.
	 */
	dbPath?: PathBuilderLike
	/**
	 * The output path.
	 *
	 * Defaults to `gazetteer/locality-surface-lexicon-v6.json` under the data root.
	 */
	output?: PathBuilderLike
	onProgress?: (line: string) => void
}

/**
 * The path and counts from a lexicon build.
 */
export interface BuiltLexicon {
	path: string
	entries: number
	homographs: number
	skippedDegenerate: number
	/**
	 * Surfaces excluded as region vocabulary.
	 * The street-type build reports withheld state codes here.
	 */
	skippedRegionVocabulary: number
	/**
	 * Alternate names excluded because they are sub-phrases of the place's primary name.
	 */
	skippedSubPhrase: number
	skippedProminence: number
	maxNgram: number
}

/**
 * Builds the locality-surface lexicon from the WOF admin database.
 *
 * The build excludes degenerate and directional surfaces, region vocabulary, alternate names
 * that are sub-phrases of the primary name, and one-token surfaces below the prominence floors.
 */
export async function buildLocalitySurfaceLexicon(opts: BuildLocalitySurfaceLexiconOpts = {}): Promise<BuiltLexicon> {
	const countries = opts.countries ?? ["US", "FR"]
	const placetypes = opts.placetypes ?? ["locality", "localadmin", "neighbourhood"]
	const dbPath = opts.dbPath ?? wofDatabasePath("admin-global-priority.db")
	const output = resolvePath(opts.output ?? dataRootPath("gazetteer", "locality-surface-lexicon-v6.json"))
	const progress = opts.onProgress ?? (() => {})

	progress("loading curation + ambiguity + person-name inputs…")
	// The curation sets use the painter fold so they compare with the entry keys.
	const { surfaces: degenerate, stopwordTokens } = await loadDegenerateSurfaces(undefined, painterFold)

	for (const s of await loadDirectionalSurfaces()) {
		degenerate.add(s)
	}

	for (const s of EVIDENCE_SUPPLEMENTAL_DEGENERATE_SURFACES) {
		degenerate.add(painterFold(s).join(" "))
	}

	// Region vocabulary is loaded only for the countries in this build.
	const regionVocabulary = new Set<string>()

	if (countries.includes("US")) {
		for (const s of loadUSRegionVocabulary()) {
			regionVocabulary.add(s)
		}
	}

	if (countries.includes("DE")) {
		for (const s of loadDERegionVocabulary()) {
			regionVocabulary.add(s)
		}
	}

	const countryCounts = await computeSurfaceCountryCounts(dbPath.toString())
	const personNames = await loadPersonNameSurfaces()

	using db = new DatabaseClient<WOFDatabase>(dbPath, { open: true })
	const importanceByID = new Map<number, number>()
	const popStmt = db.prepare("SELECT id, population FROM place_population")

	for (const row of popStmt.iterate() as Iterable<{ id: number; population: number }>) {
		if (row.population > 0) {
			// This is the FST builder's population-to-importance formula, so both artifacts share a scale.
			importanceByID.set(row.id, Math.min(1, Math.log2(1 + row.population / 1000) / 14))
		}
	}

	// Neighbourhoods have no population rows, so each one takes the importance of its
	// parent locality or localadmin from the ancestors table.
	const parentImportanceByID = new Map<number, number>()

	if (placetypes.includes("neighbourhood")) {
		const anc = db.prepare(
			`SELECT a.id AS id, a.ancestor_id AS ancestor_id FROM ancestors a
			 JOIN spr s ON s.id = a.id
			 WHERE s.is_current = 1 AND s.placetype = 'neighbourhood'
			   AND s.country IN (${countries.map(() => "?").join(",")})
			   AND a.ancestor_placetype IN ('locality', 'localadmin')`
		)

		for (const row of anc.iterate(...countries) as Iterable<{ id: number; ancestor_id: number }>) {
			const parentImp = importanceByID.get(row.ancestor_id)

			if (parentImp !== undefined) {
				parentImportanceByID.set(row.id, Math.max(parentImportanceByID.get(row.id) ?? 0, parentImp))
			}
		}
	}

	const entries = new Map<string, number>()
	const oneTokenMaxImportance = new Map<string, { own: number; parent: number }>()
	let maxNgram = 1
	let skippedDegenerate = 0
	let skippedRegionVocabulary = 0
	let skippedProminence = 0

	const add = (surface: string, placeID: number): void => {
		const tokens = painterFold(surface)

		if (!tokens.length) return
		const key = tokens.join(" ")
		// The homograph counts are keyed by the FST fold, so the lookup needs a second key.
		const fstKey = normalizeTokens(surface).join(" ")

		// WOF has numeric aliases such as "12", so a key must contain a letter.
		if (degenerate.has(key) || tokens.every((t) => stopwordTokens.has(t)) || !/\p{L}/u.test(key)) {
			skippedDegenerate++

			return
		}

		if (regionVocabulary.has(key)) {
			skippedRegionVocabulary++

			return
		}

		if (tokens.length === 1) {
			const own = importanceByID.get(placeID) ?? 0
			const parent = parentImportanceByID.get(placeID) ?? 0
			const prev = oneTokenMaxImportance.get(key) ?? { own: 0, parent: 0 }
			oneTokenMaxImportance.set(key, { own: Math.max(prev.own, own), parent: Math.max(prev.parent, parent) })
		}

		maxNgram = Math.max(maxNgram, tokens.length)
		const homograph = (countryCounts.get(fstKey) ?? 1) >= 2
		entries.set(key, LOCALITY_BIT.locality | (homograph ? LOCALITY_BIT.locality_homograph : 0))
	}

	const ph = (arr: readonly string[]) => arr.map(() => "?").join(",")

	const primary = db.prepare(
		`SELECT id, name FROM spr WHERE is_current = 1 AND country IN (${ph(countries)}) AND placetype IN (${ph(placetypes)})`
	)

	for (const row of primary.iterate(...countries, ...placetypes) as Iterable<{ id: number; name: string }>) {
		add(row.name, row.id)
	}

	const alts = db.prepare(
		`SELECT n.id AS id, n.name AS name, s.name AS primary_name FROM names n JOIN spr s ON s.id = n.id
		 WHERE s.is_current = 1 AND s.country IN (${ph(countries)}) AND s.placetype IN (${ph(placetypes)})`
	)

	let skippedSubPhrase = 0

	for (const row of alts.iterate(...countries, ...placetypes) as Iterable<{
		id: number
		name: string
		primary_name: string
	}>) {
		// An alias such as "East" for "East Nashville" adds ambiguity without identifying the place.
		if (isSubPhraseAlias(painterFold(row.name), painterFold(row.primary_name))) {
			skippedSubPhrase++

			continue
		}

		add(row.name, row.id)
	}

	// The prominence floors run after the scan because they use each surface's
	// highest importance across all places with that name.
	for (const [key, imp] of oneTokenMaxImportance) {
		if (!clearsProminenceFloor(key, imp.own, personNames, imp.parent)) {
			entries.delete(key)

			skippedProminence++
		}
	}

	const homographs = [...entries.values()].filter((b) => b & LOCALITY_BIT.locality_homograph).length

	const lexicon = {
		version: 7,
		generated_by:
			`mailwoman gazetteer build locality-surface-lexicon (four-law selectivity: degenerate+directional exclusion + ` +
			`prominence ${ONE_TOKEN_IMPORTANCE_FLOOR} + person-name ${PERSON_NAME_IMPORTANCE_FLOOR} + ` +
			`region-vocabulary + alt-subphrase hygiene; countries=[${countries}] placetypes=[${placetypes}])`,
		feature_dim: 2,
		slots: ["locality", "locality_homograph"],
		bits: LOCALITY_BIT,
		max_ngram: maxNgram,
		rules: {
			word_norm:
				"per whitespace-word: strip leading/trailing chars that are not Unicode letters/digits (keep internal), " +
				"lowercase; rejoin single-spaced — the painter fold shared by gazetteer_anchor.py and gazetteer-inference.ts.",
			entries: "case-insensitive; key = normalizeTokens(surface).join(' ')",
			code_entries: "unused for this channel (no case-sensitive short codes)",
			scan: "longest-first n-gram over whitespace words, left to right, non-overlapping",
			digit_guard: true,
			digit_guard_semantics:
				"a matched span paints NOTHING when any span word or the nearest non-empty neighbor word carries a " +
				"Unicode-Nd digit; the guarded match still consumes its span (no sub-ngram re-matching). v3.23: evidence " +
				"beside a house number swallowed the digit into the span (P0 alnum-hn \u22120.325 lower+heal).",
		},
		entries: Object.fromEntries(entries),
		code_entries: {},
	}

	await makeDirectories(dirname(output))
	await writeLocalJSONLFile([lexicon], output)

	return {
		path: output.toString(),
		entries: entries.size,
		homographs,
		skippedDegenerate,
		skippedRegionVocabulary,
		skippedSubPhrase,
		skippedProminence,
		maxNgram,
	}
}

// MARK: Street-type lexicon

/**
 * Options for {@link buildStreetTypeLexicon}.
 */
export interface BuildStreetTypeLexiconOpts {
	/**
	 * The output path.
	 *
	 * Defaults to the committed `data/gazetteer/street-type-lexicon-v3.json`.
	 */
	output?: PathBuilderLike
}

/**
 * Builds the street-type lexicon from the codex tables for FR, US, GB, DE, and CA.
 *
 * Canonical words such as "rue" match case-insensitively at any length.
 * Abbreviations of up to {@link MAX_ABBREVIATION_LETTERS} letters become case-sensitive
 * uppercase `code_entries`, so they do not match lowercase prose.
 *
 * Codes that are also US state abbreviations, such as CT and WY, are dropped
 * because in US addresses the state reading dominates.
 * Directional codes stay even when one matches a state code, such as NE.
 */
export async function buildStreetTypeLexicon(opts: BuildStreetTypeLexiconOpts = {}): Promise<BuiltLexicon> {
	const [{ CA_DIRECTIONALS, CA_STREET_TYPES_EN, CA_STREET_TYPES_FR }, de, fr, gb, us] = await Promise.all([
		import("@mailwoman/codex/ca"),
		import("@mailwoman/codex/de"),
		import("@mailwoman/codex/fr"),
		import("@mailwoman/codex/gb"),
		import("@mailwoman/codex/us"),
	])

	const output = opts.output ?? repoRootPathBuilder("data", "gazetteer", "street-type-lexicon-v3.json")

	const isShortCode = (s: string): boolean => {
		const letters = s.replaceAll(/[^\p{L}]/gu, "")

		return letters.length > 0 && letters.length <= MAX_ABBREVIATION_LETTERS && /^[\p{L}.\s]+$/u.test(s)
	}

	const entries = new Map<string, number>()
	const codeEntries = new Map<string, number>()
	let maxNgram = 1

	const addCanonical = (surface: string): void => {
		const key = wordNorm(surface).toLowerCase()

		if (!key || key.replaceAll(/[^\p{L}\p{N}]/gu, "").length < 2) return
		maxNgram = Math.max(maxNgram, key.split(" ").length)
		entries.set(key, 1)
	}

	const addAbbrev = (surface: string): void => {
		const s = surface.trim()

		if (!s) return

		if (isShortCode(s)) {
			const key = wordNorm(s).toUpperCase()

			if (key) {
				codeEntries.set(key, 1)
			}

			return
		}

		addCanonical(s)
	}

	for (const [canonical, abbrevs] of Object.entries(fr.FR_VOIE_TYPES)) {
		addCanonical(canonical)

		for (const a of abbrevs) {
			addAbbrev(a)
		}
	}

	for (const [canonical, variants] of Object.entries(us.US_STREET_SUFFIX_VARIANTS)) {
		addCanonical(canonical)

		for (const v of variants) {
			addAbbrev(v)
		}
	}

	for (const t of gb.GB_STREET_TYPES) {
		addCanonical(t)
	}

	for (const [canonical, variants] of Object.entries(de.DE_STREET_TYPE_VARIANTS)) {
		addCanonical(canonical)

		for (const v of variants) {
			addAbbrev(v)
		}
	}

	for (const suffix of de.DE_STREET_SUFFIXES) {
		addCanonical(suffix)
	}

	for (const t of CA_STREET_TYPES_EN) {
		addCanonical(t)
	}

	for (const t of CA_STREET_TYPES_FR) {
		addCanonical(t)
	}

	for (const d of Object.keys(CA_DIRECTIONALS)) {
		addAbbrev(d)
	}

	// Drop codes that are also US state abbreviations, except directionals.
	const DIRECTIONAL_CODES = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"])
	let droppedStateCodes = 0

	for (const code of US_STATE_ABBREVIATIONS) {
		if (!DIRECTIONAL_CODES.has(code) && codeEntries.delete(code)) {
			droppedStateCodes++
		}
	}

	const lexicon = {
		version: 3,
		generated_by:
			`mailwoman gazetteer build street-type-lexicon (source: @mailwoman/codex fr/us/gb/de/ca; ` +
			`v2: ${droppedStateCodes} US-state-homograph codes withheld)`,
		feature_dim: 1,
		slots: ["street_type"],
		bits: { street_type: 1 },
		max_ngram: maxNgram,
		rules: {
			word_norm:
				"per whitespace-word: strip leading/trailing chars that are not Unicode letters/digits " +
				"(keep internal); rejoin single-spaced. Applied to BOTH entry keys and scanned tokens.",
			entries: "case-insensitive; key = word_norm lowercased",
			code_entries:
				"case-SENSITIVE exact: word_norm(token) == key (keys uppercase; the surface must already BE " +
				"uppercase). n-gram length 1 only.",
			scan: "longest-first n-gram over whitespace words, left to right, non-overlapping",
			digit_guard: true,
			digit_guard_semantics:
				"a matched span paints NOTHING when any span word or the nearest non-empty neighbor word carries a " +
				"Unicode-Nd digit; the guarded match still consumes its span (no sub-ngram re-matching). v3.23: evidence " +
				"beside a house number swallowed the digit into the span (P0 alnum-hn \u22120.325 lower+heal).",
		},
		entries: Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b))),
		code_entries: Object.fromEntries([...codeEntries].toSorted(([a], [b]) => a.localeCompare(b))),
	}

	await makeDirectories(dirname(output))
	await writeLocalJSONFile(lexicon, output)

	return {
		path: output.toString(),
		entries: entries.size + codeEntries.size,
		homographs: 0,
		skippedDegenerate: 0,
		skippedRegionVocabulary: droppedStateCodes,
		skippedSubPhrase: 0,
		skippedProminence: 0,
		maxNgram,
	}
}
