/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Derive the committed address-source register from a research pass's two CSVs.
 *
 * The second input is mostly not input: the eight global discovery lookups repeat once per jurisdiction and are dropped, because they name a lookup rather than a national source.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import {
	applyLicenseDecisions,
	auditAddressSourceRegister,
	registerContentDigest,
	BackboneState,
	JurisdictionResearchState,
	LicenseReviewState,
	ResearchPass,
	SourceGeometry,
	SourceStatus,
	UNRESOLVED_FIELDS,
	type AddressSourceRecord,
	type AddressSourceRegister,
	type ElectedLicense,
	type JurisdictionRecord,
	type LicenseDecision,
	type RefusedLicense,
	type RegisterSector,
	type UncheckedLicense,
} from "#source-register/index"
import { AddressRole } from "#types"

/**
 * The `origin` value the research pass gives its eight repeated discovery lookups;
 * every row carrying it is dropped.
 */
const DISCOVERY_RAIL_ORIGIN = "global_research_rail"

/**
 * Joins the two parts of the per-sector counter's key.
 *
 * A solidus is used because a NUL cannot survive a format pass, and it is safe because an ISO
 * 3166-1 code is two letters and a sector is kebab-case, so neither part can contain one.
 */
const KEY_SEPARATOR = "/"

const BACKBONE_STATE_BY_LETTER: Readonly<Record<string, BackboneState>> = {
	A: BackboneState.Verified,
	"A~": BackboneState.VerifiedPartial,
	B: BackboneState.Restricted,
	C: BackboneState.Unverified,
	D: BackboneState.Exceptional,
}

const RESEARCH_STATE_BY_NAME: Readonly<Record<string, JurisdictionResearchState>> = {
	SEEDED: JurisdictionResearchState.Seeded,
	EXCEPTION: JurisdictionResearchState.Exception,
	RAILS_ONLY: JurisdictionResearchState.Unexamined,
}

/**
 * Every `AddressRole` by its wire value, derived from the enum so a role added to `AddressRole` is
 * readable here without a second edit and a value the CSV carries that is not a role fails the build.
 */
const ADDRESS_ROLE_BY_NAME: Readonly<Record<string, AddressRole>> = Object.fromEntries(
	Object.values(AddressRole).map((role) => [role, role])
)

const SOURCE_STATUS_BY_NAME: Readonly<Record<string, SourceStatus>> = {
	VERIFIED_AUTHORITY: SourceStatus.VerifiedAuthority,
	RETAINED_ORIGINAL: SourceStatus.RetainedOriginal,
	VERIFIED_CORPUS: SourceStatus.VerifiedCorpus,
	VERIFIED_CORPUS_STALE: SourceStatus.VerifiedCorpusStale,
}

const RESEARCH_PASS_BY_ORIGIN: Readonly<Record<string, ResearchPass>> = {
	"2026-09-18_web_research": ResearchPass.WebResearch,
	original_memo: ResearchPass.OriginalMemo,
}

const GEOMETRY_BY_NAME: Readonly<Record<string, SourceGeometry>> = {
	Y: SourceGeometry.Present,
	N: SourceGeometry.Absent,
	Partial: SourceGeometry.Partial,
	varies: SourceGeometry.Unresolved,
	"": SourceGeometry.Unresolved,
}

/**
 * The research pass writes a source's propositions as one string; closed, because a spelling this
 * does not carry is a vocabulary the register has not agreed to rather than a row to guess at.
 */
const ASSERTS_BY_ROLE: Readonly<Record<string, readonly AddressSourceRecord["asserts"][number][]>> = {
	"IDENTITY + OBSERVATION": ["identity", "observation"],
	OBSERVATION: ["observation"],
}

/**
 * The access labels the research pass recorded, each with the id prefix
 * and note a decision derived from it carries.
 *
 * A decision is scoped to one publisher in one jurisdiction by {@link scopedLicenseID},
 * so an election cannot reach past the grant it was made about.
 * Every decision is `unchecked`, because the pass recorded what a register costs
 * to reach and never opened anybody's terms.
 */
