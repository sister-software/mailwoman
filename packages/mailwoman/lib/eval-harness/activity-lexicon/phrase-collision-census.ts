/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Census the phrases and prefixes the POI intent matcher may probe, then classify matching venue names as
 *   query-shaped or legitimate. Drive the shipped matcher with a recording lookup to enumerate probes. This report
 *   does not change rankings or the lexicon.
 */

import { readActivityLexicon, type ActivityPhraseLexicon, normalizeActivityPhrase } from "@mailwoman/activity-lexicon"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { matchPOISubject, type POIPhraseMatch } from "@mailwoman/kind-classifier"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { type LayerManifest, probeManifest } from "#data/inventory"
import { poiTaxonomyLookup } from "#poi/intent"

/**
 * Repository-relative trees containing committed query inputs.
 */
const COMMITTED_INPUT_ROOTS = [
	"packages/mailwoman/lib/eval-harness/gauntlet/cases",
	"packages/mailwoman/lib/eval-harness/conformance",
	"packages/mailwoman/lib/eval-harness/fixtures",
] as const

/**
 * JSONL fields containing queries.
 * Avoid prose fields that may quote test phrases.
 */
const INPUT_KEYS = ["query", "input", "raw", "base", "variant", "surface"] as const

/**
 * Phrases that identify query syntax.
 */
const QUERY_MARKERS = [
	"near me",
	"nearby me",
	"close to me",
	"close by me",
	"around me",
	"next to me",
	"where can i",
	"where do i",
	"how do i",
	"open now",
	"open 24 hours",
] as const

/**
 * Function words that can form an anchorless query prefix.
 */
const FUNCTION_WORDS = new Set([
	"a",
	"an",
	"and",
	"any",
	"anywhere",
	"are",
	"around",
	"at",
	"be",
	"best",
	"by",
	"can",
	"close",
	"could",
	"do",
	"does",
	"every",
	"everywhere",
	"find",
	"for",
	"get",
	"go",
	"going",
	"good",
	"here",
	"how",
	"i",
	"in",
	"is",
	"looking",
	"me",
	"my",
	"near",
	"nearby",
	"need",
	"no",
	"nowhere",
	"of",
	"on",
	"or",
	"our",
	"please",
	"should",
	"some",
	"something",
	"somewhere",
	"the",
	"there",
	"to",
	"want",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"would",
	"you",
	"your",
])

/**
 * Source of a candidate subject: declared phrase, phrase prefix, or committed-query prefix.
 */
export type ProbeFamily = "declared-phrase" | "phrase-prefix" | "carrier-prefix"

/**
 * Classification and reason for a venue-name collision.
 */
export type VenueNameClass = "query-shaped" | "legitimate"

export interface VenueNameVerdict {
	class: VenueNameClass
	/**
	 * `query-syntax`, `function-word`, `bare-query-fragment`, or `distinguishing-element`.
	 */
	tell: string
}

export interface NameCollision {
	probe: string
	families: ProbeFamily[]
	name: string
	categoryID: string | null
	country: string
	verdict: VenueNameVerdict
	/**
	 * Whether the shipped name rung would actually reach this row: `createPOINameLookup`
	 * takes the first eight FTS hits and requires normalized equality, so a name
	 * that exists is not always a name that claims.
	 */
	reachedByShippedRung: boolean
}

export interface ContainmentRow {
	probe: string
	families: ProbeFamily[]
	name: string
	categoryID: string | null
	country: string
	verdict: VenueNameVerdict
}

export interface CategoryCollision {
	probe: string
	families: ProbeFamily[]
	locale: string | null
	match: POIPhraseMatch
}

