/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Joins a corpus source id to the register sources whose data its rows are built from.
 *
 *   A corpus source id is the `source` value stored on every corpus row, keyed by a training config's
 *   `source_weights` and listed in a training manifest. The register scopes a source to one publisher in one
 *   jurisdiction and records its license decision. This table is the one record joining the two. Before it, a source whose
 *   register row was refused or never read could feed a corpus build and a training run: HM Land Registry Price Paid
 *   Data reached `rendered-gb` and `spliced-sub-venue` while its row read `unchecked` (#2635).
 *
 *   The table is `packages/corpus/data/corpus-source-inputs.json`. A derived or synthetic source lists every input
 *   whose data reaches one of its rows. An input with no register row gets one in `source-additions.json`, under an
 *   `unchecked` decision, so the gap reads as a gap rather than as an absence.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	LicenseReviewState,
	OperationPermission,
	permissionFor,
	type LicenseDecision,
} from "@mailwoman/core/license/decision"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { readAddressSourceRegister } from "#source-register/register"
import { SourceOperation, type AddressSourceRecord, type AddressSourceRegister } from "#source-register/types"

/**
 * The operations a register decision must permit before a source's rows may
 * be built into a corpus or trained on.
 *
 * Both need adaptation: normalizing an address into labeled components is a derived work,
 * and fitting a model on it is another.
 */
export const TRAINING_OPERATIONS: readonly SourceOperation[] = [SourceOperation.Transform, SourceOperation.Train]

/**
 * One register source whose data reaches a corpus source's rows.
 */
export interface CorpusSourceInput {
	/**
	 * The register's `sourceID`.
	 */
	registerSource: string
	/**
	 * The `licenseID` that register source points at, repeated so a reviewer reads the decision key here.
	 *
	 * {@linkcode auditCorpusSourceInputs} refuses a value that disagrees with the register.
	 */
	license: string
	/**
	 * What the corpus source reads from it: the file, the fields and the component they fill.
	 */
	reads: string
}

/**
 * Everything one corpus source's rows are built from.
 */
export interface CorpusSourceMapping {
	/**
	 * Other spellings rows of this source are stored under, such as the retired `synth-*` spelling.
	 */
	aliases?: readonly string[]
	/**
	 * Every register source whose data reaches a row.
	 */
	inputs: readonly CorpusSourceInput[]
	/**
	 * Inputs written in this repository, which need no register row: a hand-written word list, a template.
	 */
	authored?: readonly string[]
	note?: string
	/**
	 * What the source read in corpora built before its producer changed inputs under the same id.
	 *
	 * `inputs` describes what a build reads today.
	 * The build and training checks read it.
	 *
	 * A corpus already built keeps the rows it was built from, so the release audit reads the
	 * entry naming that corpus: `spliced-sub-venue` kept its name when its GB skeletons moved from
	 * Price Paid Data to OS OpenData, and the published model trained on the Price Paid Data rows.
	 */
	history?: readonly CorpusSourceHistory[]
}

/**
 * The inputs one source read in the corpora named.
 */
export interface CorpusSourceHistory {
	corpora: readonly string[]
	inputs: readonly CorpusSourceInput[]
	because: string
}

/**
 * The committed table.
 */
export interface CorpusSourceInputsFile {
	sources: Readonly<Record<string, CorpusSourceMapping>>
}

/**
 * The table indexed for lookup under every spelling it records.
 */
export interface CorpusSourceInputs {
	readonly file: CorpusSourceInputsFile
	/**
	 * The mapping a spelling resolves to, with the id it is filed under.
	 */
	resolve(source: string): { id: string; mapping: CorpusSourceMapping } | null
}

/**
 * Resolves the committed table through the package's `./data/*` export.
 */
export function corpusSourceInputsPath(): string {
	return resolveModulePath("@mailwoman/corpus/data/corpus-source-inputs.json")
}

/**
 * Indexes a table by id and alias.
 *
 * @throws When two entries claim one spelling, because a lookup would then answer for whichever came last.
 */
export function indexCorpusSourceInputs(file: CorpusSourceInputsFile): CorpusSourceInputs {
	const bySpelling = new Map<string, string>()

	for (const [id, mapping] of Object.entries(file.sources)) {
		for (const spelling of [id, ...(mapping.aliases ?? [])]) {
			const claimed = bySpelling.get(spelling)

			if (claimed && claimed !== id) {
				throw new Error(`corpus source spelling ${stringifyJSON(spelling)} is claimed by both ${claimed} and ${id}`)
			}

			bySpelling.set(spelling, id)
		}
	}

	return {
		file,
		resolve(source) {
			const id = bySpelling.get(source)

			return id ? { id, mapping: file.sources[id]! } : null
		},
	}
}

