/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a comparison's two sides may be.
 *
 *   Spec §6.1 gives `ArmSpec` four members and all four are built: a mailwoman configuration, an external endpoint, a
 *   metered reference geocoder, and a stored past run.
 *
 *   Every kind gets its own schema branch, and that is the load-bearing detail in this file. A bare {@link EngineConfig}
 *   stays legal as shorthand so the older two-mailwoman-arms call keeps working, and a zod object STRIPS unknown keys —
 *   so without an explicit branch, `{kind:"oracle", provider:"google"}` parses cleanly as an empty mailwoman config and
 *   silently runs the production default against itself. The caller would get a comparison, a verdict, and no
 *   indication whatever that they did not get the arm they asked for. That is why a kind is never handled by falling
 *   through to the shorthand, including the unknown one, which is refused by name.
 */

import { z } from "zod"

import type { EngineConfig } from "./engine-registry.ts"
import { type ExternalAnswer, ExternalEngine } from "./external-arm.ts"
import { OracleProviderName } from "./oracle-arm.ts"
import { ENGINE_CONFIG_SCHEMA } from "./tool-kit.ts"
import { WORKING_TREE_REF } from "./worktree-arm.ts"

/**
 * How one arm answers one raw query string, whichever kind of arm it is.
 *
 * Lives beside the arm SPECS rather than inside the comparison, so a new arm kind can be implemented in its own module
 * without that module importing the comparison — which would close a cycle, since the comparison must import it back.
 */
export interface ArmRunner {
	label: string
	provenance: Record<string, unknown>
	answer: (input: string) => Promise<ExternalAnswer>
	warnings: string[]
}

/**
 * A mailwoman arm — one warm engine under one configuration.
 */
export interface MailwomanArm {
	kind: "mailwoman"
	config: EngineConfig
}

/**
 * An external arm — a geocoder this repo did not build, already running at an endpoint the caller names.
 */
export interface ExternalArm {
	kind: "external"
	engine: ExternalEngine
	endpoint: string
	/**
	 * What the caller believes is running there. Required only when the endpoint will not identify itself; see
	 * `external-arm.ts`'s identity probe for why an unidentified endpoint is refused rather than scored.
	 */
	version?: string
}

/**
 * A reference geocoder as an arm. Never a grading truth — see `oracle-arm.ts` for the refusal and its two reasons.
 */
export interface OracleArm {
	kind: "oracle"
	provider: OracleProviderName
}

/**
 * A stored past run, replayed row by row.
 *
 * `arm` names which side of that run to replay, because a stored comparison has two. It defaults to `mailwoman` at the
 * call site rather than here, so this type keeps saying that a recorded arm is a run PLUS a side.
 */
export interface RecordedArm {
	kind: "recorded"
	runID: string
	arm: string
}

/**
 * A mailwoman arm running a DIFFERENT VERSION OF THE SOURCE, in its own process (see `worktree-arm.ts`).
 *
 * The kind a source change needs and the other four cannot express. A `mailwoman` arm runs whatever this process
 * imported, so two of them can only differ by CONFIG; a `recorded` arm replays a past run but cannot produce a new one
 * at an old ref. Neither answers "what does my edit do", which is the question most maintainer changes are.
 */
export interface WorktreeArm {
	kind: "worktree"
	/**
	 * A git ref, or `WORKTREE` for the uncommitted working tree.
	 */
	ref: string
	config: EngineConfig
}

export type ArmSpec = MailwomanArm | ExternalArm | OracleArm | RecordedArm | WorktreeArm

/**
 * Which side of a stored run a recorded arm replays when the caller does not say.
 *
 * `mailwoman` because the question a recorded arm answers is almost always "did OUR side change since that run" — the
 * external or oracle side is the control, and re-running it is what a recorded arm exists to avoid.
 */
export const DEFAULT_RECORDED_ARM = "mailwoman"

const MAILWOMAN_ARM_SCHEMA = z.object({
	kind: z.literal("mailwoman"),
	config: ENGINE_CONFIG_SCHEMA.optional(),
})

const EXTERNAL_ARM_SCHEMA = z.object({
	kind: z.literal("external"),
	engine: z.enum([ExternalEngine.Pelias, ExternalEngine.Photon, ExternalEngine.Nominatim]),
	endpoint: z
		.string()
		.describe(
			"Full origin of an ALREADY-RUNNING endpoint, e.g. http://127.0.0.1:4000. Required and never defaulted: this " +
				"server does not start services, and it refuses the shared public instances outright."
		),
	version: z
		.string()
		.optional()
		.describe("Your claim about what is running there. Needed only when the endpoint will not say so itself."),
})

const ORACLE_ARM_SCHEMA = z.object({
	kind: z.literal("oracle"),
	provider: z
		.enum([OracleProviderName.Census, OracleProviderName.Google])
		.describe(
			"census is free, unauthenticated and US-only. google is BILLED and additionally requires the daemon-config " +
				"opt-in — it cannot be enabled from here."
		),
})

const RECORDED_ARM_SCHEMA = z.object({
	kind: z.literal("recorded"),
	run_id: z.string().describe("A run_id from mwdev_runs. Comparisons and runs are stored automatically."),
	arm: z
		.string()
		.optional()
		.describe(`Which side of that run to replay. Default ${JSON.stringify(DEFAULT_RECORDED_ARM)}.`),
})

