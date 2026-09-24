/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build street-type and locality-surface evidence lexicons for training and inference.
 *   Both use the anchor-lexicon schema and shared painter normalization.
 *   Curation excludes degenerate, low-prominence, person-name, region, and redundant alias surfaces.
 *   Street-type data is committed; locality-surface data is stored under the data root.
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
 * Letters at or below which a token reads as an abbreviation rather than a word.
 */
const MAX_ABBREVIATION_LETTERS = 3

/**
 * Law 2: 1-token locality surfaces need population-backed importance ≥ this (≈11k population).
 */
export const ONE_TOKEN_IMPORTANCE_FLOOR = 0.25
/**
 * Law 3: 1-token person-name surfaces need importance ≥ this (the metropolis tier).
 */
export const PERSON_NAME_IMPORTANCE_FLOOR = 0.45

const LOCALITY_BIT = { locality: 1, locality_homograph: 2 }

/**
 * Normalize surface tokens as both anchor painters do: trim boundary punctuation,
 * lowercase, and preserve internal punctuation.
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
 * Additional degenerate surfaces excluded from evidence lexicons.
 */
export const EVIDENCE_SUPPLEMENTAL_DEGENERATE_SURFACES: readonly string[] = ["school", "state"]

/**
 * Load direction words without changing the FST curation policy.
 */
export async function loadDirectionalSurfaces(fold: (surface: string) => string[] = painterFold): Promise<Set<string>> {
	// Cache per fold function; the FST and painter folds differ.
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
 * Return painter-folded US state names and abbreviations.
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
 * German city-states where state and locality names are coextensive.
 */
const DE_CITY_STATES: ReadonlySet<GermanStateCode> = new Set(["BE", "HB", "HH"])

/**
 * Return German state names and aliases, excluding coextensive city-states.
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
 * Check whether `alt` is a strict contiguous token subphrase of `primary`.
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
 * Load the 1-token person-name surface set (libpostal given_names + surnames + personal_titles).
 */
export async function loadPersonNameSurfaces(): Promise<Set<string>> {
	personNameSurfacesMemo ??= await scanPersonNameSurfaces()

	return personNameSurfacesMemo
}

/**
 * Memo for {@link loadPersonNameSurfaces}.
 *
 * The curation inputs are static files, so this is process-lifetime.
 * No invalidation key, unlike {@link computeSurfaceCountryCounts}, whose input is a rebuildable artifact.
 *
 * The FR and US locality-surface passes were each re-reading and re-folding the
 * whole given-names + surnames + personal-titles set.
 *
 * The returned set is shared.
 * Every caller only probes it (`clearsProminenceFloor` takes it as `ReadonlySet`);
 * a future caller that mutates must copy first.
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
 * Law 2 + 3 combined: is a 1-token surface prominent enough to be evidence?
 *
 * Pure — the unit the selectivity tests exercise.
 *
 * `ownImportance` = the surface's max importance across places named it; `parentImportance` = the
 * max parent-locality importance across neighbourhoods named it (the v4 parent-prominence proxy).
 * LAW-3 guard: person-name surfaces may only clear via own importance.
 *
 * A neighbourhood named after a person inside a metropolis is exactly the "Rue Joseph"
 * street-interior hazard, and parent prominence must never launder it (the v3.17→v3.18 tuition).
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

export interface BuildLocalitySurfaceLexiconOpts {
	/**
	 * Countries whose locality names become evidence.
	 *
	 * Default US+FR (the probe-validated pair).
	 */
	countries?: string[]
	/**
	 * Child placetypes.
	 *
	 * Default includes `neighbourhood` (the v4 register change); pass
	 * `["locality", "localadmin"]` for a v3-parity build.
	 */
	placetypes?: string[]
	/**
	 * WOF admin DB (default `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db`).
	 */
	dbPath?: PathBuilderLike
	/**
	 * Output path (default `$MAILWOMAN_DATA_ROOT/gazetteer/locality-surface-lexicon-v6.json`).
	 */
	output?: PathBuilderLike
	onProgress?: (line: string) => void
}

export interface BuiltLexicon {
	path: string
	entries: number
	homographs: number
	skippedDegenerate: number
	/**
	 * Law 4 (v5): surfaces refused as region vocabulary.
	 */
	skippedRegionVocabulary: number
	/**
	 * Alt-name sub-phrase hygiene (v5): names-table aliases refused as sub-phrases of their primary.
	 */
	skippedSubPhrase: number
	skippedProminence: number
	maxNgram: number
}

