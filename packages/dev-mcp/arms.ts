/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a comparison's two sides may be.
 *
 *   Spec §6.1 gives `ArmSpec` four members. Two are built — a mailwoman configuration and an external endpoint — and
 *   two are deferred: `{kind:"oracle"}` is metered and billed and needs the daemon-config opt-in §7.3 describes, and
 *   `{kind:"recorded"}` needs the run store that does not exist yet.
 *
 *   The deferred pair still has a schema branch, and that is the load-bearing detail in this file. A bare
 *   {@link EngineConfig} stays legal as shorthand so the older two-mailwoman-arms call keeps working, and a zod object
 *   STRIPS unknown keys — so without an explicit branch, `{kind:"oracle", provider:"google"}` parses cleanly as an
 *   empty mailwoman config and silently runs the production default against itself. The caller would get a comparison,
 *   a verdict and no indication whatever that they did not get the oracle they asked for. Accepting the shape in order
 *   to refuse it by name is the difference between a tool that says no and a tool that lies.
 */

import { z } from "zod"

import type { EngineConfig } from "./engine-registry.ts"
import { ExternalEngine } from "./external-arm.ts"
import { ENGINE_CONFIG_SCHEMA } from "./tool-kit.ts"

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

export type ArmSpec = MailwomanArm | ExternalArm

/**
 * The arm kinds spec §6.1 names but this surface does not implement. Accepted by the schema and refused by name — see
 * the module docstring for why silently dropping them was the dangerous alternative.
 */
export const DEFERRED_ARM_KINDS = ["oracle", "recorded"] as const

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

const DEFERRED_ARM_SCHEMA = z.object({
	kind: z.enum(DEFERRED_ARM_KINDS),
	provider: z.string().optional(),
	run_id: z.string().optional(),
})

/**
 * One side of a comparison.
 *
 * Order matters: the bare-{@link EngineConfig} shorthand is last, because it accepts any object and would otherwise
 * swallow every other branch.
 */
export const ARM_SPEC_SCHEMA = z
	.union([MAILWOMAN_ARM_SCHEMA, EXTERNAL_ARM_SCHEMA, DEFERRED_ARM_SCHEMA, ENGINE_CONFIG_SCHEMA])
	.describe(
		'A mailwoman configuration ({kind:"mailwoman", config}, or the bare config as shorthand) or an external ' +
			'endpoint ({kind:"external", engine, endpoint}).'
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
		throw new Error(
			`Arm ${label}: oracle arms are not implemented here. The reference geocoders are billed (Google) or ` +
				"US-only (Census), and spec §7.3 puts them behind a daemon-config opt-in with a call cap — not a tool " +
				"argument. Reach them through @mailwoman/geocode-oracle directly, and remember its own header: not truth, " +
				"and not a gate."
		)
	}

	if (kind === "recorded") {
		throw new Error(
			`Arm ${label}: recorded arms are not implemented here. They need the run store from spec §6.5, which does not ` +
				"exist yet — there is nothing to look a run_id up in."
		)
	}

	throw new Error(`Arm ${label}: unknown kind ${JSON.stringify(kind)}. Expected "mailwoman" or "external".`)
}

/**
 * A short name for an arm, for the sentences a reader relays.
 */
export function armLabel(arm: ArmSpec): string {
	return arm.kind === "mailwoman" ? "mailwoman" : arm.engine
}