const WORKTREE_ARM_SCHEMA = z.object({
	kind: z.literal("worktree"),
	ref: z
		.string()
		.describe(
			`A git ref to check out and run in its own process, or ${JSON.stringify(WORKING_TREE_REF)} for the ` +
				"UNCOMMITTED working tree. This is the only arm that can measure a SOURCE change: one process cannot hold " +
				"two versions of a module, so a second process is not an optimization here, it is the mechanism."
		),
	config: ENGINE_CONFIG_SCHEMA.optional(),
})

/**
 * One side of a comparison.
 *
 * Order matters: the bare-{@link EngineConfig} shorthand is last, because it accepts any object and would otherwise
 * swallow every other branch.
 */
export const ARM_SPEC_SCHEMA = z
	.union([
		MAILWOMAN_ARM_SCHEMA,
		EXTERNAL_ARM_SCHEMA,
		ORACLE_ARM_SCHEMA,
		RECORDED_ARM_SCHEMA,
		WORKTREE_ARM_SCHEMA,
		ENGINE_CONFIG_SCHEMA,
	])
	.describe(
		'A mailwoman configuration ({kind:"mailwoman", config}, or the bare config as shorthand), an external endpoint ' +
			'({kind:"external", engine, endpoint}), a reference geocoder ({kind:"oracle", provider}), a stored past run ' +
			'({kind:"recorded", run_id}), or ANOTHER VERSION OF THE SOURCE run in its own process ' +
			`({kind:"worktree", ref}) — ref ${JSON.stringify(WORKING_TREE_REF)} being your uncommitted edits.`
	)

/**
 * Turn whatever arrived into an {@link ArmSpec}, or refuse with a reason a caller can act on.
 *
 * @throws On a deferred kind, an unknown kind, or an external arm missing its endpoint.
 */
export function normalizeArmSpec(raw: unknown, label: string): ArmSpec {
	if (raw === undefined || raw === null) return { kind: "mailwoman", config: {} }

	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError(`Arm ${label} must be an object: a mailwoman config, or {kind:"external", engine, endpoint}.`)
	}

	const record = raw as Record<string, unknown>
	const kind = record["kind"]

	if (kind === undefined) return { kind: "mailwoman", config: record as EngineConfig }

	if (kind === "mailwoman") {
		return { kind: "mailwoman", config: (record["config"] as EngineConfig | undefined) ?? {} }
	}

	if (kind === "external") {
		const engine = record["engine"]
		const endpoint = record["endpoint"]

		if (typeof engine !== "string" || !Object.values(ExternalEngine).includes(engine as ExternalEngine)) {
			throw new Error(
				`Arm ${label}: external \`engine\` must be one of ${Object.values(ExternalEngine).join(", ")}, got ` +
					`${JSON.stringify(engine)}.`
			)
		}

		if (typeof endpoint !== "string" || !endpoint.trim()) {
			throw new Error(
				`Arm ${label}: an external arm needs an \`endpoint\` naming an ALREADY-RUNNING service, e.g. ` +
					"http://127.0.0.1:4000. There is no default — this server starts nothing, so a defaulted endpoint would " +
					"only turn a missing rig into a silent one."
			)
		}

		return {
			kind: "external",
			engine: engine as ExternalEngine,
			endpoint,
			...(typeof record["version"] === "string" ? { version: record["version"] } : {}),
		}
	}

	if (kind === "oracle") {
		const provider = record["provider"]

		if (!Object.values(OracleProviderName).includes(provider as OracleProviderName)) {
			throw new Error(
				`Arm ${label}: oracle \`provider\` must be one of ${Object.values(OracleProviderName).join(", ")}, got ` +
					`${JSON.stringify(provider)}.`
			)
		}

		return { kind: "oracle", provider: provider as OracleProviderName }
	}

	if (kind === "recorded") {
		const runID = record["run_id"]

		if (typeof runID !== "string" || !runID.trim()) {
			throw new Error(
				`Arm ${label}: a recorded arm needs a \`run_id\`. List what is stored with mwdev_runs — a run is not ` +
					"addressable by its inputs, because two runs over the same inputs are exactly what a recorded arm compares."
			)
		}

		const arm = record["arm"]

		return {
			kind: "recorded",
			runID,
			arm: typeof arm === "string" && arm.trim() ? arm : DEFAULT_RECORDED_ARM,
		}
	}

	if (kind === "worktree") {
		const ref = record["ref"]

		if (typeof ref !== "string" || !ref.trim()) {
			throw new Error(
				`Arm ${label}: a worktree arm needs a \`ref\` — a git ref to check out, or ` +
					`${JSON.stringify(WORKING_TREE_REF)} for the uncommitted working tree. There is no default, because ` +
					"the two plausible ones mean opposite things: HEAD would silently discard the edits a caller is trying " +
					"to measure."
			)
		}

		return { kind: "worktree", ref: ref.trim(), config: (record["config"] as EngineConfig | undefined) ?? {} }
	}

	throw new Error(
		`Arm ${label}: unknown kind ${JSON.stringify(kind)}. Expected "mailwoman", "external", "oracle", "recorded" ` +
			'or "worktree".'
	)
}

/**
 * A short name for an arm, for the sentences a reader relays.
 */
export function armLabel(arm: ArmSpec): string {
	if (arm.kind === "mailwoman") return "mailwoman"

	if (arm.kind === "external") return arm.engine

	if (arm.kind === "oracle") return `oracle:${arm.provider}`

	if (arm.kind === "worktree") return `worktree:${arm.ref}`

	return `recorded:${arm.runID}/${arm.arm}`
}