/**
 * One message per structural problem in the table, read against the register.
 */
export function auditCorpusSourceInputs(file: CorpusSourceInputsFile, register: AddressSourceRegister): string[] {
	const problems: string[] = []
	const sources = new Map(register.sources.map((source) => [source.sourceID, source]))

	for (const [id, mapping] of Object.entries(file.sources)) {
		const named = stringifyJSON(id)

		if (!mapping.inputs.length && !mapping.authored?.length) {
			problems.push(`corpus source ${named} lists no input, so nothing records what its rows are built from`)
		}

		for (const entry of mapping.history ?? []) {
			if (!entry.corpora.length || !entry.because) {
				problems.push(`corpus source ${named} has a history entry naming no corpus or giving no reason`)
			}
		}

		for (const input of [...mapping.inputs, ...(mapping.history ?? []).flatMap((entry) => entry.inputs)]) {
			const row = sources.get(input.registerSource)

			if (!row) {
				problems.push(
					`corpus source ${named} reads register source ${stringifyJSON(input.registerSource)}, which the register ` +
						"does not carry. Add the row to `source-additions.json` and regenerate the register."
				)

				continue
			}

			if (row.license !== input.license) {
				problems.push(
					`corpus source ${named} records license ${stringifyJSON(input.license)} for ${input.registerSource}, ` +
						`and the register points that source at ${stringifyJSON(row.license)}`
				)
			}

			if (!input.reads) {
				problems.push(`corpus source ${named} reads ${input.registerSource} and does not say what it reads`)
			}
		}
	}

	return problems
}

/**
 * Reads the committed table and checks it against the register.
 *
 * @throws When the file does not parse or the audit reports a problem.
 */
export async function readCorpusSourceInputs(
	register: AddressSourceRegister,
	path?: PathBuilderLike
): Promise<CorpusSourceInputs> {
	const resolved = path ?? corpusSourceInputsPath()
	const file = await readLocalJSONFile<CorpusSourceInputsFile>(resolved)
	const problems = auditCorpusSourceInputs(file, register)

	if (problems.length) {
		throw new Error(`${resolved} failed its audit against the register:\n  ${problems.join("\n  ")}`)
	}

	return indexCorpusSourceInputs(file)
}

/**
 * Why one corpus source lacks the permission {@linkcode TRAINING_OPERATIONS} need.
 */
export interface SourceRightsGap {
	/**
	 * The corpus source id as the caller named it.
	 */
	source: string
	/**
	 * The register source lacking the permission, or `null` when the table has no entry for the corpus source.
	 */
	registerSource: string | null
	licenseID: string | null
	/**
	 * The decision's review state, or `null` when there is no decision to read.
	 */
	state: LicenseDecision["state"] | null
	/**
	 * The operations the decision does not permit.
	 */
	missing: SourceOperation[]
	because: string
}

/**
 * Every reason a corpus source's rows may not be built into a corpus or trained on.
 *
 * An empty array is the only answer a caller may read as permission.
 * A source the table does not map answers one gap whose `registerSource` is `null`,
 * because an unmapped source is one nobody has traced to its publishers.
 *
 * `corpusVersion` names a corpus already built, so a source whose inputs changed under
 * the same id is read against what that corpus's rows were built from.
 * A build or training check omits it and reads today's inputs.
 */
export function sourceRightsGaps(
	source: string,
	inputs: CorpusSourceInputs,
	register: AddressSourceRegister,
	corpusVersion?: string
): SourceRightsGap[] {
	const resolved = inputs.resolve(source)

	if (!resolved) {
		return [
			{
				source,
				registerSource: null,
				licenseID: null,
				state: null,
				missing: [...TRAINING_OPERATIONS],
				because:
					"no entry in packages/corpus/data/corpus-source-inputs.json says which register sources its rows are " +
					"built from",
			},
		]
	}

	const decisions = new Map(register.licenses.map((decision) => [decision.licenseID, decision]))
	const rows = new Map(register.sources.map((row) => [row.sourceID, row]))
	const gaps: SourceRightsGap[] = []

	const former = corpusVersion ? resolved.mapping.history?.find((entry) => entry.corpora.includes(corpusVersion)) : null

	for (const input of former?.inputs ?? resolved.mapping.inputs) {
		const row = rows.get(input.registerSource)
		const decision = row ? decisions.get(row.license) : null

		if (!row || !decision) {
			gaps.push({
				source,
				registerSource: input.registerSource,
				licenseID: row?.license ?? null,
				state: null,
				missing: [...TRAINING_OPERATIONS],
				because: row
					? `the register declares no decision ${stringifyJSON(row.license)}`
					: "the register has no such row",
			})

			continue
		}

		const readings = TRAINING_OPERATIONS.map((operation) => ({
			operation,
			reading: permissionFor(decision, operation),
		}))

		const missing = readings.filter(({ reading }) => reading.permission !== OperationPermission.Permitted)

		if (!missing.length) continue

		gaps.push({
			source,
			registerSource: row.sourceID,
			licenseID: decision.licenseID,
			state: decision.state,
			missing: missing.map(({ operation }) => operation),
			because:
				decision.state === LicenseReviewState.Refused
					? `the decision is refused: ${decision.refusedBecause}`
					: missing[0]!.reading.because,
		})
	}

	return gaps
}