const LICENSE_DECISIONS: ReadonlyArray<readonly [statement: string, licenseID: string, note: string]> = [
	[
		"CHECK NATIONAL / DATASET TERMS",
		"unchecked-national-terms",
		"The research pass recorded the register and did not open its terms.",
	],
	[
		"Free",
		"unchecked-access-free",
		"An access label from the original memo: the download costs nothing. It states no grant.",
	],
	["Free-reg", "unchecked-access-free-registration", "An access label: free after registration. It states no grant."],
	[
		"Free/varied",
		"unchecked-access-free-varied",
		"An access label: free in part, varying by dataset. It states no grant.",
	],
	[
		"Free/restricted",
		"unchecked-access-free-or-restricted",
		"An access label: free in part, restricted in part. It states no grant.",
	],
	[
		"Free/Free-reg",
		"unchecked-access-free-or-registration",
		"An access label: free, or free after registration. It states no grant.",
	],
	[
		"Free/Licensed",
		"unchecked-access-free-or-licensed",
		"An access label: free in part, licensed in part. It states no grant.",
	],
	[
		"Free-reg/Licensed",
		"unchecked-access-registration-or-licensed",
		"An access label: free after registration, or licensed. It states no grant.",
	],
	["Restricted", "unchecked-access-restricted", "An access label: access is restricted. It states no grant."],
	["Varied", "unchecked-access-varied", "An access label: varying by dataset. It states no grant."],
	[
		"Licensed",
		"unchecked-access-licensed",
		"An access label: a licence is sold or granted on application. It states no terms.",
	],
	[
		"Licensed/query",
		"unchecked-access-licensed-or-query",
		"An access label: licensed, or answerable per query. It states no terms.",
	],
]

/**
 * Whole notes the research pass wrote in vocabulary this repository has retired, and what each becomes.
 *
 * Each rewrite must fire at least once, so a pair left behind after the upstream
 * text changes fails the build.
 */
const RETIRED_NOTE_REWRITES: ReadonlyArray<readonly [from: string, to: string]> = [
	[
		"Official CC BY dataset, but portal states only ~4% geographic coverage; not national LABEL.",
		"Official CC BY dataset, but portal states only ~4% geographic coverage; not a national address backbone.",
	],
	[
		"High-value taxpayer address observations; no verified national open premise LABEL.",
		"High-value taxpayer address observations; no verified national open premise address backbone.",
	],
	[
		"2026 system is new; validate operational bulk access before corpus promotion.",
		"The national system is new; validate operational bulk access before corpus promotion.",
	],
]

/**
 * Words this repository has removed from its vocabulary, and the plain synonym
 * each takes wherever the research pass used one.
 *
 * The substitution runs over every string this build emits, because `repo-health`'s
 * `bannedVocabulary` counter reads every tracked text file and a committed JSON artifact is one.
 */
const RETIRED_WORD_REWRITES: ReadonlyArray<readonly [pattern: RegExp, to: string]> = [
	[/\bGated\b/g, "Restricted"],
	[/\bgated\b/g, "restricted"],
	[/-gated\b/g, "-restricted"],
]

/**
 * What the build produced, for a caller that wants to print it rather than re-read the file.
 */
export interface SourceRegisterBuildResult {
	outPath: string
	jurisdictions: number
	sources: number
	licenses: number
	/**
	 * Rows dropped because they carry a global discovery lookup rather than a national source.
	 */
	discoveryRailRowsDropped: number
	researchStates: Readonly<Record<JurisdictionResearchState, number>>
	statuses: Readonly<Record<SourceStatus, number>>
}

