// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reusing a finished source from an earlier build's output directory.
 *
 *   A source's files depend on its input, the code its producer reaches, the data files align reads and the build
 *   settings. They don't depend on the corpus version, because rows hold no version, or on the builder version once
 *   the code hash covers the code. A source whose derivation and settings match apart from those two fields is
 *   therefore the same work, and a build may take it from an earlier build instead of running it again.
 *
 *   An import clones each file the source's record lists into this build's output directory, at the same path
 *   relative to the output root, and writes the record with the new paths. On btrfs a clone shares the earlier
 *   file's blocks. The imported record keeps the earlier build's settings and derivation, because its files were
 *   written under them. Its `reusedFrom` field records the directory it came from.
 */

import type { RecordedFile } from "@mailwoman/core/crypto/hash"
import { cloneFileTo, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { isAbsolute, PathBuilder, relative, resolvePath, type PathBuilderLike } from "path-ts"

import {
	readReusableSource,
	SOURCE_RECORD_FILE,
	sourceStateDirectory,
	type SourceBuildSettings,
	type SourceCompletionRecord,
} from "#build/source-record"
import { recordPathFor, type DerivationInputs } from "#parquet/record"

/**
 * Where an import reads from and writes to.
 */
export interface SourceImport {
	source: string
	/**
	 * The earlier build's `--out`.
	 */
	priorOutputDir: PathBuilderLike
	/**
	 * This build's `--out`.
	 */
	outputDir: PathBuilderLike
	expected: { settings: SourceBuildSettings; derivation: DerivationInputs }
}

/**
 * Import one source from an earlier build, or return why it can't be.
 *
 * Before any file is cloned, {@linkcode readReusableSource} checks the earlier record across builds.
 * It re-hashes every file the record lists.
 */
export async function importPriorSource(
	opts: SourceImport
): Promise<{ record: SourceCompletionRecord; problem: null } | { record: null; problem: string }> {
	const priorRoot = PathBuilder.from(opts.priorOutputDir)
	const priorSourceDir = sourceStateDirectory(priorRoot("intermediate"), opts.source)
	const reusable = await readReusableSource(priorSourceDir, opts.expected, { acrossBuilds: true })

	if (!reusable.record) return reusable

	const prior = reusable.record

	const moved = (path: string): string => {
		const inside = relative(priorRoot.toString(), path)

		if (inside.startsWith("..") || isAbsolute(inside)) {
			throw new Error(`importPriorSource: ${path} is outside ${priorRoot.toString()}, so it has no place in this build`)
		}

		return resolvePath(opts.outputDir, inside).toString()
	}

	const clone = async (path: string): Promise<string> => {
		const destination = moved(path)

		await cloneFileTo(path, destination)

		return destination
	}

	const cloneRecorded = async (file: RecordedFile): Promise<RecordedFile> => ({ ...file, path: await clone(file.path) })

	const parts = await Promise.all(
		prior.parts.map(async (part) => {
			await clone(recordPathFor(part.path))

			return { ...part, path: await clone(part.path) }
		})
	)

	const sourceIDs = Object.fromEntries(
		await Promise.all(Object.entries(prior.sourceIDs).map(async ([split, file]) => [split, await cloneRecorded(file)]))
	) as SourceCompletionRecord["sourceIDs"]

	const record: SourceCompletionRecord = {
		...prior,
		adapter: { ...prior.adapter, jsonl_path: await clone(prior.adapter.jsonl_path) },
		parts,
		sourceIDs,
		quarantine: await Promise.all(prior.quarantine.map(cloneRecorded)),
		reusedFrom: priorRoot.toString(),
	}

	// The record goes last, so a record on disk means every file it lists was cloned first.
	await writeLocalJSONFile(
		record,
		sourceStateDirectory(PathBuilder.from(opts.outputDir)("intermediate"), opts.source)(SOURCE_RECORD_FILE)
	)

	return { record, problem: null }
}