/**
 * The register fields a permission check reads: each row's license and each license's decision.
 */
export interface RegisterDecisions {
	sources: ReadonlyArray<Pick<AddressSourceRecord, "sourceID" | "license">>
	licenses: readonly LicenseDecision<SourceOperation>[]
}

/**
 * Whether one register row holds a decision that permits every operation in {@linkcode TRAINING_OPERATIONS}.
 *
 * A row the register lacks, or whose license has no decision, does not.
 */
export function registerSourcePermitsTraining(register: RegisterDecisions, registerSource: string): boolean {
	const row = register.sources.find((entry) => entry.sourceID === registerSource)
	const decision = row ? register.licenses.find((entry) => entry.licenseID === row.license) : undefined

	if (!decision) return false

	return TRAINING_OPERATIONS.every(
		(operation) => permissionFor(decision, operation).permission === OperationPermission.Permitted
	)
}

/**
 * One line naming the corpus source, the register row and the missing permission.
 */
export function describeSourceRightsGap(gap: SourceRightsGap): string {
	const missing = gap.missing.join(" and ")

	if (!gap.registerSource) {
		return `corpus source ${gap.source} is unmapped and so lacks a permission for ${missing}: ${gap.because}`
	}

	return (
		`corpus source ${gap.source} reads register source ${gap.registerSource} ` +
		`(license ${gap.licenseID ?? "none"}, ${gap.state ?? "no decision"}), which does not permit ${missing}: ${gap.because}`
	)
}

/**
 * Raised when a build or training run would admit a source lacking the permission.
 */
export class SourceRightsError extends Error {
	readonly gaps: readonly SourceRightsGap[]

	/**
	 * @param overrideHint Follows the flag in the message, naming where else the caller
	 * sets the override, as a training config's `data.unshippable_reason`.
	 */
	constructor(context: string, gaps: readonly SourceRightsGap[], overrideHint?: string) {
		super(
			`${context} refuses ${new Set(gaps.map((gap) => gap.source)).size} corpus source(s) whose register rows ` +
				`lack an elected decision permitting ${TRAINING_OPERATIONS.join(" and ")}:\n  ` +
				gaps.map(describeSourceRightsGap).join("\n  ") +
				"\nRecord the decision in packages/corpus/data/license-decisions.json, map the source in " +
				`packages/corpus/data/corpus-source-inputs.json, or pass --unshippable-reason <why>${overrideHint ? ` (${overrideHint})` : ""} for a local ` +
				"experiment, which marks the output as not shippable."
		)

		this.name = "SourceRightsError"
		this.gaps = gaps
	}
}

/**
 * What a checked output records about the sources it admitted.
 *
 * Its field names are snake_case because it is written into corpus manifests,
 * which a Python reader also reads.
 */
export interface SourceRightsRecord {
	/**
	 * False when an override admitted a source lacking the permission.
	 */
	shippable: boolean
	unshippable_reason: string | null
	/**
	 * Every corpus source the check read, sorted.
	 */
	sources_checked: string[]
	gaps: SourceRightsGap[]
	/**
	 * Inputs whose corpus sources could not be read, so the check could not judge them,
	 * such as a base corpus whose files name no source and whose manifest carries no record.
	 */
	unverified: string[]
}

/**
 * Checks corpus sources one at a time as an output admits them.
 */
export interface SourceRightsAdmission {
	/**
	 * Admits a source or throws {@linkcode SourceRightsError}.
	 *
	 * Under an override it logs each gap once and returns them instead.
	 */
	admit(source: string): readonly SourceRightsGap[]
	/**
	 * Admits several sources at once, so a refusal names every one of them.
	 */
	admitAll(sources: Iterable<string>): readonly SourceRightsGap[]
	/**
	 * Refuses an input whose sources cannot be read, or records it under an override.
	 *
	 * An input the check cannot read stays unverified rather than clear.
	 */
	admitUnverified(description: string): void
	record(): SourceRightsRecord
}

