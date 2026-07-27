/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evidence-lexicon builders (`mailwoman gazetteer build street-type-lexicon` / `build
 *   locality-surface-lexicon`) — the Option-A bundle's training/inference input artifacts, promoted
 *   from the probe-era diagnostic scripts (Phase 1 of
 *   `docs/superpowers/plans/2026-07-27-option-a-productionization-plan.md`).
 *
 *   BOTH lexicons follow the anchor-lexicon JSON schema (feature_dim/slots/bits/entries/
 *   code_entries + rules) so the Python painter (`gazetteer_anchor.py`) and the future TS painter
 *   consume them identically — train and inference share one computation.
 *
 *   THE THREE-LAW SELECTIVITY (each law bought with a falsified training run, v3.16→v3.18):
 *
 *   1. Degenerate exclusion — bare function words, bare street-type words, and all-function-word
 *      compositions are never evidence (the shipped FST curation policy applied to training
 *      evidence; unselective evidence trained into pure damage — bare-locality −0.180).
 *   2. Prominence floor — 1-token locality surfaces need population-backed importance ≥ 0.25
 *      (≈11k population): hamlet-long-tail surfaces fire on ordinary street text and are noise.
 *   3. Person-name tier — 1-token surfaces in libpostal given_names/surnames/personal_titles need
 *      importance ≥ 0.45: French given names are prominent-place homographs ("Rue Joseph[paint]
 *      Gagnier" started a phantom locality mid-street), while paris/lyon/nancy — also in the name
 *      lists — clear the metropolis tier.
 *
 *   The locality lexicon's v4 register change (operator doctrine 2026-07-27): NEIGHBOURHOOD
 *   surfaces fold in as single-token evidence — a web user types "montmartre" as a fragment, never
 *   "Montmartre, Paris", so neighbourhood value ships inside the bundle channel rather than as a
 *   pair index (see the pair-hierarchy design doc's dispositions).
 *
 *   Artifacts: street-type → `data/gazetteer/` (small, committed); locality-surface →
 *   `$MAILWOMAN_DATA_ROOT/gazetteer/` (≥13 MB — ships as a weights-package sibling at the Phase-3
 *   promote, never in git).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath, repoRootPathBuilder } from "@mailwoman/core/utils"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"

import { computeSurfaceCountryCounts, CURATION_LANGUAGES, loadDegenerateSurfaces } from "./fst.ts"

/** Law 2: 1-token locality surfaces need population-backed importance ≥ this (≈11k population). */
export const ONE_TOKEN_IMPORTANCE_FLOOR = 0.25
/** Law 3: 1-token person-name surfaces need importance ≥ this (the metropolis tier). */
export const PERSON_NAME_IMPORTANCE_FLOOR = 0.45

const LOCALITY_BIT = { locality: 1, locality_homograph: 2 }

/** Load the 1-token person-name surface set (libpostal given_names + surnames + personal_titles). */
export function loadPersonNameSurfaces(): Set<string> {
	const dictionariesDir = String(repoRootPathBuilder("core", "data", "libpostal", "dictionaries"))
	const files = [join(dictionariesDir, "all", "given_names.txt"), join(dictionariesDir, "all", "surnames.txt")]

	for (const lang of CURATION_LANGUAGES) {
		files.push(join(dictionariesDir, lang, "personal_titles.txt"))
	}
	const names = new Set<string>()

	for (const f of files) {
		if (!existsSync(f)) continue

		for (const line of readFileSync(f, "utf8").split("\n")) {
			for (const surface of line.split("|")) {
				const tokens = normalizeTokens(surface)

				if (tokens.length === 1) names.add(tokens[0]!)
			}
		}
	}

	return names
}

/**
 * Law 2 + 3 combined: is a 1-token surface prominent enough to be evidence? Pure — the unit the selectivity tests
 * exercise.
 *
 * `ownImportance` = the surface's max importance across places NAMED it; `parentImportance` = the max PARENT-locality
 * importance across neighbourhoods named it (the v4 parent-prominence proxy). LAW-3 GUARD: person-name surfaces may
 * only clear via OWN importance — a neighbourhood named after a person inside a metropolis is exactly the "Rue Joseph"
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
	/** Countries whose locality names become evidence. Default US+FR (the probe-validated pair). */
	countries?: string[]
	/**
	 * Child placetypes. Default includes `neighbourhood` (the v4 register change); pass `["locality", "localadmin"]` for
	 * a v3-parity build.
	 */
	placetypes?: string[]
	/** WOF admin DB (default `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`). */
	dbPath?: string
	/** Output path (default `$MAILWOMAN_DATA_ROOT/gazetteer/locality-surface-lexicon-v4.json`). */
	output?: string
	onProgress?: (line: string) => void
}