export interface BuildSourceRegisterOptions {
	/**
	 * The 250-row jurisdiction inventory CSV.
	 */
	inventoryPath: PathBuilderLike
	/**
	 * The functional-authority CSV, discovery lookups included.
	 *
	 * This build drops them.
	 */
	sourcesPath: PathBuilderLike
	outPath: PathBuilderLike
	/**
	 * Licence decisions somebody made by reading a publisher's terms, applied over the
	 * `unchecked` defaults this build derives from the research pass's access labels.
	 *
	 * An input rather than an edit of the output, because the register is generated
	 * and {@linkcode buildSourceRegister} rewrites it whole; a path that does not
	 * exist is read as no decisions recorded.
	 */
	decisionsPath?: PathBuilderLike
	version: string
	/**
	 * ISO 8601 calendar date the research pass was taken, `yyyy-MM-DD`.
	 */
	authoredAt: string
	/**
	 * The research document the pass was written against, recorded in the register's provenance.
	 */
	sourceVersion?: string
}

function required(value: string | undefined, field: string, row: number): string {
	const trimmed = (value ?? "").trim()

	if (!trimmed) throw new Error(`row ${row}: ${field} is empty, and the register has nowhere to put an unnamed value`)

	return trimmed
}

function mapped<T>(table: Readonly<Record<string, T>>, key: string, field: string, row: number): T {
	const value = table[key]

	if (value === undefined) {
		throw new Error(`row ${row}: ${field} is ${stringifyJSON(key)}, which this build has no mapping for`)
	}

	return value
}

/**
 * Replace every retired word in one string.
 */
export function rewriteRetiredVocabulary(text: string): string {
	let out = text

	for (const [pattern, to] of RETIRED_WORD_REWRITES) {
		out = out.replaceAll(pattern, to)
	}

	return out
}

/**
 * Apply the whole-note rewrites, recording which fired, then the word-level ones.
 */
function rewriteNote(note: string, fired: Set<string>): string {
	for (const [from, to] of RETIRED_NOTE_REWRITES) {
		if (note === from) {
			fired.add(from)

			return to
		}
	}

	return rewriteRetiredVocabulary(note)
}

async function readJurisdictions(
	inventoryPath: PathBuilderLike,
	fired: Set<string>
): Promise<readonly JurisdictionRecord[]> {
	const records: JurisdictionRecord[] = []
	let row = 1

	for await (const record of readCSVRecords(inventoryPath)) {
		row++

		const researchState = mapped(
			RESEARCH_STATE_BY_NAME,
			required(record["functional_research_state"], "functional_research_state", row),
			"functional_research_state",
			row
		)

		const jurisdiction: JurisdictionRecord = {
			iso2: required(record["iso2"], "iso2", row),
			name: required(record["jurisdiction"], "jurisdiction", row),
			backboneState: mapped(BACKBONE_STATE_BY_LETTER, required(record["tier"], "tier", row), "tier", row),
			researchState,
			bestPath: rewriteRetiredVocabulary(required(record["source"], "source", row)),
			assertionPlan: required(record["role"], "role", row),
			note: rewriteNote(required(record["notes"], "notes", row), fired),
		}

		if (researchState !== JurisdictionResearchState.Seeded) {
			jurisdiction.stateReason = rewriteRetiredVocabulary(
				required(record["functional_next_action"], "functional_next_action", row)
			)
		}

		records.push(jurisdiction)
	}

	return records
}

/**
 * What one generated license decision is about: the access label the research pass recorded,
 * and the party whose terms a reviewer would open to decide it.
 */
interface LicenseScope {
	licenseID: string
	/**
	 * The label's own words, carried through so a reviewer sees what the pass wrote.
	 */
	statement: string
	/**
	 * The publisher whose terms this decision covers, or `null` when the row names none
	 * and the decision therefore covers one source alone.
	 */
	publisher: string | null
	scopedTo: string
	/**
	 * The jurisdiction and `scopedTo` folded by {@link partyKey}.
	 *
	 * Two rows whose keys agree name one party in one jurisdiction, however they spell it.
	 */
	partyKey: string
	iso2: string
}

