import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"

import { checkConfounds, type ConfoundReading } from "#confound"
import {
	EFFECTIVE_KEY_FOR,
	engineID,
	resolveConfig,
	type EngineConfig,
	type EngineRegistryLike,
} from "#engine-registry"
import type { ResolvedInput, ResolvedInputSet } from "#input-sets"
import { buildRoutedMailwomanArm } from "#routed-mailwoman-arm"
import { inputSetProvenance, provenanceFor } from "#tool-kit"

export interface PreparedMailwomanArms extends Disposable {
	geocodeA(input: ResolvedInput): Promise<GauntletResult>
	geocodeB(input: ResolvedInput): Promise<GauntletResult>
	provenanceA: unknown
	provenanceB: unknown
	comparisonEngineID: string
	confounds: ConfoundReading
}

export interface PrepareMailwomanArmDeps {
	buildRoutedMailwomanArm?: typeof buildRoutedMailwomanArm
}

export async function prepareMailwomanArms(
	registry: EngineRegistryLike,
	set: ResolvedInputSet,
	configA: EngineConfig,
	configB: EngineConfig,
	declared: string[],
	executionPath: "single-config" | "board-routed",
	deps: PrepareMailwomanArmDeps
): Promise<PreparedMailwomanArms> {
	using resources = new DisposableStack()
	const fingerprint = await registry.fingerprint()
	const effectiveA = resolveConfig(configA)
	const effectiveB = resolveConfig(configB)

	if (executionPath === "single-config") {
		const engineA = await registry.acquire(configA)
		const engineB = await registry.acquire(configB)
		const confounds = checkConfounds(engineA.effective, engineB.effective, declared)

		if (engineA.fingerprint.digest !== engineB.fingerprint.digest) {
			throw new Error(
				`Arms were built against different source trees (${engineA.fingerprint.digest} vs ` +
					`${engineB.fingerprint.digest}). That is not a comparison. Call mwdev_restart and re-run.`
			)
		}

		const declaredConfigKeys = declared.filter((key) => key in EFFECTIVE_KEY_FOR)

		if (declaredConfigKeys.length && engineA.engineID === engineB.engineID) {
			throw new Error(
				`The comparison declares EngineConfig key${declaredConfigKeys.length === 1 ? "" : "s"} ` +
					`${declaredConfigKeys.join(", ")} as variable, but both arms resolved to engine ${engineA.engineID}. ` +
					"Refusing a comparison in which the declared configuration variable did not produce distinct engines."
			)
		}

		return Object.assign(resources.move(), {
			geocodeA: async (input: ResolvedInput) => toGauntletResult((await engineA.session.geocode(input.input)).result),
			geocodeB: async (input: ResolvedInput) => toGauntletResult((await engineB.session.geocode(input.input)).result),
			provenanceA: provenanceFor(engineA, set),
			provenanceB: provenanceFor(engineB, set),
			comparisonEngineID: engineA.engineID,
			confounds,
		})
	}

	if (!set.setID.startsWith("board")) {
		throw new Error("execution_path board-routed requires a board input set with registered row routes.")
	}

	const confounds = checkConfounds({ ...effectiveA }, { ...effectiveB }, declared)

	if (await registry.sourceMoved()) {
		throw new Error(
			`The dev worker imported source tree ${registry.bootFingerprint.digest}, but the working tree is now ` +
				`${fingerprint.digest}. Call mwdev_restart before grading.`
		)
	}

	const buildRoutedArm = deps.buildRoutedMailwomanArm ?? buildRoutedMailwomanArm
	const routedA = resources.use(await buildRoutedArm(configA, set.inputs))
	const routedB = resources.use(await buildRoutedArm(configB, set.inputs))

	const sourceProvenance = {
		tree_fingerprint: fingerprint.digest,
		git_head: fingerprint.gitHead,
		dirty: fingerprint.dirtyFiles.length > 0,
		dirty_files: fingerprint.dirtyFiles,
		input_set: inputSetProvenance(set),
	}

	return Object.assign(resources.move(), {
		geocodeA: routedA.geocode,
		geocodeB: routedB.geocode,
		provenanceA: { ...routedA.provenance, ...sourceProvenance },
		provenanceB: { ...routedB.provenance, ...sourceProvenance },
		comparisonEngineID: engineID(effectiveA, fingerprint),
		confounds,
	})
}
