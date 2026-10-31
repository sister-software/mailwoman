/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_fanout`: runs one input set through several mailwoman arms and reports each row's stability.
 *
 *   `mwdev_compare` grades two arms against each other. A model comparison has a prior question: does the row
 *   read the same way across every staged candidate, or is it in the flip set? This module answers it with one
 *   line per row, every arm's reading side by side and a stability kind, so a regression claim about a row starts
 *   from whether the row is stable at all.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { type GauntletResult, toGauntletResult } from "mailwoman/tools/eval-harness/gauntlet/harness"
import { basename, type PathBuilderLike, resolvePath } from "path-ts"

import { type ExpectationReading, gradeGauntletResult } from "#dev-mcp/diagnose/expectation"
import type { Engine, EngineConfig, EngineRegistryLike } from "#dev-mcp/engine/registry"
import { type InputSetRef, type ResolvedInput, resolveInputSet } from "#dev-mcp/input-sets"
import { buildRoutedMailwomanArm } from "#dev-mcp/routed-mailwoman-arm"
import { inputSetProvenance, type Provenance } from "#dev-mcp/tool-kit"

/**
 * The most arms one call may fan out to.
 *
 * Each arm is one geocode per row, so eight arms over the full board is about ten thousand geocodes.
 */
export const FANOUT_MAX_ARMS = 8

/**
 * The most flip-set row ids the summary lists before counting the rest.
 */
const FLIP_ID_CAP = 50

/**
 * One mailwoman arm of a fan-out: a label and the configuration that builds it.
 */
export interface FanoutArmSpec {
	label: string
	config: EngineConfig
}

type FanoutExecutionPath = "board-routed" | "single-config"

/**
 * One arm's answer for one row.
 */
export interface FanoutArmReading {
	label: string
	components: Record<string, string>
	lat: number | null
	lon: number | null
	tier: string | null
	grade: ExpectationReading
	/**
	 * The arm's error message when its geocode threw.
	 * Every other field is then empty.
	 */
	error: string | null
}

/**
 * The stability kinds a row can take, in the order the summary counts them.
 *
 * `flip` leads because the flip set is the artifact a reader came for.
 */
const STABILITY_KINDS = ["flip", "stable_pass", "stable_fail", "ungraded"] as const

type StabilityKind = (typeof STABILITY_KINDS)[number]

/**
 * Each stability kind beside its predicate, so a kind travels with its definition.
 */
const STABILITY_PREDICATES: Record<StabilityKind, string> = {
	flip:
		"At least one arm passed the row's own expectation and at least one failed it — the row is in the flip set, " +
		"and a regression claim about it is a claim about which arm it lands on.",
	stable_pass:
		"Every arm that answered passed the row's expectation. Decodes may still differ; `decode_groups` says whether " +
		"they do.",
	stable_fail:
		"Every arm that answered failed the row's expectation. The arms agree the row is lost; `decode_groups` says " +
		"whether they lose it the same way.",
	ungraded:
		"The row states no expectation, so stability is read from the decodes alone: `stable_decode` and " +
		"`coordinate_spread_km`.",
}

/**
 * How one arm's reading of one row grades.
 */
type GradeMark = "pass" | "fail" | "ungraded" | "error"

/**
 * How one row's readings agree across the arms.
 */
export interface StabilityReading {
	/**
	 * Distinct component maps among the arms that answered.
	 */
	decode_groups: number
	/**
	 * The share of answering arms whose decode is the most common one, or `null` when no arm answered.
	 */
	modal_share: number | null
	/**
	 * Every arm answered and every decode is the same.
	 */
	stable_decode: boolean
	/**
	 * The greatest distance between two arms' coordinates, or `null` when fewer than two arms resolved one.
	 */
	coordinate_spread_km: number | null
	grade_pattern: GradeMark[]
	kind: StabilityKind
}

export interface FanoutRow {
	id: string
	input: string
	country: string | null
	arms: FanoutArmReading[]
	stability: StabilityReading
	rendered: string
}

interface ArmTally {
	label: string
	graded: number
	passed: number
	errored: number
}

export interface FanoutReport {
	provenance: {
		tree_fingerprint: string
		git_head: string
		dirty: boolean
		dirty_files: string[]
		execution_path: FanoutExecutionPath
		arms: Array<{ label: string; config: EngineConfig; provenance: unknown }>
	}
	input_set: Provenance["input_set"]
	stability_predicates: Record<StabilityKind, string>
	summary: string
	warnings: string[]
	n_arms: number
	n_requested: number
	n_evaluated: number
	n_errored_readings: number
	by_arm: ArmTally[]
	by_kind: Record<StabilityKind, number>
	n_decode_unstable: number
	flip_set: { n: number; row_ids: string[]; row_ids_omitted: number }
	rows: FanoutRow[]
	rows_omitted: number
	elapsed_ms: number
}

/**
 * What a fan-out may inject: the routed arm builder and the filesystem the candidate expansion reads.
 */
export interface FanoutDeps {
	buildRoutedMailwomanArm?: typeof buildRoutedMailwomanArm
	dataRoot?: PathBuilderLike
	pathExists?: (path: string) => Promise<boolean>
}

// #region Arm specs

/**
 * The label an arm is reported under when the caller gave none.
 *
 * A weights root is labeled by its basename, an empty configuration is the production arm,
 * and any other configuration is numbered by position.
 */
export function armLabelFor(spec: { label?: string | undefined; config: EngineConfig }, index: number): string {
	if (spec.label) return spec.label

	if (spec.config.weights_cache) return basename(spec.config.weights_cache)

	return Object.keys(spec.config).length ? `arm-${index + 1}` : "production"
}

/**
 * Makes every label distinct by numbering repeats, so two arms never share a column.
 */
export function uniqueLabels(specs: readonly FanoutArmSpec[]): FanoutArmSpec[] {
	const seen = new Map<string, number>()

	return specs.map((spec) => {
		const count = (seen.get(spec.label) ?? 0) + 1

		seen.set(spec.label, count)

		return count === 1 ? spec : { ...spec, label: `${spec.label}#${count}` }
	})
}

