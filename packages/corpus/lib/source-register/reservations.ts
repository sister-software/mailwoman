// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Audits the register's evaluation reservations against the records of what trained and what was frozen.
 *
 *   Two rules hold.
 *
 *   - A source a training manifest read can't be reserved at source scope,
 *     because a model has already seen its rows.
 *   - A lifted reservation's `retires` lists every held-out dataset that froze rows from the source.
 *     Once lifted, the source's rows can reach training, and those datasets stop being unseen.
 *
 *   A corpus source id reaches register sources through `corpus-source-inputs.json`,
 *   read as the record's corpus was built.
 *   An id the table doesn't map is reported rather than read as reading no source.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { SOURCE_RESERVATION_SCOPE } from "@mailwoman/license/reservation"

import { mappingInputsFor, type CorpusSourceInputs } from "#source-register/corpus-inputs"
import type { TrainingManifest } from "#source-register/training-manifest"
import type { AddressSourceRegister } from "#source-register/types"

/**
 * The fields of a frozen collection the audit reads: its id, the corpus it was drawn from,
 * and the corpus source ids among its rows.
 */
export interface FrozenDatasetSources {
	datasetID: string
	corpusVersion: string | null
	sources: readonly string[]
}

/**
 * The fields of a training manifest the audit reads.
 */
export type TrainingManifestSources = Pick<TrainingManifest, "corpusVersion"> & {
	sources: ReadonlyArray<Pick<TrainingManifest["sources"][number], "source">>
}

/**
 * Each register source the corpus sources read, with the record that names it.
 */
interface RegisterSourceReaders {
	readers: Map<string, Set<string>>
	unmapped: string[]
}

function readersOf(
	records: ReadonlyArray<{ record: string; corpusVersion: string | null; sources: readonly string[] }>,
	inputs: CorpusSourceInputs
): RegisterSourceReaders {
	const readers = new Map<string, Set<string>>()
	const unmapped = new Set<string>()

	for (const { record, corpusVersion, sources } of records) {
		for (const source of sources) {
			const resolved = inputs.resolve(source)

			if (!resolved) {
				unmapped.add(`${record}: ${source}`)

				continue
			}

			for (const input of mappingInputsFor(resolved.mapping, corpusVersion ?? undefined)) {
				const named = readers.get(input.registerSource) ?? new Set<string>()

				named.add(record)
				readers.set(input.registerSource, named)
			}
		}
	}

	return { readers, unmapped: [...unmapped].toSorted() }
}

/**
 * Every register source a training manifest read, with the corpus versions that read it.
 *
 * `unmapped` lists each corpus source a manifest names that the table doesn't map.
 */
export function trainedRegisterSources(
	manifests: readonly TrainingManifestSources[],
	inputs: CorpusSourceInputs
): RegisterSourceReaders {
	return readersOf(
		manifests.map((manifest) => ({
			record: manifest.corpusVersion,
			corpusVersion: manifest.corpusVersion,
			sources: manifest.sources.map((entry) => entry.source),
		})),
		inputs
	)
}

/**
 * One message for each reservation the training and held-out records contradict.
 *
 * A corpus source a record names that the table doesn't map is a problem only
 * where it could hide a contradiction: for a training manifest when any source is reserved,
 * and for a held-out dataset when any reservation is lifted.
 */
export function auditReservationHistory(
	register: { sources: ReadonlyArray<Pick<AddressSourceRegister["sources"][number], "sourceID" | "reservation">> },
	records: {
		inputs: CorpusSourceInputs
		trainingManifests: readonly TrainingManifestSources[]
		heldoutDatasets: readonly FrozenDatasetSources[]
	}
): string[] {
	const problems: string[] = []
	const reserved = register.sources.filter((source) => source.reservation)
	const trained = trainedRegisterSources(records.trainingManifests, records.inputs)

	const frozen = readersOf(
		records.heldoutDatasets.map((dataset) => ({
			record: dataset.datasetID,
			corpusVersion: dataset.corpusVersion,
			sources: dataset.sources,
		})),
		records.inputs
	)

	const active = reserved.filter((source) => !source.reservation!.lifted)
	const lifted = reserved.filter((source) => source.reservation!.lifted)

	if (active.length && trained.unmapped.length) {
		problems.push(
			`${trained.unmapped.length} corpus source(s) a training manifest names are not mapped in ` +
				`corpus-source-inputs.json, so whether they read a reserved source cannot be read: ${trained.unmapped.join(", ")}`
		)
	}

	for (const source of active) {
		if (source.reservation!.scope !== SOURCE_RESERVATION_SCOPE) continue

		const readers = trained.readers.get(source.sourceID)

		if (!readers) continue

		problems.push(
			`source ${stringifyJSON(source.sourceID)} is reserved at source scope, and training manifest(s) ` +
				`${[...readers].toSorted().join(", ")} read it, so its rows are no longer unseen by every model`
		)
	}

	if (lifted.length && frozen.unmapped.length) {
		problems.push(
			`${frozen.unmapped.length} corpus source(s) a held-out dataset names are not mapped in ` +
				`corpus-source-inputs.json, so whether they froze rows from a lifted reservation cannot be read: ` +
				frozen.unmapped.join(", ")
		)
	}

	for (const source of lifted) {
		const retires = new Set(source.reservation!.lifted!.retires)
		const unnamed = [...(frozen.readers.get(source.sourceID) ?? [])].filter((dataset) => !retires.has(dataset))

		if (!unnamed.length) continue

		problems.push(
			`source ${stringifyJSON(source.sourceID)}'s lifted reservation retires ` +
				`${stringifyJSON([...retires])} and does not name ${unnamed.toSorted().join(", ")}, ` +
				"which froze rows from it"
		)
	}

	return problems
}

/**
 * Reads every committed frozen training manifest, `packages/corpus/data/training-manifests/<corpus>.json`.
 *
 * An effective manifest (`*.effective.json`) records an epoch's draw rather than a corpus and isn't read.
 */
export async function readCommittedTrainingManifests(): Promise<TrainingManifest[]> {
	const directory = resolvePackagePath("@mailwoman/corpus", "data", "training-manifests")
	const paths = (await sortedGlob(directory, "*.json")).filter((path) => !path.endsWith(".effective.json"))

	return Promise.all(paths.map((path) => readLocalJSONFile<TrainingManifest>(path)))
}
