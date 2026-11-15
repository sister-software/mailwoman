// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The contract an evaluation address source satisfies.
 *
 *   An evaluation source is a publication whose rows give the release check's comparative objective
 *   rows a model didn't train on (`docs/engineering/HOLDOUT_AND_EVALUATION.mdx` section 6.4).
 *   A source stays unseen only while its register decision refuses `train`,
 *   which keeps it out of every build through `ingestEligibilityProblems`.
 *
 *   The four sources `#evaluation/sources` lists now permit `train`, and each feeds a
 *   corpus adapter built by `#evaluation/corpus-adapter` over the same record reader,
 *   so a fix to the reader reaches both.
 *   The fresh set frozen from them on 2026-11-14 is no longer registered by any release
 *   specification (`docs/records/evals/2026-11-14-fresh-source-evaluation-set.md`).
 *
 *   A source's identity, terms, fetch and reader live under its country's directory
 *   (`lib/<cc>/evaluation/`), and `#evaluation/sources` lists every one.
 *   The evaluation-set builder in `packages/mailwoman/tools/eval-harness/heldout/fresh/`
 *   reads only the fields below and never branches on a country.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import type { PathBuilder } from "path-ts"

import { splitCORDISStreetLine, streetOrderForCountry } from "#adapters/cordis/adapter"
import { downloadToFile, readManifest, type SourceManifest, writeManifest } from "#tools/fetch/download"

/**
 * One address an evaluation-only source states.
 */
export interface EvaluationAddressRecord {
	/**
	 * The publisher's own identifier for the record, unique within the source.
	 */
	id: string
	/**
	 * The region the record is stratified by: a state, a province, a region,
	 * or the publisher's coarsest geographic field.
	 */
	stratum: string
	/**
	 * The address as the components the parser labels.
	 */
	components: Partial<Record<ComponentTag, string>>
}

/**
 * One publisher record as an address record, or the reason it yields none.
 */
export type EvaluationRecordReading = EvaluationAddressRecord | { readonly refused: string }

/**
 * What one read of a source yielded: its records and why the others yielded none.
 */
export interface EvaluationSourceRead {
	/**
	 * The publisher's vintage for the read input, or its fetch date where the publisher states none.
	 */
	vintage: string
	records: AsyncIterable<EvaluationAddressRecord>
	/**
	 * Refusals counted by reason, filled while `records` is consumed.
	 */
	refused: Record<string, number>
}

/**
 * One country's evaluation-only address publication.
 */
export interface EvaluationSource {
	/**
	 * The stable source id, stored on every row the source contributes
	 * and naming its directory under the sources root.
	 */
	id: string
	/**
	 * The ISO 3166-1 alpha-2 code stamped on every row.
	 */
	country: string
	publisher: string
	/**
	 * The credit the publisher's grant requires.
	 */
	attribution: string
	/**
	 * The grant as the publisher names it, such as `Creative Commons Attribution 3.0 Australia`.
	 */
	license: string
	/**
	 * The `sourceID` of the source's row in `data/address-source-register.json`.
	 */
	registerSource: string
	/**
	 * Downloads the input `read` takes into `directory` and records the fetch in its `MANIFEST.json`.
	 */
	fetch(directory: PathBuilder, report?: (line: string) => void): Promise<SourceManifest>
	/**
	 * Reads the fetched input under `directory`.
	 *
	 * @throws When the input or the record of its fetch is missing.
	 */
	read(directory: PathBuilder): Promise<EvaluationSourceRead>
}

/**
 * Downloads `url` to `directory/filename` and writes the fetch record beside it.
 */
export async function fetchEvaluationFile(
	directory: PathBuilder,
	url: string,
	filename: string,
	report?: (line: string) => void
): Promise<SourceManifest> {
	await makeDirectories(directory)

	const dest = directory(filename)

	report?.(`  ${url}`)

	await downloadToFile({ url, dest, retries: 2 })

	const manifest: SourceManifest = {
		source_url: url,
		downloaded_at: new Date().toISOString(),
		filename,
		sha256: await sha256File(dest),
		bytes: (await statPath(dest)).size,
	}

	await writeManifest(directory("MANIFEST.json"), manifest)

	report?.(`  ${manifest.bytes.toLocaleString()} bytes, sha256 ${manifest.sha256}`)

	return manifest
}

/**
 * The fetch record `fetchEvaluationFile` wrote under `directory`.
 *
 * @throws When the directory holds none.
 */
export async function readEvaluationFetch(directory: PathBuilder): Promise<SourceManifest> {
	const manifest = await readManifest<SourceManifest>(directory("MANIFEST.json"))

	if (!manifest) throw new Error(`${directory("MANIFEST.json")} is missing; fetch the source first`)

	return manifest
}

/**
 * A source read over `readings`, counting each refusal under `refused` while `records` is consumed.
 */
export function evaluationSourceRead(
	vintage: string,
	readings: AsyncIterable<EvaluationRecordReading>
): EvaluationSourceRead {
	const refused: Record<string, number> = {}

	async function* records(): AsyncGenerator<EvaluationAddressRecord> {
		for await (const reading of readings) {
			if ("refused" in reading) {
				refused[reading.refused] = (refused[reading.refused] ?? 0) + 1

				continue
			}

			yield reading
		}
	}

	return { vintage, records: records(), refused }
}

/**
 * Why a street line yields no address.
 */
export const EvaluationStreetRefusal = {
	/**
	 * The line holds no house number, or one the country's side cannot place.
	 */
	NumberAbsent: "street:number-absent",
	Unread: "street:unread",
} as const

/**
 * A street line split into its street and house number on the side `country`
 * writes the number, or the reason it yields none.
 *
 * A line without a house number is refused, so every row of an evaluation set addresses a premise.
 */
export function evaluationStreetLine(
	line: string,
	country: string
): { street: string; house_number: string } | { refused: string } {
	const split = splitCORDISStreetLine(line, streetOrderForCountry(country))

	if (!split) return { refused: EvaluationStreetRefusal.Unread }

	if ("refused" in split) return { refused: `street:${split.refused}` }

	if (!split.house_number) return { refused: EvaluationStreetRefusal.NumberAbsent }

	return { street: split.street, house_number: split.house_number }
}