export interface PhraseCollisionCensus {
	censusID: "activity-phrase-collision-census"
	generatedAt: string
	lexicon: { lexiconID: string; version: string; declaredPhrases: number }
	poiDatabase: { path: string; layerManifest?: LayerManifest; layerManifestNote?: string }
	probes: {
		distinct: number
		byFamily: Record<ProbeFamily, number>
		strings: Array<{ probe: string; families: ProbeFamily[] }>
	}
	committedInputs: { scanned: number; routeClaimable: number; files: number }
	categoryLexicon: { collisions: CategoryCollision[] }
	nameLexicon: {
		exactCollisions: NameCollision[]
		containment: ContainmentRow[]
		/**
		 * Names whose folded key equals a probe while the shipped rung's own normalization
		 * does not — punctuation or a diacritic the database folds and the rung keeps.
		 *
		 * Listed rather than counted: a bare total would leave a reader unable to tell a
		 * harmless near-miss from a collision the rung is failing to see.
		 */
		foldOnlyMatches: Array<{ probe: string; name: string }>
		counts: {
			exactQueryShaped: number
			exactLegitimate: number
			containmentQueryShaped: number
			containmentLegitimate: number
		}
	}
}

/**
 * One venue row, as the census reads it.
 */
export interface CensusVenue {
	name: string
	categoryID: string | null
	country: string
}

/**
 * Complete POI-name reader for census candidates plus a check against the shipped name rung.
 */
export interface CensusPOIReader {
	/**
	 * All distinct venue names containing any probe, without ranking or result limits.
	 */
	candidates(probes: ReadonlyArray<string>): ReadonlyArray<CensusVenue>
	/**
	 * Whether the shipped POI name lookup accepts this phrase.
	 */
	claimedByShippedRung(probe: string): boolean
}

export interface PhraseCollisionCensusOptions {
	databasePath: PathBuilderLike
	reader: CensusPOIReader
	lexicon?: ActivityPhraseLexicon
	/**
	 * Root for committed inputs.
	 * Defaults to the current checkout.
	 */
	repositoryRoot?: PathBuilderLike
}

/**
 * Tokenize letters and digits for punctuation- and case-insensitive containment.
 */
function tokenize(value: string): string[] {
	return normalizeActivityPhrase(value)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length)
}

/**
 * Check whether `needle` occurs contiguously in `haystack`.
 */
function containsTokens(haystack: string[], needle: string[]): boolean {
	if (!needle.length || needle.length > haystack.length) return false

	for (let start = 0; start + needle.length <= haystack.length; start++) {
		if (needle.every((token, offset) => haystack[start + offset] === token)) return true
	}

	return false
}

/**
 * Classify a colliding venue name as query-shaped or legitimate.
 */
export function classifyVenueName(name: string, probe: string): VenueNameVerdict {
	const normalized = normalizeActivityPhrase(name)

	if (QUERY_MARKERS.some((marker) => normalized === marker || normalized.includes(marker))) {
		return { class: "query-shaped", tell: "query-syntax" }
	}

	if (normalized !== normalizeActivityPhrase(probe)) {
		return { class: "legitimate", tell: "distinguishing-element" }
	}

	const tokens = tokenize(normalized)

	if (tokens.length && tokens.every((token) => FUNCTION_WORDS.has(token))) {
		return { class: "query-shaped", tell: "function-word" }
	}

	return { class: "query-shaped", tell: "bare-query-fragment" }
}

/**
 * Record every subject probed by the shipped `matchPOISubject` implementation.
 */
export function candidateSubjects(input: string): string[] {
	const asked: string[] = []

	matchPOISubject(input, undefined, (phrase) => {
		asked.push(phrase)

		return []
	})

	return asked
}

/**
 * Read query strings from the committed input trees.
 */
async function committedInputs(repositoryRoot: PathBuilderLike): Promise<{ inputs: Set<string>; files: number }> {
	const inputs = new Set<string>()
	let files = 0

	for (const relative of COMMITTED_INPUT_ROOTS) {
		const root = resolvePathBuilder(repositoryRoot, relative)

		if (!(await pathExists(root))) continue

		const paths = await Globerator.files("jsonl", { cwd: root, absolute: true }).toSorted()

		for (const path of paths) {
			files++

			for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
				if (!line.trim()) continue

				const row = parseJSONStrict<Record<string, unknown>>(line)

				for (const key of INPUT_KEYS) {
					const value = row[key]

					if (typeof value === "string" && value.trim()) {
						inputs.add(value)
					}
				}
			}
		}
	}

	return { inputs, files }
}

/**
 * Build the phrase-collision census.
 */
