/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Derive the committed address-source register from a research pass's two CSVs.
 *
 *   The register is a build output of the research documents, and this module is the only thing that writes it, so
 *   re-running the research means re-running this rather than editing 639 rows by hand. See
 *   `mailwoman corpus source-register` for the invocation and `packages/corpus/data/PROVENANCE.md` for the command
 *   that produced the committed copy.
 *
 *   Two inputs, and the second one is mostly not input. The functional-authority CSV carries eight global discovery
 *   lookups repeated once per jurisdiction — a GLEIF index probe, a health-facility-list probe, and six more — which is
 *   2,000 of its 2,389 rows and collapses to eight distinct row bodies. Those name a lookup to perform, never a
 *   national source, so they are dropped here and written once as prose in the package README. The remainder is the
 *   register.
 *
 *   The audit runs before the write. A register that fails it is never committed, which is the point of having one.
 */

import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import {
	auditAddressSourceRegister,
	BackboneState,
	JurisdictionResearchState,
	LicenseReviewState,
	ResearchPass,
	SourceGeometry,
	SourceStatus,
	UNRESOLVED_FIELDS,
	type AddressSourceRecord,
	type AddressSourceRegister,
	type JurisdictionRecord,
	type LicenseDecision,
	type RegisterSector,
	type UncheckedLicense,
} from "#source-register/index"

/**
 * The `origin` value the research pass gives its eight repeated discovery lookups. Every row carrying it is dropped.
 */
const DISCOVERY_RAIL_ORIGIN = "global_research_rail"

/**
 * Joins the two parts of the per-sector counter's key.
 *
 * A NUL would be the collision-free choice and is the wrong one here: `oxfmt` normalizes a unicode escape for it into
 * the byte itself, so the escape does not survive a format pass. A raw NUL in source is what `repo-health`'s
 * `rawNULBytes` counter exists to keep out, because a sweep that would read the line cannot see it. A solidus is safe
 * instead of merely convenient — an ISO 3166-1 code is two letters and a sector is kebab-case, so neither part can
 * contain one.
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
 * The research pass writes a source's propositions as one string. Closed, because a spelling this does not carry is a
 * vocabulary the register has not agreed to rather than a row to guess at.
 */
const ASSERTS_BY_ROLE: Readonly<Record<string, readonly AddressSourceRecord["asserts"][number][]>> = {
	"IDENTITY + OBSERVATION": ["identity", "observation"],
	OBSERVATION: ["observation"],
}

/**
 * One license decision per distinct access label the research pass recorded, keyed by the label.
 *
 * Every one is `unchecked`, and that is a finding rather than a placeholder: the pass recorded what a register costs to
 * reach and never opened anybody's terms. `Free` is the clearest case — it says the download is free of charge and
 * licenses nothing, so treating it as permissive would admit a source on a sentence about price.
 *
 * The labels are the pass's own, carried through {@link rewriteRetiredVocabulary} so a word this repository has retired
 * does not enter a committed artifact through quoted data.
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
 * Each rewrite must fire at least once, so a pair left behind after the upstream text changes fails the build instead
 * of sitting here being wrong.
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
 * Words this repository has removed from its vocabulary, and the plain synonym each takes wherever the research pass
 * used one.
 *
 * The substitution runs over every string this build emits, because `repo-health`'s `bannedVocabulary` counter reads
 * every tracked text file and a committed JSON artifact is one. Quoting somebody else's prose is not an exemption: the
 * word is removed because it stands for several different things here, and it reads no better inside a quotation.
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
	 * The functional-authority CSV, discovery lookups included. This build drops them.
	 */
	sourcesPath: PathBuilderLike
	outPath: PathBuilderLike
	version: string
	/**
	 * ISO 8601 calendar date the research pass was taken, `YYYY-MM-DD`.
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

async function readSources(
	sourcesPath: PathBuilderLike,
	licenseByStatement: ReadonlyMap<string, string>,
	fired: Set<string>
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
		const licenseID = licenseByStatement.get(statement)

		if (!licenseID) {
			throw new Error(`row ${row}: license ${stringifyJSON(statement)} has no decision record in this build`)
		}

		const source: AddressSourceRecord = {
			sourceID: `${iso2.toLowerCase()}-${sector}-${ordinal}`,
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
		const publisher = (record["owner"] ?? "").trim()
		const sourceURL = (record["source_url"] ?? "").trim()
		const note = (record["notes"] ?? "").trim()

		if (access) {
			source.access = rewriteRetiredVocabulary(access)
		}

		if (publisher) {
			source.publisher = rewriteRetiredVocabulary(publisher)
		}

		if (sourceURL) {
			source.sourceURL = sourceURL
		}

		if (note) {
			source.note = rewriteNote(note, fired)
		}

		records.push(source)
	}

	return { sources: records, discoveryRailRowsDropped }
}

/**
 * Build the register and write it, refusing to write one that fails the audit.
 *
 * The output is tab-indented JSON, which `oxfmt` reformats a little further. Run `yarn format` over the result, as the
 * sub-venue lexicon's build does.
 *
 * @throws When an input row carries a vocabulary this build has no mapping for, when a declared rewrite never fires, or
 *   when the finished register fails {@linkcode auditAddressSourceRegister}.
 */
export async function buildSourceRegister(options: BuildSourceRegisterOptions): Promise<SourceRegisterBuildResult> {
	const fired = new Set<string>()
	const licenseByStatement = new Map(LICENSE_DECISIONS.map(([statement, licenseID]) => [statement, licenseID]))
	const jurisdictions = await readJurisdictions(options.inventoryPath, fired)
	const { sources, discoveryRailRowsDropped } = await readSources(options.sourcesPath, licenseByStatement, fired)

	for (const [from] of RETIRED_NOTE_REWRITES) {
		if (!fired.has(from)) {
			throw new Error(`the rewrite of ${stringifyJSON(from)} never fired — the upstream text has moved on`)
		}
	}

	const used = new Set(sources.map((source) => source.license))

	const licenses: LicenseDecision[] = LICENSE_DECISIONS.filter(([, licenseID]) => used.has(licenseID))
		.map(([statement, licenseID, note]): UncheckedLicense => {
			return { licenseID, state: LicenseReviewState.Unchecked, publisherStatement: statement, note }
		})
		.toSorted((left, right) => left.licenseID.localeCompare(right.licenseID))

	const register: AddressSourceRegister = {
		registerID: "address-source-register",
		version: options.version,
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

	const problems = auditAddressSourceRegister(register)

	if (problems.length) {
		throw new Error(`the derived register fails its own audit:\n  ${problems.join("\n  ")}`)
	}

	await writeLocalFile(prettyJSON(register), options.outPath)

	return {
		outPath: String(options.outPath),
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