/**
 * A party's name reduced to the form that decides whether two spellings name the same party:
 * lower-cased with every run outside `a-z0-9` collapsed to one hyphen, so case
 * and punctuation merge rather than issue two decisions over one grant.
 */
function partyKey(value: string): string {
	const slug = value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")

	return slug || "unnamed"
}

/**
 * The id fragment for a party: its key trimmed so one long ministry name does not dominate the id,
 * which is why {@link scopedLicenseID} compares the untrimmed key before accepting a match.
 */
const ID_FRAGMENT_LENGTH = 48

function idFragment(partyKeyValue: string): string {
	return partyKeyValue.slice(0, ID_FRAGMENT_LENGTH).replaceAll(/-+$/gu, "") || "unnamed"
}

/**
 * The license id for one source row, scoped to the party a reviewer would read.
 *
 * The id carries the publisher when the row names one and the source id when it does not,
 * and the jurisdiction is part of the scope because a publisher name is not unique across states.
 */
function scopedLicenseID(
	statementID: string,
	publisher: string,
	sourceID: string,
	iso2: string,
	statement: string,
	scopes: Map<string, LicenseScope>
): string {
	const scopedTo = publisher || sourceID
	const key = `${iso2.toLowerCase()}-${partyKey(scopedTo)}`
	const licenseID = `${statementID}-${idFragment(key)}`
	const existing = scopes.get(licenseID)

	if (existing && existing.partyKey !== key) {
		throw new Error(
			`two license scopes collapse to ${stringifyJSON(licenseID)}: ${stringifyJSON(existing.scopedTo)} and ` +
				`${stringifyJSON(scopedTo)}. They are different parties whose names agree over the first ` +
				`${ID_FRAGMENT_LENGTH} characters of their id fragment. Merging them would let one reading grant both, ` +
				"which is what scoping the id to a publisher exists to prevent."
		)
	}

	if (!existing) {
		scopes.set(licenseID, { licenseID, statement, publisher: publisher || null, scopedTo, partyKey: key, iso2 })
	}

	return licenseID
}

async function readSources(
	sourcesPath: PathBuilderLike,
	licenseByStatement: ReadonlyMap<string, string>,
	fired: Set<string>,
	scopes: Map<string, LicenseScope>
): Promise<{ sources: readonly AddressSourceRecord[]; discoveryRailRowsDropped: number }> {
	const records: AddressSourceRecord[] = []
	const ordinalByKey = new Map<string, number>()
	let discoveryRailRowsDropped = 0
	let row = 1

	for await (const record of readCSVRecords(sourcesPath)) {
		row++

		const origin = required(record["origin"], "origin", row)

		if (origin === DISCOVERY_RAIL_ORIGIN) {
			discoveryRailRowsDropped++

			continue
		}

		const iso2 = required(record["iso2"], "iso2", row)
		const sector = required(record["sector"], "sector", row).replaceAll("_", "-") as RegisterSector
		const key = iso2 + KEY_SEPARATOR + sector
		const ordinal = (ordinalByKey.get(key) ?? 0) + 1

		ordinalByKey.set(key, ordinal)

		const statement = rewriteRetiredVocabulary(required(record["license"], "license", row))
		const statementID = licenseByStatement.get(statement)

		if (!statementID) {
			throw new Error(`row ${row}: license ${stringifyJSON(statement)} has no decision record in this build`)
		}

		const sourceID = `${iso2.toLowerCase()}-${sector}-${ordinal}`
		const publisherName = rewriteRetiredVocabulary((record["owner"] ?? "").trim())
		const licenseID = scopedLicenseID(statementID, publisherName, sourceID, iso2, statement, scopes)

		const source: AddressSourceRecord = {
			sourceID,
			iso2,
			sector,
			name: rewriteRetiredVocabulary(required(record["source"], "source", row)),
			status: mapped(SOURCE_STATUS_BY_NAME, required(record["status"], "status", row), "status", row),
			asserts: mapped(ASSERTS_BY_ROLE, required(record["role"], "role", row), "role", row),
			authorityBasis: rewriteRetiredVocabulary(required(record["authority_basis"], "authority_basis", row)),
			geometry: mapped(GEOMETRY_BY_NAME, (record["geometry"] ?? "").trim(), "geometry", row),
			license: licenseID,
			researchPass: mapped(RESEARCH_PASS_BY_ORIGIN, origin, "origin", row),
		}

		const access = (record["access"] ?? "").trim()
		const sourceURL = (record["source_url"] ?? "").trim()
		const note = (record["notes"] ?? "").trim()

		if (access) {
			source.access = rewriteRetiredVocabulary(access)
		}

		if (publisherName) {
			source.publisher = publisherName
		}

		if (sourceURL) {
			source.sourceURL = sourceURL
		}

		if (note) {
			source.note = rewriteNote(note, fired)
		}

		const role = readUnresolvedColumn(record["address_role"], "address_role", row)

		if (role) {
			source.addressRole = mapped(ADDRESS_ROLE_BY_NAME, role, "address_role", row)
		}

		const coverage = readUnresolvedColumn(record["coverage"], "coverage", row)

		if (coverage) {
			source.coverage = coverage
		}

		const upstream = readUnresolvedColumn(record["upstream"], "upstream", row)

		if (upstream) {
			source.upstreamLineage = upstream
				.split(";")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		}

		records.push(source)
	}

	return { sources: records, discoveryRailRowsDropped }
}