export async function runPhraseCollisionCensus(options: PhraseCollisionCensusOptions): Promise<PhraseCollisionCensus> {
	const lexicon = options.lexicon ?? (await readActivityLexicon())
	const repositoryRoot = options.repositoryRoot ?? repoRootPath()
	const declared = lexicon.phrases.map((entry) => normalizeActivityPhrase(entry.phrase))

	const claims = (subject: string): boolean => {
		const normalized = normalizeActivityPhrase(subject)

		return declared.some((phrase) => normalized === phrase || normalized.endsWith(` ${phrase}`))
	}

	const families = new Map<string, Set<ProbeFamily>>()

	const record = (probe: string, family: ProbeFamily): void => {
		const normalized = normalizeActivityPhrase(probe)

		if (!normalized) return

		const existing = families.get(normalized)

		if (existing) {
			existing.add(family)

			return
		}

		families.set(normalized, new Set([family]))
	}

	for (const entry of lexicon.phrases) {
		record(entry.phrase, "declared-phrase")

		for (const subject of candidateSubjects(entry.phrase)) {
			if (normalizeActivityPhrase(subject) === normalizeActivityPhrase(entry.phrase)) continue

			record(subject, "phrase-prefix")
		}
	}

	const { inputs, files } = await committedInputs(repositoryRoot)
	let routeClaimable = 0

	for (const input of inputs) {
		const subjects = candidateSubjects(input)

		if (!subjects.some(claims)) continue

		routeClaimable++

		for (const subject of subjects) {
			record(subject, "carrier-prefix")
		}
	}

	const probes = [...families.keys()].toSorted()
	const familiesOf = (probe: string): ProbeFamily[] => [...(families.get(probe) ?? [])].toSorted()

	const categoryCollisions: CategoryCollision[] = []
	const exactCollisions: NameCollision[] = []
	const containment: ContainmentRow[] = []
	const foldOnlyMatches: Array<{ probe: string; name: string }> = []

	const locales = [null, ...new Set(lexicon.phrases.flatMap((entry) => entry.locales ?? []))]

	const venues = options.reader.candidates(probes)
	const tokenized = venues.map((venue) => ({ venue, tokens: tokenize(venue.name) }))

	for (const probe of probes) {
		for (const locale of locales) {
			for (const match of poiTaxonomyLookup(probe, locale ?? undefined)) {
				categoryCollisions.push({ probe, families: familiesOf(probe), locale, match })
			}
		}

		const probeTokens = tokenize(probe)
		const seen = new Set<string>()
		let claimed: boolean | undefined

		for (const { venue, tokens } of tokenized) {
			if (!venue.name || seen.has(venue.name)) continue

			if (!containsTokens(tokens, probeTokens)) continue

			seen.add(venue.name)

			const row = {
				probe,
				families: familiesOf(probe),
				name: venue.name,
				categoryID: venue.categoryID,
				country: venue.country,
				verdict: classifyVenueName(venue.name, probe),
			}

			if (normalizeActivityPhrase(venue.name) === probe) {
				claimed ??= options.reader.claimedByShippedRung(probe)

				exactCollisions.push({ ...row, reachedByShippedRung: claimed })

				continue
			}

			// The census folds punctuation and diacritics; the shipped rung does not.
			// Counted so the two readings never disagree silently.
			if (tokens.length === probeTokens.length) {
				foldOnlyMatches.push({ probe, name: venue.name })

				continue
			}

			containment.push(row)
		}
	}

	const { manifest, error } = probeManifest(options.databasePath)

	return {
		censusID: "activity-phrase-collision-census",
		generatedAt: new Date().toISOString(),
		lexicon: {
			lexiconID: lexicon.lexiconID,
			version: lexicon.version,
			declaredPhrases: lexicon.phrases.length,
		},
		poiDatabase: {
			path: options.databasePath.toString(),
			...(manifest ? { layerManifest: manifest } : {}),
			...(manifest ? {} : { layerManifestNote: error ?? "no layer_manifest row" }),
		},
		probes: {
			distinct: probes.length,
			byFamily: {
				"declared-phrase": probes.filter((probe) => familiesOf(probe).includes("declared-phrase")).length,
				"phrase-prefix": probes.filter((probe) => familiesOf(probe).includes("phrase-prefix")).length,
				"carrier-prefix": probes.filter((probe) => familiesOf(probe).includes("carrier-prefix")).length,
			},
			strings: probes.map((probe) => ({ probe, families: familiesOf(probe) })),
		},
		committedInputs: { scanned: inputs.size, routeClaimable, files },
		categoryLexicon: { collisions: categoryCollisions },
		nameLexicon: {
			exactCollisions,
			containment,
			foldOnlyMatches,
			counts: {
				exactQueryShaped: exactCollisions.filter((row) => row.verdict.class === "query-shaped").length,
				exactLegitimate: exactCollisions.filter((row) => row.verdict.class === "legitimate").length,
				containmentQueryShaped: containment.filter((row) => row.verdict.class === "query-shaped").length,
				containmentLegitimate: containment.filter((row) => row.verdict.class === "legitimate").length,
			},
		},
	}
}

