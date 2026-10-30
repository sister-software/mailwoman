/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Checks the corpus sources a typed training config admits against the address-source register, as
 *   `load_training_config` did.
 */

import {
	createSourceRightsAdmission,
	readCorpusSourceInputs,
	SourceRightsError,
	TRAINING_OPERATIONS,
	type CorpusSourceInputs,
	type SourceRightsRecord,
} from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import type { AddressSourceRegister } from "#source-register/types"
import { trainingCorpusVersion } from "#training/config/load"
import type { TrainingConfig } from "#training/config/schema"

/**
 * The corpus sources a config admits: every positive `source_weights` or `source_reps` key, sorted.
 *
 * A config without `source_weights` admits every source its corpus holds and lists none of them.
 */
export function admittedTrainingSources(config: TrainingConfig): string[] {
	const positive = (weights: Record<string, number> | null) =>
		Object.entries(weights ?? {})
			.filter(([, weight]) => weight > 0)
			.map(([source]) => source)

	return [...new Set([...positive(config.data.source_weights), ...positive(config.data.source_reps)])].toSorted()
}

/**
 * The register and corpus-source table an admission reads, when a caller has read them already.
 */
export interface TrainingAdmissionInputs {
	register: AddressSourceRegister
	inputs: CorpusSourceInputs
}

/**
 * Where a training config sets the override a refusal names.
 */
const CONFIG_OVERRIDE_HINT = "a config's data.unshippable_reason for a training run"

/**
 * Options for {@linkcode admitTrainingConfig}.
 */
export interface AdmitTrainingConfigOptions {
	/**
	 * Names the config in a refusal, as `training config v7.2.0-address-systems-60k.yaml`.
	 */
	context: string
	/**
	 * The committed register and table are read when omitted.
	 */
	rights?: TrainingAdmissionInputs
	log?: (line: string) => void
}

/**
 * Refuses a config that admits a source lacking a transform and train permission,
 * as `load_training_config` does.
 *
 * `data.unshippable_reason` admits the rest for a local experiment, and the record then reads not shippable.
 * A config without `source_weights` names no source to check, so it is refused unless that reason is set.
 *
 * @throws {SourceRightsError} naming each source, register row and missing permission.
 */
export async function admitTrainingConfig(
	config: TrainingConfig,
	options: AdmitTrainingConfigOptions
): Promise<SourceRightsRecord> {
	const reason = config.data.unshippable_reason

	if (config.data.source_weights === null && reason === null) {
		throw new SourceRightsError(
			options.context,
			[
				{
					source: "*",
					registerSource: null,
					licenseID: null,
					state: null,
					missing: [...TRAINING_OPERATIONS],
					because:
						"the config sets no source_weights, so it admits every source its corpus holds and names none to check",
				},
			],
			CONFIG_OVERRIDE_HINT
		)
	}

	const register = options.rights?.register ?? (await readAddressSourceRegister())
	const inputs = options.rights?.inputs ?? (await readCorpusSourceInputs(register))

	const admission = createSourceRightsAdmission(register, inputs, {
		context: options.context,
		unshippableReason: reason,
		corpusVersion: trainingCorpusVersion(config),
		overrideHint: CONFIG_OVERRIDE_HINT,
		log: options.log,
	})

	if (config.data.source_weights === null) {
		admission.admitUnverified("the corpus sources a config without source_weights admits")
	} else {
		admission.admitAll(admittedTrainingSources(config))
	}

	return admission.record()
}