export async function buildLocalitySurfaceLexicon(opts: BuildLocalitySurfaceLexiconOpts = {}): Promise<BuiltLexicon> {
	const countries = opts.countries ?? ["US", "FR"]
	const placetypes = opts.placetypes ?? ["locality", "localadmin", "neighbourhood"]
	const dbPath = opts.dbPath ?? wofDatabasePath("admin-global-priority.db")
	const output = resolvePath(opts.output ?? dataRootPath("gazetteer", "locality-surface-lexicon-v6.json"))
	const progress = opts.onProgress ?? (() => {})

	progress("loading curation + ambiguity + person-name inputs…")
	// Painter-fold the curation sets so they compare against painter-folded entry keys.
	const { surfaces: degenerate, stopwordTokens } = await loadDegenerateSurfaces(undefined, painterFold)

	// Law-1 directional closure (v5): union the directionals in without touching the shared FST policy set.
	for (const s of await loadDirectionalSurfaces()) {
		degenerate.add(s)
	}

	for (const s of EVIDENCE_SUPPLEMENTAL_DEGENERATE_SURFACES) {
		degenerate.add(painterFold(s).join(" "))
	}

	// Law 4 (v5. DE joined at v7): region vocabulary, scoped to the countries this build covers.
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
			// The FST builder's population→importance formula — one scale across every artifact.
			importanceByID.set(row.id, Math.min(1, Math.log2(1 + row.population / 1000) / 14))
		}
	}

	// Neighbourhood prominence rides the parent locality (v4): neighbourhoods structurally
	// lack population rows, and refusing them on absent data is the meaning-of-zero trap.
	// Montmartre is prominent because Paris is.
	// Resolved via the ancestors table.
	// A neighbourhood surface's floor input is max(own importance, parent locality/localadmin importance).
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
		// The homograph scan is FST-fold-keyed (it feeds the FST builder too) — fold separately for the join.
		const fstKey = normalizeTokens(surface).join(" ")

		// Law 1 (+ the letters-required clause: WOF carries numeric alias surfaces like "12").
		if (degenerate.has(key) || tokens.every((t) => stopwordTokens.has(t)) || !/\p{L}/u.test(key)) {
			skippedDegenerate++

			return
		}

		// Law 4: region vocabulary is never locality evidence.
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
		// Sub-phrase hygiene: "East" as an alias of "East Nashville" is ambiguity without discrimination.
		if (isSubPhraseAlias(painterFold(row.name), painterFold(row.primary_name))) {
			skippedSubPhrase++

			continue
		}

		add(row.name, row.id)
	}

	// Laws 2 + 3, applied post-scan (a surface's floor input is its MAX importance across carriers.
	// Own vs parent tracked separately so law 3 can refuse parent-laundered person-names).
	for (const [key, imp] of oneTokenMaxImportance) {
		if (!clearsProminenceFloor(key, imp.own, personNames, imp.parent)) {
			entries.delete(key)

			skippedProminence++
		}
	}

	const homographs = [...entries.values()].filter((b) => b & LOCALITY_BIT.locality_homograph).length

	const lexicon = {
		// v7: the DE country fold (law-4 DE region vocabulary with the city-state exception).
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

// MARK: Street-type lexicon (the bundle's first channel)

export interface BuildStreetTypeLexiconOpts {
	/**
	 * Output path (default `<repo>/data/gazetteer/street-type-lexicon-v3.json` — small, committed).
	 */
	output?: PathBuilderLike
}

/**
 * Street-type surfaces from the codex per-locale tables (fr/us/gb/de/ca).
 *
 * Canonical words (rue/avenue/street/straße) are case-insensitive regardless of length —
 * "rue" is 3 letters and must match lowercase.
 * Short abbreviation variants (r, av, ST) are case-sensitive uppercase `code_entries`
 * so they never fire on lowercase prose (the anchor-lexicon short-code discipline).
 *
 * V2 (the v3.19.0 flip-census fix, family F1): `code_entries` that are also US state/territory
 * abbreviations (CT/KY/ MT/PR/WY — Court/Key/Mount/Prairie/Way) are dropped.
 * In US mail the state reading dominates ("mountain WAY WY 82601", "susie CT WY 83101" —
 * both lost their region to street-code evidence on the state token); a suffix abbreviated
 * as one of these is rare enough that withholding evidence costs ~nothing.
 *
 * Directional codes (N/S/E/W/NE/ NW/SE/SW) stay even where one collides with a state (NE) —
 * directional evidence is common and showed zero census flips.
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

	// V2 / family F1: state-abbreviation homograph codes never paint (see the docstring).
	// Directionals exempt.
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