/**
 * Expands staged candidate names to `weights_cache` arms under `<data root>/candidates/`.
 *
 * A name that resolves to no directory is refused by its full path, so a typo reads as
 * a refusal rather than as an arm that answered from the shipped weights.
 */
export async function expandCandidateArms(
	names: readonly string[],
	dataRoot: PathBuilderLike = dataRootPath(),
	exists: (path: string) => Promise<boolean> = pathExists
): Promise<FanoutArmSpec[]> {
	const candidatesRoot = resolvePath(dataRoot.toString(), "candidates").toString()
	const arms: FanoutArmSpec[] = []

	for (const name of names) {
		const root = resolvePath(candidatesRoot, name).toString()

		if (!(await exists(root))) {
			throw new Error(
				`mwdev_fanout: candidate ${stringifyJSON(name)} has no root at ${root}. ` +
					`Staged roots are the directories under ${candidatesRoot}.`
			)
		}

		arms.push({ label: name, config: { weights_cache: root } })
	}

	return arms
}

// #endregion

// #region Stability

function decodeKey(components: Readonly<Record<string, string>>): string {
	return stringifyJSON(Object.entries(components).toSorted(([a], [b]) => a.localeCompare(b)))
}

function gradeMark(arm: FanoutArmReading): GradeMark {
	if (arm.error !== null) return "error"

	if (arm.grade.met === null) return "ungraded"

	return arm.grade.met ? "pass" : "fail"
}

function located(arm: FanoutArmReading): arm is FanoutArmReading & { lat: number; lon: number } {
	return typeof arm.lat === "number" && typeof arm.lon === "number"
}

/**
 * The greatest pairwise distance among the arms that resolved a coordinate.
 */
function coordinateSpreadKm(arms: readonly FanoutArmReading[]): number | null {
	const points = arms.filter(located)

	if (points.length < 2) return null

	let spread = 0

	for (const [index, point] of points.entries()) {
		for (const other of points.slice(index + 1)) {
			spread = Math.max(spread, haversine(point.lat, point.lon, other.lat, other.lon))
		}
	}

	return spread
}

