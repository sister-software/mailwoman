/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Retention of installed artifacts: session leases, the prune plan and its execution.
 *
 *   Retention policy. Prune keeps every artifact that one of these references:
 *
 *   - the active generation.
 *   - the generations before it, back to {@link DEFAULT_RETAINED_GENERATIONS} in all, so a rollback has
 *     its files.
 *   - a generation a live session holds through a lease under `<data-root>/leases/`.
 *
 *   Prune deletes only installed artifacts under `db/<role>/<hex>/` that none of those references. It never
 *   deletes a file at a conventional path, a partial transfer kept for a resume, or an acquired source input.
 *   A file is never deleted because its name looks older.
 *
 *   A plan records the generation and the leases it read. Execution holds the installer and selection locks,
 *   reads both again, and refuses when either changed, so a concurrent activation or a new session between
 *   planning and execution stops the prune rather than deleting what it now needs.
 */

import { acquireDirectoryLock, processExists } from "@mailwoman/core/fs/lock"
import type { Dirent } from "@mailwoman/core/fs/readers"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { removePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { ActiveSelection, ArtifactID, LayerInstallationID } from "@mailwoman/core/layers"
import { hostName } from "@mailwoman/core/utils/system"
import { PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { catalogPaths, readActiveSelection, readInstallations, writeRecordAtomically } from "#data/catalog"
import { readInstalledCopies } from "#data/plan"

/**
 * The generations a prune keeps by default: the active one and the one a rollback restores.
 */
export const DEFAULT_RETAINED_GENERATIONS = 2

/**
 * One session's hold on a selection generation.
 */
export interface SelectionLease {
	pid: number
	host: string
	generation: number
	startedAt: string
}

/**
 * Record that this process reads `generation`, so a prune keeps its artifacts until the lease is disposed.
 *
 * A data root this process cannot write, such as a read-only mount, takes no lease.
 * Prune then cannot see this reader, and the result says so.
 */
export async function holdSelectionLease(
	dataRoot: PathBuilderLike,
	generation: number
): Promise<Disposable & { path: string | null }> {
	const path = catalogPaths(dataRoot).root("leases", `${process.pid}-${generation}-${Date.now()}.json`).toString()
	const lease: SelectionLease = { pid: process.pid, host: hostName(), generation, startedAt: new Date().toISOString() }

	try {
		await writeRecordAtomically(lease, path)
	} catch {
		return { path: null, [Symbol.dispose]: () => {} }
	}

	return {
		path,
		[Symbol.dispose]: () => {
			// Synchronous teardown runs at session disposal.
			// The removal is started and not awaited, and a lease file left behind belongs
			// to a pid that no longer exists, which prune ignores.
			void removePathIfPresent(path).catch(() => {})
		},
	}
}

/**
 * The leases of live processes under the data root.
 *
 * A lease of a process that no longer exists on this host is left by one that
 * exited without disposing it, and is ignored.
 * A lease from another host is kept, because its process's liveness cannot be read from here.
 */
export async function readLiveLeases(dataRoot: PathBuilderLike): Promise<SelectionLease[]> {
	return (await readLeases(dataRoot)).live
}

/**
 * The live leases, and the paths of lease files whose process on this host no longer exists.
 */
async function readLeases(dataRoot: PathBuilderLike): Promise<{ live: SelectionLease[]; stale: string[] }> {
	const directory = catalogPaths(dataRoot).root("leases")
	let entries: Dirent[]

	try {
		entries = await Globerator.from("*.json", { cwd: directory, withFileTypes: true }).toArray()
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === "ENOENT") return { live: [], stale: [] }

		throw error
	}

	const here = hostName()
	const live: SelectionLease[] = []
	const stale: string[] = []

	for (const entry of entries) {
		const path = directory(entry.name).toString()
		const lease = await tryReadLocalJSONFile<SelectionLease>(path).catch(() => null)

		if (!lease) continue

		if (lease.host === here && !processExists(lease.pid)) {
			stale.push(path)

			continue
		}

		live.push(lease)
	}

	return { live: live.toSorted((a, b) => a.generation - b.generation || a.pid - b.pid), stale }
}

/**
 * One installed artifact a prune would delete.
 */
export interface PruneCandidate {
	installationID: LayerInstallationID
	artifactID: ArtifactID
	/**
	 * The artifact's directory, `db/<role>/<hex>/`.
	 */
	directory: string
	bytes: number
}

/**
 * What a prune would delete and what it keeps, read from one selection snapshot.
 */
export interface PrunePlan {
	dataRoot: string
	generation: number | null
	/**
	 * The generations whose artifacts are kept: the retained ones and the ones live leases hold.
	 */
	retainedGenerations: number[]
	leases: SelectionLease[]
	candidates: PruneCandidate[]
	reclaimableBytes: number
	/**
	 * Installed artifacts kept, with the generations that reference each.
	 */
	kept: Array<{ artifactID: ArtifactID; generations: number[] }>
}

function artifactKey(installationID: string, artifactID: string): string {
	return `${installationID}|${artifactID}`
}

/**
 * The history record of a generation the plan keeps.
 *
 * The plan keeps the artifacts a kept generation's record selects.
 * A record that is missing, unparsable or without an entries list stops the plan,
 * because reading it as empty would list that generation's artifacts for deletion.
 *
 * @throws When the record is missing, cannot be read or parsed, or has no `entries` array.
 */
async function readRetainedGeneration(dataRoot: string, generation: number): Promise<ActiveSelection> {
	const path = catalogPaths(dataRoot).selectionHistory(`${generation}.json`).toString()
	let record: ActiveSelection | null

	try {
		record = await tryReadLocalJSONFile<ActiveSelection>(path)
	} catch (error) {
		throw new Error(`prune refused: generation ${generation}'s record ${path} cannot be read`, { cause: error })
	}

	if (!record) {
		throw new Error(`prune refused: generation ${generation} is retained, but its record ${path} is missing`)
	}

	if (!Array.isArray(record.entries)) {
		throw new TypeError(`prune refused: generation ${generation}'s record ${path} has no entries list`)
	}

	return record
}

/**
 * The number of generations a prune keeps, refused unless it is a positive safe integer.
 *
 * @throws When `retain` is not a whole number from 1 to `Number.MAX_SAFE_INTEGER`.
 */
function assertRetainCount(retain: number): number {
	if (!Number.isSafeInteger(retain) || retain < 1) {
		throw new RangeError(`retain must be a positive whole number of generations, got ${String(retain)}`)
	}

	return retain
}

/**
 * Refuse a candidate list that names an artifact the active selection reads.
 *
 * This holds whatever the retain count and the plan say, so a plan built from a bad count
 * or altered after planning cannot delete the active generation's files.
 */
function assertActiveArtifactsKept(selection: ActiveSelection | null, candidates: readonly PruneCandidate[]): void {
	if (!selection) return

	const active = new Set(selection.entries.flatMap((entry) => entry.order.map((source) => source.artifactID)))

	for (const candidate of candidates) {
		if (active.has(candidate.artifactID)) {
			throw new Error(
				`prune refused: the active generation ${selection.generation} selects ${candidate.artifactID}, which the plan lists for deletion at ${candidate.directory}`
			)
		}
	}
}

/**
 * Plan a prune without deleting anything.
 *
 * @param options.retain The number of generations to keep, counting the active one.
 * A positive whole number.
 * @throws When `retain` is not a positive safe integer, or when a selection,
 * installation, manifest or lease record cannot be read.
 */
export async function planPrune(dataRoot: PathBuilderLike, options: { retain?: number } = {}): Promise<PrunePlan> {
	const root = resolvePath(dataRoot.toString())
	const retain = assertRetainCount(options.retain ?? DEFAULT_RETAINED_GENERATIONS)
	const selection = await readActiveSelection(root)
	const leases = await readLiveLeases(root)
	const generations = new Set<number>()

	if (selection) {
		for (
			let generation = selection.generation;
			generation > selection.generation - retain && generation > 0;
			generation--
		) {
			generations.add(generation)
		}
	}

	for (const lease of leases) {
		generations.add(lease.generation)
	}

	if (selection && !generations.has(selection.generation)) {
		throw new Error(`prune refused: the plan does not retain the active generation ${selection.generation}`)
	}

	const referencedBy = new Map<string, number[]>()

	for (const generation of generations) {
		const record = generation === selection?.generation ? selection : await readRetainedGeneration(root, generation)

		for (const entry of record.entries) {
			for (const source of entry.order) {
				const key = artifactKey(source.installationID, source.artifactID)

				referencedBy.set(key, [...(referencedBy.get(key) ?? []), generation])
			}
		}
	}

	const candidates: PruneCandidate[] = []
	const kept: PrunePlan["kept"] = []

	for (const copy of await readInstalledCopies(root)) {
		const references = referencedBy.get(artifactKey(copy.installationID, copy.artifactID))
		// An artifact shared by two installations is kept while either reference survives.
		const sharedReference = [...referencedBy.keys()].some((key) => key.endsWith(`|${copy.artifactID}`))

		if (references?.length || sharedReference) {
			kept.push({ artifactID: copy.artifactID, generations: references ?? [] })

			continue
		}

		candidates.push({
			installationID: copy.installationID,
			artifactID: copy.artifactID,
			directory: resolvePath(copy.path, ".."),
			bytes: copy.manifest.bytes,
		})
	}

	assertActiveArtifactsKept(selection, candidates)

	return {
		dataRoot: root,
		generation: selection?.generation ?? null,
		retainedGenerations: [...generations].toSorted((a, b) => a - b),
		leases,
		candidates,
		reclaimableBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
		kept,
	}
}

/**
 * Delete what a plan lists, after checking that the selection and the leases it read have not changed.
 *
 * An installation record whose every artifact is deleted is removed with them.
 *
 * @throws When another installer holds a lock, when the selection generation
 * or the live leases differ from the plan's, or when the plan lists an artifact the
 * active generation selects, before any file is deleted.
 */
export async function executePrune(plan: PrunePlan): Promise<{ deleted: PruneCandidate[]; reclaimedBytes: number }> {
	const paths = catalogPaths(plan.dataRoot)

	await using _installer = await acquireDirectoryLock(
		paths.installLock,
		() => `an installer is running under ${plan.dataRoot}; run the prune again once it finishes`
	)

	await using _selection = await acquireDirectoryLock(
		paths.lock,
		() => `a selection replacement is running under ${plan.dataRoot}; run the prune again once it finishes`
	)

	const current = await readActiveSelection(plan.dataRoot)
	const { live: leases, stale } = await readLeases(plan.dataRoot)

	if ((current?.generation ?? null) !== plan.generation) {
		throw new Error(
			`prune refused: the selection moved from generation ${plan.generation ?? "none"} to ${current?.generation ?? "none"} after planning; plan again`
		)
	}

	if (stringifyJSON(leases) !== stringifyJSON(plan.leases)) {
		throw new Error("prune refused: the sessions holding generations changed after planning; plan again")
	}

	assertActiveArtifactsKept(current, plan.candidates)

	// A lease left by a process that exited keeps no generation, so its file is removed.
	for (const path of stale) {
		await removePathIfPresent(path)
	}

	const deleted: PruneCandidate[] = []

	for (const candidate of plan.candidates) {
		if (!(await tryStat(candidate.directory))) continue

		await removePath(candidate.directory)
		deleted.push(candidate)
	}

	const gone = new Set(deleted.map((candidate) => artifactKey(candidate.installationID, candidate.artifactID)))

	for (const installation of await readInstallations(plan.dataRoot)) {
		if (installation.artifacts.every((artifact) => gone.has(artifactKey(installation.id, artifact.artifactID)))) {
			await removePathIfPresent(PathBuilder.from(paths.installations)(`${installation.id}.json`))
		}
	}

	return { deleted, reclaimedBytes: deleted.reduce((sum, candidate) => sum + candidate.bytes, 0) }
}
