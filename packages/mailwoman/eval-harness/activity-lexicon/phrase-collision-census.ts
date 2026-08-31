/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The phrase-collision census for `@mailwoman/activity-lexicon` (#1962).
 *
 *   WHAT IT MEASURES. An activity route is asked last: `createRuntimePipeline` consults it only where the committed
 *   category lexicon AND the POI name lookup have both returned nothing. So a declared phrase whose subject either of
 *   those already claims never reaches the route at all, and the shortfall reads as the activity being unreachable
 *   rather than as the phrase being taken. `sem-act-fr-01` is the worked example: `Somewhere` is a venue name in the
 *   shipped `poi.db`, `matchPOISubject` probes the prefix before ` to `, the name rung claims it, and the answer is a
 *   womens_clothing_store 211.75 km from Toulouse.
 *
 *   THE PROBE SET IS WHAT `matchPOISubject` WOULD ACTUALLY MEET, not what the lexicon literally declares. That routine
 *   probes the whole input and then each prefix before an anchor separator, so the strings a phrase is met through are
 *   longer than the phrase. Rather than restate its enumeration — two copies of a rule that must agree — the census
 *   DRIVES the shipped routine with a recording lookup that answers nothing, and keeps every string it was asked about.
 *
 *   THE CLASSIFICATION and the point of the census rather than a detail of it. A colliding venue name is one of
 *   two things, and a decision about ranking rests on which:
 *
 *   - QUERY-SHAPED — the name adds nothing to the query fragment it collides with. It is that fragment: an explicit
 *     query marker (`pharmacy near me`), a name made entirely of function words that any query prefix can consist of
 *     (`Somewhere`), or the bare fragment itself with no distinguishing element. Such a name cannot be told from the
 *     query by construction.
 *   - LEGITIMATE — the name CONTAINS the fragment and carries a distinguishing element beside it (`London Pharmacy`),
 *     which is an ordinary naming convention and not a query at all.
 *
 *   The census REPORTS. It changes no ranking, demotes nothing, and writes nothing back into the lexicon.
 */

import { readActivityLexicon, type ActivityPhraseLexicon, normalizeActivityPhrase } from "@mailwoman/activity-lexicon"
import { pathExists, readDirectoryRecursive, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
import { matchPOISubject, type POIPhraseMatch } from "@mailwoman/kind-classifier"
import { resolvePath, join, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { type LayerManifest, probeManifest } from "#data-inventory"
import { poiTaxonomyLookup } from "#poi-intent"

/**
 * The committed input trees the census reads carrier queries out of, repository-relative.
 */
const COMMITTED_INPUT_ROOTS = [
	"packages/mailwoman/eval-harness/gauntlet/cases",
	"packages/mailwoman/eval-harness/conformance",
	"packages/mailwoman/eval-harness/fixtures",
] as const

/**
 * The JSONL keys that hold a query rather than a label. Named rather than walked: a note field on the promoted board
 * rows quotes the very phrases this census is about, and a census that read prose would report its own documentation as
 * traffic.
 */
const INPUT_KEYS = ["query", "input", "raw", "base", "variant", "surface"] as const

/**
 * Multi-word markers that make a venue name a query on its face.
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
 * Tokens a query prefix can consist entirely of. A name made only of these names no business — it captures whatever the
 * user typed before the anchor.
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
 * Which probe family a candidate subject came from.
 *
 * - `declared-phrase` — a surface form exactly as the lexicon writes it.
 * - `phrase-prefix` — a prefix of a declared phrase, where the phrase itself carries an anchor separator.
 * - `carrier-prefix` — a candidate subject of a COMMITTED query that ends in a declared phrase. This is the family the
 *   `Somewhere` collision lives in, and no amount of reading the lexicon alone would find it.
 */
export type ProbeFamily = "declared-phrase" | "phrase-prefix" | "carrier-prefix"

/**
 * How a colliding venue name is classified, and on which tell.
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
	 * Whether the shipped name rung would actually reach this row: `createPOINameLookup` takes the first eight FTS hits
	 * and requires normalized equality, so a name that exists is not always a name that claims.
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
		 * Names whose FOLDED key equals a probe while the shipped rung's own normalization does not — punctuation or a
		 * diacritic the database folds and the rung keeps. Listed rather than counted: a bare total would leave a reader
		 * unable to tell a harmless near-miss from a collision the rung is failing to see.
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
 * The POI reader the census needs, and it is deliberately NOT the shipped name rung's reader.
 *
 * `createPOINameLookup` asks FTS for eight candidates ranked by bm25 and keeps an exact match among them. Measured
 * against a complete scan, that reads 149 of the 375 distinct names containing `prescription` — so a census built on it
 * would report an absence it had merely not looked at, which is the failure mode a census cannot afford. `containing`
 * is therefore a complete key scan, and `claimedByShippedRung` asks the shipped path the one question it is the
 * authority on: whether the rung actually takes the phrase.
 */
export interface CensusPOIReader {
	/**
	 * Every distinct venue whose folded name key contains at least one probe. Complete: no ranking, no limit.
	 *
	 * The whole probe set at once, because the underlying read is a scan of every venue name and nineteen scans cost
	 * nineteen times one. Whole-token containment is decided here, over what comes back.
	 */
	candidates(probes: ReadonlyArray<string>): ReadonlyArray<CensusVenue>
	/**
	 * Whether the shipped POI name rung claims this phrase — the top-eight FTS read plus normalized equality.
	 */
	claimedByShippedRung(probe: string): boolean
}

export interface PhraseCollisionCensusOptions {
	databasePath: string
	reader: CensusPOIReader
	lexicon?: ActivityPhraseLexicon
	/**
	 * Repository root the committed input trees are read from. Defaults to the checkout this module was loaded from.
	 */
	repositoryRoot?: PathBuilderLike
}

/**
 * Tokenize for containment: letters and digits only, so punctuation and case cannot hide a whole-word match.
 */
function tokenize(value: string): string[] {
	return normalizeActivityPhrase(value)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0)
}

/**
 * Whether `needle`'s tokens appear as a contiguous run inside `haystack`'s.
 */
function containsTokens(haystack: string[], needle: string[]): boolean {
	if (!needle.length || needle.length > haystack.length) return false

	for (let start = 0; start + needle.length <= haystack.length; start++) {
		if (needle.every((token, offset) => haystack[start + offset] === token)) return true
	}

	return false
}

/**
 * Classify one colliding venue name against the probe string it collided with.
 *
 * The rule is stated in the module header and implemented here in the same order: an explicit query marker determines
 * the result; otherwise a name that IS the probe adds nothing and is query-shaped, on whichever of the two remaining
 * tells applies; otherwise the name carries something the probe does not, and is an ordinary name.
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
 * Every candidate subject `matchPOISubject` probes for one input, in the order it probes them.
 *
 * Driven rather than restated: a recording lookup that answers nothing makes the shipped routine walk its whole
 * enumeration — the whole input, then each prefix before an anchor separator, stopping at its own token budget — and
 * the census keeps what it was asked. Two copies of that rule would be free to disagree; this cannot.
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
 * Read every committed input string out of the named trees.
 */
async function committedInputs(repositoryRoot: PathBuilderLike): Promise<{ inputs: Set<string>; files: number }> {
	const inputs = new Set<string>()
	let files = 0

	for (const relative of COMMITTED_INPUT_ROOTS) {
		const root = join(repositoryRoot, relative)

		if (!(await pathExists(root))) continue

		const paths = (await readDirectoryRecursive(root))
			.filter((entry) => entry.endsWith(".jsonl"))
			.map((entry) => resolvePath(root, entry))
			.toSorted()

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
 * Run the census.
 */
export async function runPhraseCollisionCensus(options: PhraseCollisionCensusOptions): Promise<PhraseCollisionCensus> {
	const lexicon = options.lexicon ?? (await readActivityLexicon())
	const repositoryRoot = options.repositoryRoot ?? String(repoRootPath())
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

			// The key scan folds punctuation and diacritics; the shipped rung's comparison keeps them. So a name can be the
			// probe on tokens and differ on the rung's own test. Counted so the two readings never disagree silently.
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
			path: options.databasePath,
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
 * How many containment rows the printer lists before summarizing. The committed report carries every one; the terminal
 * summary is a reader's first look, and a few hundred ordinary venue names past this point tell them nothing new.
 */
const PRINTED_CONTAINMENT_ROWS = 40

/**
 * The census as a reader reads it. Every colliding name is printed, not a count of them: the decision the census feeds
 * is about which names are query-shaped, and a total cannot be re-adjudicated.
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
			`  ${JSON.stringify(collision.probe)} [${collision.locale ?? "no locale"}] → ${collision.match.kind ?? "category"} ${collision.match.categoryID} (${collision.match.matchedPhrase})`
		)
	}

	const { counts, exactCollisions, containment, foldOnlyMatches } = census.nameLexicon

	console.log(
		`\nname-lexicon exact collisions: ${exactCollisions.length} — query-shaped ${counts.exactQueryShaped}, legitimate ${counts.exactLegitimate} · ${foldOnlyMatches.length} more matched on the folded key alone`
	)

	for (const collision of exactCollisions) {
		console.log(
			`  ${JSON.stringify(collision.probe)} = ${JSON.stringify(collision.name)} [${collision.country}${collision.categoryID ? ` ${collision.categoryID}` : ""}] → ${collision.verdict.class}/${collision.verdict.tell}${collision.reachedByShippedRung ? " · CLAIMS" : ""}`
		)
	}

	console.log(
		`\nnames containing a probe without being one: ${containment.length} — query-shaped ${counts.containmentQueryShaped}, legitimate ${counts.containmentLegitimate}`
	)

	for (const row of containment.slice(0, PRINTED_CONTAINMENT_ROWS)) {
		console.log(
			`  ${JSON.stringify(row.probe)} ⊂ ${JSON.stringify(row.name)} [${row.country}${row.categoryID ? ` ${row.categoryID}` : ""}] → ${row.verdict.class}/${row.verdict.tell}`
		)
	}

	if (containment.length > PRINTED_CONTAINMENT_ROWS) {
		console.log(`  … ${containment.length - PRINTED_CONTAINMENT_ROWS} more, all in the committed report`)
	}
}