/**
 * Reads how one row's readings agree across the arms.
 *
 * Only graded marks determine the kind.
 * An arm that errored or an ungraded row contributes no mark to the kind, and an errored
 * arm makes `stable_decode` false because its decode is unknown rather than equal.
 */
export function readStability(arms: readonly FanoutArmReading[]): StabilityReading {
	const answered = arms.filter((arm) => arm.error === null)
	const groups = new Map<string, number>()

	for (const arm of answered) {
		const key = decodeKey(arm.components)

		groups.set(key, (groups.get(key) ?? 0) + 1)
	}

	const modal = Math.max(0, ...groups.values())
	const pattern = arms.map(gradeMark)
	const graded = pattern.filter((mark) => mark === "pass" || mark === "fail")

	const kind: StabilityKind = !graded.length
		? "ungraded"
		: graded.every((mark) => mark === "pass")
			? "stable_pass"
			: graded.every((mark) => mark === "fail")
				? "stable_fail"
				: "flip"

	return {
		decode_groups: groups.size,
		modal_share: answered.length ? modal / answered.length : null,
		stable_decode: answered.length === arms.length && groups.size === 1,
		coordinate_spread_km: coordinateSpreadKm(arms),
		grade_pattern: pattern,
		kind,
	}
}

// #endregion

// #region Rendering

/**
 * One line per row: the stability head, then each arm's decode, tier and grade.
 *
 * The structured row is what a diff reads.
 * A human reads this line in a transcript without an agent paraphrasing it.
 */
export function renderFanoutRow(row: Omit<FanoutRow, "rendered">): string {
	const { stability } = row

	const head = [
		stability.kind,
		stability.decode_groups > 1 ? `decodes ${stability.decode_groups}` : null,
		stability.coordinate_spread_km !== null && stability.coordinate_spread_km > 0
			? `spread ${stability.coordinate_spread_km.toFixed(1)}km`
			: null,
	]
		.filter((part) => part !== null)
		.join(" ")

	const arms = row.arms.map((arm) => {
		if (arm.error !== null) return `${arm.label}: ERROR ${arm.error}`

		const decode =
			Object.entries(arm.components)
				.map(([tag, value]) => `${tag}=${value}`)
				.join(" ") || "(no components)"

		const grade = arm.grade.met === null ? "ungraded" : arm.grade.met ? "pass" : `FAIL ${arm.grade.issues.join("; ")}`

		return `${arm.label}: ${decode} → ${arm.tier ?? "no result"} ${grade}`
	})

	return [`${row.id} [${head}]`, ...arms].join(" · ")
}

// #endregion

// #region Running

interface PreparedArm extends Disposable {
	label: string
	config: EngineConfig
	/**
	 * The arm's provenance, filled in once {@link PreparedArm.open} has run.
	 */
	provenance: unknown
	/**
	 * Acquires what the arm reads with, immediately before its pass over the rows.
	 *
	 * The registry keeps a few engines resident and closes the rest, so an engine acquired for
	 * every arm up front is closed again before its rows run once the arms outnumber the residents.
	 */
	open(): Promise<void>
	geocode(item: ResolvedInput): Promise<GauntletResult>
}

/**
 * Builds one warm-session arm per spec.
 *
 * Each arm acquires its engine when its pass begins, and the first engine's tree
 * fingerprint is the one every later engine must match, so arms built against
 * different source trees are refused as they open.
 * The warnings list fills in as arms open: two arms that resolve to one engine
 * are one reading counted twice.
 */