export interface BuiltLexicon {
	path: string
	entries: number
	homographs: number
	skippedDegenerate: number
	skippedProminence: number
	maxNgram: number
}

export function buildLocalitySurfaceLexicon(opts: BuildLocalitySurfaceLexiconOpts = {}): BuiltLexicon {
	const countries = opts.countries ?? ["US", "FR"]
	const placetypes = opts.placetypes ?? ["locality", "localadmin", "neighbourhood"]
	const dbPath = opts.dbPath ?? String(dataRootPath("wof", "admin-global-priority.db"))
	const output = opts.output ?? join(String(dataRootPath("gazetteer")), "locality-surface-lexicon-v4.json")
	const progress = opts.onProgress ?? (() => {})

	progress("loading curation + ambiguity + person-name inputs…")
	const { surfaces: degenerate, stopwordTokens } = loadDegenerateSurfaces()
	const countryCounts = computeSurfaceCountryCounts(dbPath)
	const personNames = loadPersonNameSurfaces()

	const db = new DatabaseSync(dbPath, { open: true })
	const importanceByID = new Map<number, number>()
	const popStmt = db.prepare("SELECT id, population FROM place_population")

	for (const row of popStmt.iterate() as Iterable<{ id: number; population: number }>) {
		if (row.population > 0) {
			// The FST builder's population→importance formula — one scale across every artifact.
			importanceByID.set(row.id, Math.min(1.0, Math.log2(1 + row.population / 1000) / 14))
		}
	}

	// Neighbourhood prominence rides the PARENT locality (v4): neighbourhoods structurally lack
	// population rows, and refusing them on absent data is the meaning-of-zero trap — Montmartre is
	// prominent BECAUSE Paris is. Resolved via the ancestors table; a neighbourhood surface's floor
	// input is max(own importance, parent locality/localadmin importance).
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
	let skippedProminence = 0

	const add = (surface: string, placeID: number): void => {
		const tokens = normalizeTokens(surface)

		if (tokens.length === 0) return
		const key = tokens.join(" ")

		// Law 1 (+ the letters-required clause: WOF carries numeric alias surfaces like "12").
		if (degenerate.has(key) || tokens.every((t) => stopwordTokens.has(t)) || !/\p{L}/u.test(key)) {
			skippedDegenerate++

			return
		}

		if (tokens.length === 1) {
			const own = importanceByID.get(placeID) ?? 0
			const parent = parentImportanceByID.get(placeID) ?? 0
			const prev = oneTokenMaxImportance.get(key) ?? { own: 0, parent: 0 }
			oneTokenMaxImportance.set(key, { own: Math.max(prev.own, own), parent: Math.max(prev.parent, parent) })
		}
		maxNgram = Math.max(maxNgram, tokens.length)
		const homograph = (countryCounts.get(key) ?? 1) >= 2
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
		`SELECT n.id AS id, n.name AS name FROM names n JOIN spr s ON s.id = n.id
		 WHERE s.is_current = 1 AND s.country IN (${ph(countries)}) AND s.placetype IN (${ph(placetypes)})`
	)

	for (const row of alts.iterate(...countries, ...placetypes) as Iterable<{ id: number; name: string }>) {
		add(row.name, row.id)
	}
	db.close()

	// Laws 2 + 3, applied post-scan (a surface's floor input is its MAX importance across carriers;
	// own vs parent tracked separately so law 3 can refuse parent-laundered person-names).
	for (const [key, imp] of oneTokenMaxImportance) {
		if (!clearsProminenceFloor(key, imp.own, personNames, imp.parent)) {
			entries.delete(key)
			skippedProminence++
		}
	}

	const homographs = [...entries.values()].filter((b) => b & LOCALITY_BIT.locality_homograph).length
	const lexicon = {
		version: 4,
		generated_by:
			`mailwoman gazetteer build locality-surface-lexicon (three-law selectivity: degenerate exclusion + ` +
			`prominence ${ONE_TOKEN_IMPORTANCE_FLOOR} + person-name ${PERSON_NAME_IMPORTANCE_FLOOR}; ` +
			`countries=[${countries}] placetypes=[${placetypes}])`,
		feature_dim: 2,
		slots: ["locality", "locality_homograph"],
		bits: LOCALITY_BIT,
		max_ngram: maxNgram,
		rules: {
			word_norm: "resolver normalizeTokens: NFKC, lowercase, strip punctuation/symbols, split whitespace",
			entries: "case-insensitive; key = normalizeTokens(surface).join(' ')",
			code_entries: "unused for this channel (no case-sensitive short codes)",
			scan: "longest-first n-gram over whitespace words, left to right, non-overlapping",
		},
		entries: Object.fromEntries(entries),
		code_entries: {},
	}

	mkdirSync(dirname(output), { recursive: true })
	writeFileSync(output, JSON.stringify(lexicon) + "\n")

	return {
		path: output,
		entries: entries.size,
		homographs,
		skippedDegenerate,
		skippedProminence,
		maxNgram,
	}
}