/**
 * Options for {@linkcode createSourceRightsAdmission}.
 */
export interface SourceRightsAdmissionOptions {
	/**
	 * Names the output in a refusal, as `corpus build v0.7.7` or `recipe sub-venue`.
	 */
	context: string
	/**
	 * Why a local experiment admits sources lacking the permission.
	 *
	 * Setting it marks the output unshippable rather than relaxing the rule.
	 */
	unshippableReason?: string | null
	/**
	 * The built corpus the output reads, so a source whose inputs changed under the same id is
	 * judged by the inputs that built that corpus, as {@linkcode sourceRightsGaps} reads it.
	 *
	 * A build omits it and is judged by today's inputs.
	 */
	corpusVersion?: string
	/**
	 * Names where else the caller sets the override, in the refusal's message.
	 */
	overrideHint?: string
	log?: (line: string) => void
}

/**
 * Builds the admission check over an already-read register and table.
 *
 * @throws When `unshippableReason` is set and blank, because an override must say why.
 */
export function createSourceRightsAdmission(
	register: AddressSourceRegister,
	inputs: CorpusSourceInputs,
	options: SourceRightsAdmissionOptions
): SourceRightsAdmission {
	const reason = options.unshippableReason ?? null

	if (reason !== null && !reason.trim()) {
		throw new Error(`${options.context}: --unshippable-reason must say why the output is not shippable`)
	}

	const log = options.log ?? ((line: string) => console.error(line))
	const checked = new Map<string, readonly SourceRightsGap[]>()

	const admitAll = (sources: Iterable<string>): readonly SourceRightsGap[] => {
		const fresh: SourceRightsGap[] = []
		const all: SourceRightsGap[] = []

		for (const source of sources) {
			const known = checked.get(source)

			if (known) {
				all.push(...known)

				continue
			}

			const gaps = sourceRightsGaps(source, inputs, register, options.corpusVersion)

			fresh.push(...gaps)
			all.push(...gaps)

			if (!gaps.length || reason !== null) {
				checked.set(source, gaps)
			}
		}

		if (!fresh.length) return all

		if (reason === null) throw new SourceRightsError(options.context, fresh, options.overrideHint)

		for (const gap of fresh) {
			log(`UNSHIPPABLE ${options.context}: ${describeSourceRightsGap(gap)} (override: ${reason})`)
		}

		return all
	}

	const unverified: string[] = []

	return {
		admit: (source) => admitAll([source]),
		admitAll,
		admitUnverified: (description) => {
			if (reason === null) {
				throw new Error(
					`${options.context} cannot check the corpus sources of ${description}, and an input it cannot read is ` +
						"not one it found clear. Pass --unshippable-reason <why> for a local experiment, which marks the " +
						"output as not shippable."
				)
			}

			log(`UNSHIPPABLE ${options.context}: the corpus sources of ${description} were not checked (override: ${reason})`)
			unverified.push(description)
		},
		record: () => {
			const gaps = [...checked.values()].flat()
			const shippable = gaps.length === 0 && unverified.length === 0

			return {
				shippable,
				unshippable_reason: shippable ? null : reason,
				sources_checked: [...checked.keys()].toSorted(),
				gaps,
				unverified: [...unverified],
			}
		},
	}
}

/**
 * The file name of the record a corpus builder writes beside its output.
 */
export const SOURCE_RIGHTS_FILE_NAME = "SOURCE_RIGHTS.json"

/**
 * Writes `record` beside an output as {@linkcode SOURCE_RIGHTS_FILE_NAME},
 * two-space indented with a trailing newline, the bytes the Python builders'
 * `write_rights_record` wrote for a record with no gaps.
 *
 * @returns The path written.
 */
export async function writeSourceRightsRecord(record: SourceRightsRecord, outDir: PathBuilderLike): Promise<string> {
	const path = resolvePath(outDir, SOURCE_RIGHTS_FILE_NAME)

	await writeLocalTextFile(pythonJSONDumps(record, { indent: 2, ensureASCII: false }) + "\n", path)

	return path
}

/**
 * Reads the committed register and table and builds the admission check over them.
 */
export async function openSourceRightsAdmission(options: SourceRightsAdmissionOptions): Promise<SourceRightsAdmission> {
	const register = await readAddressSourceRegister()
	const inputs = await readCorpusSourceInputs(register)

	return createSourceRightsAdmission(register, inputs, options)
}
