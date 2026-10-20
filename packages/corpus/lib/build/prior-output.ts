/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The guard a build passes before it opens any output: it reads the work a previous build left
 *   under the output directory and refuses to discard it unless the caller chose to resume or to start
 *   fresh.
 *
 *   The align phase opens its four outputs with flag `w` unless it resumes, and the adapter phase
 *   rewrites `canonical.jsonl` unless it reuses the run, so a build without this guard truncates a
 *   finished checkpoint's outputs without a word.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isDirectory, tryStat } from "@mailwoman/core/fs/readers/stat"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { AlignCheckpoint, AlignOutputName } from "#build/checkpoint"
import { PriorOutput } from "#build/types"

/**
 * The work one output directory holds from an earlier build.
 */
export interface PriorWork {
	/**
	 * The align checkpoint's path and the adapters it records as aligned, or `null` when none exists.
	 */
	checkpoint: { path: PathBuilder; completedAdapters: readonly string[] } | null

	/**
	 * Each align output that exists with at least one byte, by path, with its size in bytes.
	 */
	alignOutputs: { path: PathBuilder; bytes: number }[]

	/**
	 * Each configured adapter whose `MANIFEST.json` records a finished run, with its canonical file's size.
	 */
	adapterRuns: { adapterID: string; manifest: PathBuilder; canonicalBytes: number | null }[]

	/**
	 * Each source directory a parallel build left under `intermediate/sources/`.
	 */
	sourceStates: PathBuilder[]
}

export interface PriorWorkPaths {
	intermediateDir: PathBuilder
	checkpointPath: PathBuilder
	/**
	 * Every file the align phase writes: its four outputs and the source-id lists beside them.
	 */
	alignPaths: Record<AlignOutputName, PathBuilder> & Record<string, PathBuilder>
	adapterIDs: readonly string[]
}

/**
 * Read what a previous build left under the output directory.
 *
 * @throws When the checkpoint exists and cannot be read, because a guard that read an
 * unreadable checkpoint as absent would let the build truncate the outputs it describes.
 */
export async function readPriorWork(paths: PriorWorkPaths): Promise<PriorWork> {
	const checkpoint = (await tryStat(paths.checkpointPath))
		? {
				path: paths.checkpointPath,
				completedAdapters: (await readLocalJSONFile<AlignCheckpoint>(paths.checkpointPath)).completed_adapters,
			}
		: null

	const alignOutputs: PriorWork["alignOutputs"] = []

	for (const path of Object.values(paths.alignPaths)) {
		const stat = await tryStat(path)

		if (stat && stat.size) {
			alignOutputs.push({ path, bytes: stat.size })
		}
	}

	const adapterRuns: PriorWork["adapterRuns"] = []

	for (const adapterID of paths.adapterIDs) {
		const manifest = paths.intermediateDir(adapterID, "MANIFEST.json")

		if (!(await tryStat(manifest))) continue

		const canonical = await tryStat(paths.intermediateDir(adapterID, "canonical.jsonl"))

		adapterRuns.push({ adapterID, manifest, canonicalBytes: canonical ? canonical.size : null })
	}

	const sourcesDir = paths.intermediateDir("sources")

	const sourceStates = (await isDirectory(sourcesDir))
		? (await Globerator.from("*", { cwd: sourcesDir.toString(), absolute: false, onlyFiles: false }).toSorted()).map(
				(name) => sourcesDir(name)
			)
		: []

	return { checkpoint, alignOutputs, adapterRuns, sourceStates }
}

function hasPriorWork(work: PriorWork): boolean {
	return (
		work.checkpoint != null ||
		work.alignOutputs.length > 0 ||
		work.adapterRuns.length > 0 ||
		work.sourceStates.length > 0
	)
}

/**
 * Describe the prior work and the two ways forward, as the refusal states them.
 */
export function describePriorWork(work: PriorWork): string {
	const lines: string[] = []

	if (work.checkpoint) {
		lines.push(
			`align checkpoint ${work.checkpoint.path.toString()} records ${work.checkpoint.completedAdapters.length} ` +
				`aligned adapters: ${work.checkpoint.completedAdapters.join(", ") || "(none)"}`
		)
	}

	for (const output of work.alignOutputs) {
		lines.push(`align output ${output.path.toString()}: ${output.bytes.toLocaleString("en-US")} bytes`)
	}

	for (const run of work.adapterRuns) {
		lines.push(
			`adapter run ${run.adapterID}: ${run.manifest.toString()}, canonical.jsonl ` +
				(run.canonicalBytes == null ? "absent" : `${run.canonicalBytes.toLocaleString("en-US")} bytes`)
		)
	}

	for (const state of work.sourceStates) {
		lines.push(`parallel-build source state ${state.toString()}`)
	}

	return lines.map((line) => `  ${line}`).join("\n")
}

/**
 * Apply the caller's choice about prior work before any phase opens an output.
 *
 * `Refuse` throws when prior work exists, `Resume` leaves it for the phases to reuse,
 * and `Fresh` removes the checkpoint, the align outputs and each adapter manifest.
 *
 * @throws Under `Refuse` when the output directory holds prior work, naming every file and its size.
 */
export async function settlePriorWork(choice: PriorOutput, paths: PriorWorkPaths): Promise<PriorWork> {
	const work = await readPriorWork(paths)

	if (!hasPriorWork(work)) return work

	if (choice === PriorOutput.Refuse) {
		throw new Error(
			`corpus build refused: ${paths.intermediateDir.toString()} holds a previous build's work, and this ` +
				`run would overwrite it.\n${describePriorWork(work)}\n` +
				`Pass --resume (priorOutput "resume") to reuse the finished adapter runs and continue align from ` +
				`its checkpoint, or --fresh (priorOutput "fresh") to delete this work and build from the start.`
		)
	}

	if (choice === PriorOutput.Fresh) {
		if (work.checkpoint) {
			await removePathIfPresent(work.checkpoint.path)
		}

		for (const output of work.alignOutputs) {
			await removePathIfPresent(output.path)
		}

		for (const run of work.adapterRuns) {
			await removePathIfPresent(run.manifest)
		}

		for (const state of work.sourceStates) {
			await removePathIfPresent(state)
		}
	}

	return work
}