/**
 * Values the research pass wrote into a column it did not resolve per source.
 *
 * Carrying them onto a record would turn "nobody looked" into a value a consumer reads as an answer.
 */
const UNRESOLVED_COLUMN_PLACEHOLDERS: ReadonlySet<string> = new Set(["varies", "country-specific", "unknown", "n/a"])

/**
 * A column's value, or `undefined` when the research pass left it unresolved.
 *
 * Anything outside the placeholder set is returned, so a value somebody fills in later
 * reaches the register or fails the build rather than being lost.
 */
export function readUnresolvedColumn(value: string | undefined, column: string, row: number): string | undefined {
	const trimmed = (value ?? "").trim()

	if (!trimmed) return undefined

	if (UNRESOLVED_COLUMN_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined

	if (column === "address_role" && !ADDRESS_ROLE_BY_NAME[trimmed.toLowerCase()]) {
		throw new Error(
			`row ${row}: address_role ${stringifyJSON(trimmed)} is neither a declared placeholder nor an \`AddressRole\`. ` +
				`Add it to \`AddressRole\` if it is a role, or to the placeholder set if it is the research pass declining ` +
				"to answer."
		)
	}

	return trimmed
}

/**
 * Build the register and write it, refusing to write one that fails the audit.
 *
 * The output is tab-indented JSON, which `oxfmt` reformats a little further.
 *
 * @throws When an input row carries a vocabulary this build has no mapping for, when a declared
 * rewrite never fires, or when the finished register fails {@linkcode auditAddressSourceRegister}.
 */
/**
 * The shape `license-decisions.json` carries: licence id to the decision minus its own id,
 * keyed by id so one licence cannot carry two.
 */
interface LicenseDecisionsFile {
	decisions?: Record<string, Omit<ElectedLicense, "licenseID"> | Omit<RefusedLicense, "licenseID">>
}

/**
 * Licence decisions read from `decisionsPath`, keyed by licence id.
 *
 * An absent file answers an empty map, but a file that exists and cannot be parsed raises,
 * because reading it as empty would silently drop somebody's recorded work.
 * This function validates no decision it reads, because `auditAddressSourceRegister` already does.
 */
async function readLicenseDecisions(decisionsPath: PathBuilderLike | undefined): Promise<Map<string, LicenseDecision>> {
	if (!decisionsPath || !(await pathExists(decisionsPath))) return new Map()

	const file = await readLocalJSONFile<LicenseDecisionsFile>(decisionsPath)

	// The id comes from the key, so a record cannot disagree with the licence it is filed under;
	// `auditAddressSourceRegister` decides whether what it carries is a well-formed decision.
	return new Map(
		Object.entries(file.decisions ?? {}).map(([licenseID, decision]) => [
			licenseID,
			{ ...decision, licenseID } as LicenseDecision,
		])
	)
}

export async function buildSourceRegister(options: BuildSourceRegisterOptions): Promise<SourceRegisterBuildResult> {
	const fired = new Set<string>()
	const licenseByStatement = new Map(LICENSE_DECISIONS.map(([statement, licenseID]) => [statement, licenseID]))
	const scopes = new Map<string, LicenseScope>()
	const jurisdictions = await readJurisdictions(options.inventoryPath, fired)

	const { sources, discoveryRailRowsDropped } = await readSources(
		options.sourcesPath,
		licenseByStatement,
		fired,
		scopes
	)

	for (const [from] of RETIRED_NOTE_REWRITES) {
		if (!fired.has(from)) {
			throw new Error(`the rewrite of ${stringifyJSON(from)} never fired — the upstream text has moved on`)
		}
	}

	const used = new Set(sources.map((source) => source.license))
	const noteByStatement = new Map(LICENSE_DECISIONS.map(([statement, , note]) => [statement, note]))

	const generated: LicenseDecision[] = [...scopes.values()]
		.filter((scope) => used.has(scope.licenseID))
		.map((scope): UncheckedLicense => {
			const label = noteByStatement.get(scope.statement) ?? ""

			const scopedNote = scope.publisher
				? `${label} Scoped to ${scope.publisher} in ${scope.iso2}, so electing it grants that publisher's sources in that jurisdiction alone.`
				: `${label} The research pass recorded no publisher, so this decision is scoped to ${scope.scopedTo} alone.`

			return {
				licenseID: scope.licenseID,
				state: LicenseReviewState.Unchecked,
				publisherStatement: scope.statement,
				note: scopedNote,
			}
		})
		.toSorted((left, right) => left.licenseID.localeCompare(right.licenseID))

	const licenses = applyLicenseDecisions(generated, await readLicenseDecisions(options.decisionsPath))

	const register: AddressSourceRegister = {
		registerID: "address-source-register",
		version: options.version,
		// Filled below, once every other field is in place, because the digest covers the rest
		// of the register and cannot be computed while the object is still being assembled.
		contentDigest: "",
		provenance: {
			source: "mailwoman-research",
			sourceVersion: options.sourceVersion,
			authoredAt: options.authoredAt,
			notes:
				"Derived from a research pass over all 249 ISO 3166-1 codes plus the operational code XK. " +
				"The eight global discovery lookups the pass repeated once per jurisdiction are the package " +
				"README's procedure, not rows here.",
		},
		unresolved: UNRESOLVED_FIELDS.filter((field) => !sources.some((source) => source[field] !== undefined)),
		licenses,
		jurisdictions,
		sources,
	}

	register.contentDigest = registerContentDigest(register)

	const problems = auditAddressSourceRegister(register)

	if (problems.length) {
		throw new Error(`the derived register fails its own audit:\n  ${problems.join("\n  ")}`)
	}

	await writeLocalFile(prettyJSON(register), options.outPath)

	return {
		outPath: options.outPath.toString(),
		jurisdictions: jurisdictions.length,
		sources: sources.length,
		licenses: licenses.length,
		discoveryRailRowsDropped,
		researchStates: countBy(jurisdictions, (record) => record.researchState),
		statuses: countBy(sources, (record) => record.status),
	}
}

function countBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Readonly<Record<K, number>> {
	const counts = {} as Record<K, number>

	for (const row of rows) {
		counts[key(row)] = (counts[key(row)] ?? 0) + 1
	}

	return counts
}