// ---------------------------------------------------------------------------
// Street-type lexicon (the bundle's first channel)
// ---------------------------------------------------------------------------

export interface BuildStreetTypeLexiconOpts {
	/** Output path (default `<repo>/data/gazetteer/street-type-lexicon-v1.json` — small, committed). */
	output?: string
}

/**
 * Street-type surfaces from the codex per-locale tables (fr/us/gb/de/ca). Canonical words (rue/avenue/street/straße)
 * are case-insensitive regardless of length — "rue" is 3 letters and must match lowercase; short abbreviation variants
 * (r, av, ST) are case-SENSITIVE uppercase `code_entries` so they never fire on lowercase prose (the anchor-lexicon
 * short-code discipline).
 */
export async function buildStreetTypeLexicon(opts: BuildStreetTypeLexiconOpts = {}): Promise<BuiltLexicon> {
	const [{ CA_DIRECTIONALS, CA_STREET_TYPES_EN, CA_STREET_TYPES_FR }, de, fr, gb, us] = await Promise.all([
		import("@mailwoman/codex/ca"),
		import("@mailwoman/codex/de"),
		import("@mailwoman/codex/fr"),
		import("@mailwoman/codex/gb"),
		import("@mailwoman/codex/us"),
	])
	const output = opts.output ?? String(repoRootPathBuilder("data", "gazetteer", "street-type-lexicon-v1.json"))

	const wordNorm = (s: string): string =>
		s
			.split(/\s+/)
			.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
			.filter(Boolean)
			.join(" ")
	const isShortCode = (s: string): boolean => {
		const letters = s.replace(/[^\p{L}]/gu, "")

		return letters.length > 0 && letters.length <= 3 && /^[\p{L}.\s]+$/u.test(s)
	}

	const entries = new Map<string, number>()
	const codeEntries = new Map<string, number>()
	let maxNgram = 1

	const addCanonical = (surface: string): void => {
		const key = wordNorm(surface).toLowerCase()

		if (!key || key.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return
		maxNgram = Math.max(maxNgram, key.split(" ").length)
		entries.set(key, 1)
	}
	const addAbbrev = (surface: string): void => {
		const s = surface.trim()

		if (!s) return

		if (isShortCode(s)) {
			const key = wordNorm(s).toUpperCase()

			if (key) codeEntries.set(key, 1)

			return
		}
		addCanonical(s)
	}

	for (const [canonical, abbrevs] of Object.entries(fr.FR_VOIE_TYPES)) {
		addCanonical(canonical)
		for (const a of abbrevs) addAbbrev(a)
	}

	for (const [canonical, variants] of Object.entries(us.US_STREET_SUFFIX_VARIANTS)) {
		addCanonical(canonical)
		for (const v of variants) addAbbrev(v)
	}

	for (const t of gb.GB_STREET_TYPES) addCanonical(t)

	for (const [canonical, variants] of Object.entries(de.DE_STREET_TYPE_VARIANTS)) {
		addCanonical(canonical)
		for (const v of variants) addAbbrev(v)
	}

	for (const suffix of de.DE_STREET_SUFFIXES) addCanonical(suffix)

	for (const t of CA_STREET_TYPES_EN) addCanonical(t)

	for (const t of CA_STREET_TYPES_FR) addCanonical(t)

	for (const d of Object.keys(CA_DIRECTIONALS)) addAbbrev(d)

	const lexicon = {
		version: 1,
		generated_by: "mailwoman gazetteer build street-type-lexicon (source: @mailwoman/codex fr/us/gb/de/ca)",
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
		},
		entries: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
		code_entries: Object.fromEntries([...codeEntries].sort(([a], [b]) => a.localeCompare(b))),
	}

	mkdirSync(dirname(output), { recursive: true })
	writeFileSync(output, JSON.stringify(lexicon, null, 1) + "\n")

	return {
		path: output,
		entries: entries.size + codeEntries.size,
		homographs: 0,
		skippedDegenerate: 0,
		skippedProminence: 0,
		maxNgram,
	}
}