function prepareSessionArms(
	registry: EngineRegistryLike,
	specs: readonly FanoutArmSpec[]
): { arms: PreparedArm[]; warnings: string[] } {
	const warnings: string[] = []
	const opened: Array<{ label: string; engineID: string; digest: string }> = []

	const arms = specs.map((spec): PreparedArm => {
		let engine: Engine | null = null

		return {
			label: spec.label,
			config: spec.config,
			provenance: null,
			async open() {
				engine = await registry.acquire(spec.config)

				const first = opened[0]

				if (first && first.digest !== engine.fingerprint.digest) {
					throw new Error(
						`mwdev_fanout: arms were built against different source trees (${first.digest}, ` +
							`${engine.fingerprint.digest}). That is not a fan-out. Call mwdev_restart and re-run.`
					)
				}

				const twin = opened.find((entry) => entry.engineID === engine!.engineID)

				if (twin) {
					warnings.push(
						`Arms ${twin.label} and ${spec.label} resolved to the same engine ${engine.engineID}, so their readings ` +
							"are one reading counted twice."
					)
				}

				opened.push({ label: spec.label, engineID: engine.engineID, digest: engine.fingerprint.digest })

				this.provenance = {
					engine: "mailwoman:session",
					engine_id: engine.engineID,
					config_effective: engine.effective,
					lexicons: engine.lexicons,
				}
			},
			async geocode(item) {
				if (!engine) throw new Error(`mwdev_fanout: arm ${spec.label} read a row before it was opened`)

				return toGauntletResult((await engine.session.geocode(item.input)).result)
			},
			// The registry owns the session.
			[Symbol.dispose]() {},
		}
	})

	return { arms, warnings }
}

/**
 * Builds one production-routed arm per spec over the selected rows.
 */
async function prepareRoutedArms(
	specs: readonly FanoutArmSpec[],
	selected: readonly ResolvedInput[],
	build: typeof buildRoutedMailwomanArm
): Promise<{ arms: PreparedArm[]; warnings: string[] }> {
	const arms: PreparedArm[] = []

	for (const spec of specs) {
		const arm = await build(spec.config, selected)

		arms.push({
			label: spec.label,
			config: spec.config,
			provenance: arm.provenance,
			// A routed arm holds its own sessions, so it is open from the moment it is built.
			open: async () => {},
			geocode: (item) => arm.geocode(item),
			[Symbol.dispose]: () => arm[Symbol.dispose](),
		})
	}

	return { arms, warnings: [] }
}

async function readArm(arm: PreparedArm, item: ResolvedInput): Promise<FanoutArmReading> {
	try {
		const result = await arm.geocode(item)

		return {
			label: arm.label,
			components: result.components as Record<string, string>,
			lat: result.lat,
			lon: result.lon,
			tier: (result.tier as string | null) ?? null,
			grade: gradeGauntletResult(item, result),
			error: null,
		}
	} catch (error) {
		return {
			label: arm.label,
			components: {},
			lat: null,
			lon: null,
			tier: null,
			grade: { source: "none", met: null, issues: [] },
			error: (error as Error).message,
		}
	}
}

/**
 * Parse args, build the arms, run every row through each of them, and aggregate.
 */
