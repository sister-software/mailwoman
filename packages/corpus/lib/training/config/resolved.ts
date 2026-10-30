/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds and writes the versioned resolved training config the Rust trainer and sampler read: the typed config with
 *   every default applied, the values derived from it, and its source-rights admission.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { resolvePath, type PathBuilderLike } from "path-ts"

import type { SourceRightsRecord } from "#source-register/corpus-inputs"
import { admitTrainingConfig, admittedTrainingSources, type TrainingAdmissionInputs } from "#training/config/admission"
import {
	readTrainingConfig,
	trainingCorpusVersion,
	trainingCSVLogPath,
	typedTrainingConfig,
} from "#training/config/load"
import { RESOLVED_TRAINING_CONFIG_VERSION, type TrainingConfig } from "#training/config/schema"

/**
 * The versioned resolved config: every default applied and the admission result embedded.
 */
export interface ResolvedTrainingConfigDocument {
	schema_version: typeof RESOLVED_TRAINING_CONFIG_VERSION
	/**
	 * The YAML file the config was read from, absolute.
	 */
	config_path: string
	config_sha256: string
	config: TrainingConfig
	/**
	 * Values the Python loader computes from the config where a caller asks for them.
	 */
	derived: {
		admitted_sources: string[]
		corpus_version: string
		csv_log_path: string
	}
	source_rights: SourceRightsRecord
}

/**
 * Options for {@linkcode buildResolvedTrainingConfig}.
 */
export interface ResolvedTrainingConfigOptions {
	rights?: TrainingAdmissionInputs
	log?: (line: string) => void
}

/**
 * Reads, types and admits the config at `path`, and returns the resolved document.
 *
 * @throws {TrainingConfigError} for a config the loader or the schema refuses.
 * @throws {SourceRightsError} for a config that admits a source lacking a permission.
 */
export async function buildResolvedTrainingConfig(
	path: PathBuilderLike,
	options: ResolvedTrainingConfigOptions = {}
): Promise<ResolvedTrainingConfigDocument> {
	const absolute = resolvePath(path)
	const config = typedTrainingConfig(await readTrainingConfig(absolute), absolute)
	const name = absolute.split("/").at(-1) ?? absolute

	const sourceRights = await admitTrainingConfig(config, {
		context: `training config ${name}`,
		rights: options.rights,
		log: options.log,
	})

	return {
		schema_version: RESOLVED_TRAINING_CONFIG_VERSION,
		config_path: absolute,
		config_sha256: await sha256File(absolute),
		config,
		derived: {
			admitted_sources: admittedTrainingSources(config),
			corpus_version: trainingCorpusVersion(config),
			csv_log_path: trainingCSVLogPath(config),
		},
		source_rights: sourceRights,
	}
}

/**
 * Writes the resolved config for the YAML at `configPath` to `outPath` as JSON.
 */
export async function writeResolvedTrainingConfig(
	configPath: PathBuilderLike,
	outPath: PathBuilderLike,
	options: ResolvedTrainingConfigOptions = {}
): Promise<ResolvedTrainingConfigDocument> {
	const document = await buildResolvedTrainingConfig(configPath, options)

	await writeLocalJSONFile(document, outPath)

	return document
}