/**
 * Maximum containment rows printed to the terminal; the committed report includes all rows.
 */
const PRINTED_CONTAINMENT_ROWS = 40

/**
 * Print collision details and summary counts for review.
 */
export function printPhraseCollisionCensus(census: PhraseCollisionCensus): void {
	console.log(
		`activity-phrase collision census · ${census.lexicon.lexiconID} v${census.lexicon.version} (${census.lexicon.declaredPhrases} phrases)`
	)
	console.log(
		`poi.db ${census.poiDatabase.layerManifest ? `${census.poiDatabase.layerManifest.name} ${census.poiDatabase.layerManifest.version}` : census.poiDatabase.layerManifestNote} · ${census.poiDatabase.path}`
	)
	console.log(
		`probes: ${census.probes.distinct} distinct — ${census.probes.byFamily["declared-phrase"]} declared, ${census.probes.byFamily["phrase-prefix"]} phrase prefixes, ${census.probes.byFamily["carrier-prefix"]} carrier prefixes`
	)
	console.log(
		`committed inputs scanned: ${census.committedInputs.scanned} over ${census.committedInputs.files} files · ${census.committedInputs.routeClaimable} the lexicon could claim\n`
	)

	console.log(`category-lexicon collisions: ${census.categoryLexicon.collisions.length}`)

	for (const collision of census.categoryLexicon.collisions) {
		console.log(
			`  ${stringifyJSON(collision.probe)} [${collision.locale ?? "no locale"}] → ${collision.match.kind ?? "category"} ${collision.match.categoryID} (${collision.match.matchedPhrase})`
		)
	}

	const { counts, exactCollisions, containment, foldOnlyMatches } = census.nameLexicon

	console.log(
		`\nname-lexicon exact collisions: ${exactCollisions.length} — query-shaped ${counts.exactQueryShaped}, legitimate ${counts.exactLegitimate} · ${foldOnlyMatches.length} more matched on the folded key alone`
	)

	for (const collision of exactCollisions) {
		console.log(
			`  ${stringifyJSON(collision.probe)} = ${stringifyJSON(collision.name)} [${collision.country}${collision.categoryID ? ` ${collision.categoryID}` : ""}] → ${collision.verdict.class}/${collision.verdict.tell}${collision.reachedByShippedRung ? " · CLAIMS" : ""}`
		)
	}

	console.log(
		`\nnames containing a probe without being one: ${containment.length} — query-shaped ${counts.containmentQueryShaped}, legitimate ${counts.containmentLegitimate}`
	)

	for (const row of containment.slice(0, PRINTED_CONTAINMENT_ROWS)) {
		console.log(
			`  ${stringifyJSON(row.probe)} ⊂ ${stringifyJSON(row.name)} [${row.country}${row.categoryID ? ` ${row.categoryID}` : ""}] → ${row.verdict.class}/${row.verdict.tell}`
		)
	}

	if (containment.length > PRINTED_CONTAINMENT_ROWS) {
		console.log(`  … ${containment.length - PRINTED_CONTAINMENT_ROWS} more, all in the committed report`)
	}
}