export async function runFanout(
	registry: EngineRegistryLike,
	args: Record<string, unknown>,
	deps: FanoutDeps = {}
): Promise<FanoutReport> {
	const ref = (args["inputs"] as InputSetRef | null) ?? { kind: "board" }
	const rawArms = (args["arms"] as Array<{ label?: string; config: EngineConfig }> | null) ?? []
	const candidateNames = (args["candidates"] as string[] | null) ?? []
	const executionPath = (args["execution_path"] as FanoutExecutionPath | null) ?? "board-routed"
	const limit = args["limit"] as number | undefined
	const rowsCap = args["rows_cap"] as number | undefined

	const candidateArms = await expandCandidateArms(
		candidateNames,
		deps.dataRoot ?? dataRootPath(),
		deps.pathExists ?? pathExists
	)

	const specs = uniqueLabels([
		...rawArms.map((arm, index) => ({ label: armLabelFor(arm, index), config: arm.config })),
		...candidateArms,
	])

	if (specs.length < 2) {
		throw new Error(
			`mwdev_fanout: a fan-out needs at least two arms; ${specs.length} given across \`arms\` and \`candidates\`.`
		)
	}

	if (specs.length > FANOUT_MAX_ARMS) {
		throw new Error(`mwdev_fanout: at most ${FANOUT_MAX_ARMS} arms; ${specs.length} given.`)
	}

	const set = await resolveInputSet(ref)
	const selected = limit ? set.inputs.slice(0, limit) : set.inputs
	const startedAt = Date.now()

	using stack = new DisposableStack()

	const { arms, warnings } =
		executionPath === "board-routed"
			? await prepareRoutedArms(specs, selected, deps.buildRoutedMailwomanArm ?? buildRoutedMailwomanArm)
			: prepareSessionArms(registry, specs)

	for (const arm of arms) {
		stack.use(arm)
	}

	// Arms outermost, each opened as its pass begins: the registry keeps a few engines resident,
	// so an arm's engine is acquired once and stays resident for every row before the next arm opens.
	const readingsByRow: FanoutArmReading[][] = selected.map(() => [])

	for (const arm of arms) {
		await arm.open()

		for (const [index, item] of selected.entries()) {
			readingsByRow[index]!.push(await readArm(arm, item))
		}
	}

	const rows: FanoutRow[] = selected.map((item, index) => {
		const readings = readingsByRow[index]!

		const row = {
			id: item.id,
			input: item.input,
			country: item.country,
			arms: readings,
			stability: readStability(readings),
		}

		return { ...row, rendered: renderFanoutRow(row) }
	})

	const byArm: ArmTally[] = arms.map((arm, index) => {
		const marks = rows.map((row) => row.stability.grade_pattern[index])

		return {
			label: arm.label,
			graded: marks.filter((mark) => mark === "pass" || mark === "fail").length,
			passed: marks.filter((mark) => mark === "pass").length,
			errored: marks.filter((mark) => mark === "error").length,
		}
	})

	const byKind = Object.fromEntries(
		STABILITY_KINDS.map((kind) => [kind, rows.filter((row) => row.stability.kind === kind).length])
	) as Record<StabilityKind, number>

	const flips = rows.filter((row) => row.stability.kind === "flip")
	const decodeUnstable = rows.filter((row) => !row.stability.stable_decode).length
	const erroredReadings = rows.reduce((sum, row) => sum + row.arms.filter((arm) => arm.error !== null).length, 0)
	const fingerprint = await registry.fingerprint()
	const emitted = [...flips, ...rows.filter((row) => row.stability.kind !== "flip")]
	const labels = arms.map((arm) => arm.label).join(", ")

	const summary = [
		`Fanned ${rows.length} row(s) across ${arms.length} arms (${labels}) on the ${executionPath} path.`,
		`Flip set: ${flips.length} row(s)` +
			(flips.length
				? ` — ${flips
						.slice(0, FLIP_ID_CAP)
						.map((row) => row.id)
						.join(", ")}${flips.length > FLIP_ID_CAP ? ` and ${flips.length - FLIP_ID_CAP} more` : ""}.`
				: "."),
		`Stable pass ${byKind.stable_pass}, stable fail ${byKind.stable_fail}, ungraded ${byKind.ungraded}; ` +
			`${decodeUnstable} row(s) decode differently across the arms.`,
		`Passes over graded rows per arm: ${byArm.map((arm) => `${arm.label} ${arm.passed}/${arm.graded}`).join(", ")}.`,
		erroredReadings ? `${erroredReadings} reading(s) errored and count in no grade.` : "",
		...warnings,
	]
		.filter((sentence) => sentence.length)
		.join(" ")

	return {
		provenance: {
			tree_fingerprint: fingerprint.digest,
			git_head: fingerprint.gitHead,
			dirty: fingerprint.dirtyFiles.length > 0,
			dirty_files: fingerprint.dirtyFiles,
			execution_path: executionPath,
			arms: arms.map((arm) => ({ label: arm.label, config: arm.config, provenance: arm.provenance })),
		},
		input_set: inputSetProvenance(set),
		stability_predicates: STABILITY_PREDICATES,
		summary,
		warnings,
		n_arms: arms.length,
		n_requested: selected.length,
		n_evaluated: rows.length,
		n_errored_readings: erroredReadings,
		by_arm: byArm,
		by_kind: byKind,
		n_decode_unstable: decodeUnstable,
		flip_set: {
			n: flips.length,
			row_ids: flips.slice(0, FLIP_ID_CAP).map((row) => row.id),
			row_ids_omitted: Math.max(0, flips.length - FLIP_ID_CAP),
		},
		rows: rowsCap ? emitted.slice(0, rowsCap) : emitted,
		rows_omitted: rowsCap ? Math.max(0, emitted.length - rowsCap) : 0,
		elapsed_ms: Date.now() - startedAt,
	}
}

// #endregion
