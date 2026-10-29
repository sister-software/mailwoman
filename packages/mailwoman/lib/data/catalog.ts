/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The installed-layer catalog: where installations live under a data root, the active selection, and
 *   its atomic replacement.
 *
 *   Layout under the data root:
 *
 *   - `db/<role>/<sha256 hex>/` holds one immutable artifact, its `manifest.json` and the `receipt.json` of how it
 *     was acquired.
 *   - `installations/<installation id>.json` records one installation: an artifact set and its origin.
 *   - `active.json` is the active selection. It lists the installed artifacts each role reads, per scope, in order.
 *   - `selections/<generation>.json` keeps every generation written, so a rollback can restore the one before.
 *   - `.active.lock/` is held while a writer replaces the selection, and `.install.lock/` for a whole installation.
 *
 *   A file under `db/` is selected only when `active.json` names it. Readers that find no entry for their role
 *   and scope keep today's resolution through the conventional paths and `releases.json`, so a data root
 *   without `active.json` behaves exactly as before.
 *
 *   The catalog reads records and checks that each selected file exists with its recorded size. It opens no
 *   database: each role's provider opens and disposes its own handles.
 */

import { acquireDirectoryLock } from "@mailwoman/core/fs/lock"
import type { Dirent } from "@mailwoman/core/fs/readers"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { movePath, stagingSiblingPath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { JSONParseError } from "@mailwoman/core/json"
import {
	type ActiveSelection,
	ACTIVE_SELECTION_FORMAT,
	ActiveSelectionError,
	activeSelectionProblems,
	type ArtifactID,
	type ArtifactManifest,
	artifactManifestProblems,
	assertActiveSelection,
	assertSelectionSuccessor,
	type LayerInstallation,
	type LayerInstallationID,
	type SelectedSource,
	selectedSources,
	type SelectionEntry,
	type SelectionScope,
	type ServingRole,
	type UncheckedActiveSelection,
	UnreadableArtifactError,
	UnreadableReason,
} from "@mailwoman/core/layers"
import { PathBuilder, type PathBuilderLike, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * The paths of the catalog's records under one data root.
 */
export function catalogPaths(dataRoot: PathBuilderLike) {
	const root = PathBuilder.from(resolvePath(dataRoot.toString()))

	return {
		root,
		activeSelection: root("active.json"),
		selectionHistory: root("selections"),
		installations: root("installations"),
		lock: root(".active.lock"),
		/**
		 * Held by `executeInstallation` for a whole run.
		 */
		installLock: root(".install.lock"),
		acquisitions: root("tmp", "acquire"),
		/**
		 * The directory that holds one artifact, `db/<role>/<hex>/`.
		 */
		artifactDirectory: (role: ServingRole, artifactID: ArtifactID) =>
			root("db", role, artifactID.slice("sha256:".length)),
	}
}

/**
 * Read a JSON record, separating an absent file from one that cannot be read or parsed.
 *
 * @returns Null when the file does not exist.
 * @throws {@link UnreadableArtifactError} naming the file when it exists and cannot be read or parsed.
 */
async function readRecord<T>(path: PathBuilderLike): Promise<T | null> {
	try {
		return await tryReadLocalJSONFile<T>(path)
	} catch (error) {
		const reason = error instanceof JSONParseError ? UnreadableReason.Corrupt : UnreadableReason.Unopenable

		throw new UnreadableArtifactError(path.toString(), reason, (error as Error).message, { cause: error })
	}
}

/**
 * Write a JSON record so a reader sees the old record or the new one, never a partial one.
 *
 * The record is written beside its destination and renamed over it, on the destination's filesystem.
 */
export async function writeRecordAtomically(record: unknown, destination: PathBuilderLike): Promise<void> {
	const staging = stagingSiblingPath(destination)

	await writeLocalJSONFile(record as Record<string, unknown>, staging)
	await movePath(staging, destination)
}

/**
 * The installation records under the data root.
 *
 * @throws {@link UnreadableArtifactError} when a record exists and cannot be read
 * or parsed, or the directory exists and cannot be listed.
 */
export async function readInstallations(dataRoot: PathBuilderLike): Promise<LayerInstallation[]> {
	const directory = catalogPaths(dataRoot).installations
	let entries: Dirent[]

	try {
		entries = await Globerator.from("*.json", { cwd: directory, withFileTypes: true }).toArray()
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === "ENOENT") return []

		throw new UnreadableArtifactError(directory.toString(), UnreadableReason.Unopenable, (error as Error).message, {
			cause: error,
		})
	}

	const installations: LayerInstallation[] = []

	for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
		const record = await readRecord<LayerInstallation>(directory(entry.name))

		if (record) {
			installations.push(record)
		}
	}

	return installations
}

/**
 * Record an installation.
 *
 * The record is immutable once written, so an existing one is left as it is.
 */
export async function writeInstallation(dataRoot: PathBuilderLike, installation: LayerInstallation): Promise<void> {
	const destination = catalogPaths(dataRoot).installations(`${installation.id}.json`)

	if (await tryStat(destination)) return

	await writeRecordAtomically(installation, destination)
}

/**
 * Read and validate an installed artifact's manifest from its directory.
 *
 * @returns Null when the directory holds no manifest.
 * @throws {@link UnreadableArtifactError} when the manifest cannot be read or lacks required metadata.
 */
export async function readInstalledManifest(directory: PathBuilderLike): Promise<ArtifactManifest | null> {
	const path = PathBuilder.from(directory)("manifest.json")
	const manifest = await readRecord<ArtifactManifest>(path)

	if (!manifest) return null

	const problems = artifactManifestProblems(manifest)

	if (problems.length) {
		throw new UnreadableArtifactError(path.toString(), UnreadableReason.Unmanifested, problems.join("; "))
	}

	return manifest
}

/**
 * Read the active selection under the data root.
 *
 * @returns Null when no selection has been written.
 * @throws {@link UnreadableArtifactError} when `active.json` exists and cannot be read, parsed or validated.
 */
export async function readActiveSelection(dataRoot: PathBuilderLike): Promise<ActiveSelection | null> {
	return readSelectionAt(catalogPaths(dataRoot).activeSelection)
}

async function readSelectionAt(path: PathBuilderLike): Promise<ActiveSelection | null> {
	const selection = await readRecord<UncheckedActiveSelection>(path)

	if (!selection) return null

	const problems = activeSelectionProblems(selection)

	if (problems.length) {
		const reason =
			selection.format === ACTIVE_SELECTION_FORMAT ? UnreadableReason.Corrupt : UnreadableReason.Unsupported

		throw new UnreadableArtifactError(path.toString(), reason, problems.join("; "))
	}

	return selection as ActiveSelection
}

/**
 * One selected artifact resolved to its file.
 */
export interface ResolvedSource {
	source: SelectedSource
	/**
	 * The absolute path of the artifact's file.
	 */
	path: string
	manifest: ArtifactManifest
}

/**
 * One reading of the catalog: one selection generation and the installations it names.
 *
 * A reader takes one snapshot and keeps it until it reloads, so every lookup
 * in a session reads the same generation.
 */
export class LayerCatalog {
	readonly dataRoot: string
	readonly selection: ActiveSelection | null
	readonly installations: ReadonlyMap<LayerInstallationID, LayerInstallation>
	readonly #manifests = new Map<string, ArtifactManifest | null>()

	private constructor(dataRoot: string, selection: ActiveSelection | null, installations: LayerInstallation[]) {
		this.dataRoot = dataRoot
		this.selection = selection
		this.installations = new Map(installations.map((installation) => [installation.id, installation]))
	}

	/**
	 * Read the active selection and the installation records once.
	 *
	 * @throws {@link UnreadableArtifactError} when a record exists and cannot be read.
	 */
	static async read(dataRoot: PathBuilderLike): Promise<LayerCatalog> {
		const root = resolvePath(dataRoot.toString())
		const selection = await readActiveSelection(root)
		const installations = selection ? await readInstallations(root) : []

		return new LayerCatalog(root, selection, installations)
	}

	/**
	 * A snapshot with no selection, which resolves every role to its conventional path,
	 * as a data root read before the selection existed does.
	 */
	static empty(dataRoot: PathBuilderLike): LayerCatalog {
		return new LayerCatalog(resolvePath(dataRoot.toString()), null, [])
	}

	/**
	 * The generation this snapshot read, or `null` when the data root has no selection.
	 */
	get generation(): number | null {
		return this.selection?.generation ?? null
	}

	/**
	 * The selected sources for a role and scope, in order, each resolved to its file.
	 *
	 * A source whose installation record or file is missing is absent, and the next one is consulted.
	 * A file present with a size other than its manifest records, or a manifest that
	 * cannot be read, is unreadable and raises an error.
	 *
	 * @throws {@link UnreadableArtifactError} naming the artifact's path.
	 */
	async resolve(role: ServingRole, scope: SelectionScope): Promise<ResolvedSource[]> {
		if (!this.selection) return []

		const resolved: ResolvedSource[] = []

		for (const source of selectedSources(this.selection, role, scope)) {
			const found = await this.#resolveSource(source)

			if (found) {
				resolved.push(found)
			}
		}

		return resolved
	}

	/**
	 * The first selected source's file for a role and scope, or `null` when none is installed.
	 *
	 * @throws {@link UnreadableArtifactError} when the first installed source is unreadable.
	 */
	async firstPath(role: ServingRole, scope: SelectionScope): Promise<string | null> {
		if (!this.selection) return null

		for (const source of selectedSources(this.selection, role, scope)) {
			const found = await this.#resolveSource(source)

			if (found) return found.path
		}

		return null
	}

	async #resolveSource(source: SelectedSource): Promise<ResolvedSource | null> {
		const installation = this.installations.get(source.installationID)
		const artifact = installation?.artifacts.find((candidate) => candidate.artifactID === source.artifactID)

		if (!artifact) return null

		const path = resolvePath(this.dataRoot, artifact.path)
		const stats = await tryStat(path)

		if (!stats) return null

		const directory = resolvePath(path, "..")
		let manifest = this.#manifests.get(directory)

		if (manifest === undefined) {
			manifest = await readInstalledManifest(directory)
			this.#manifests.set(directory, manifest)
		}

		if (!manifest) {
			throw new UnreadableArtifactError(path, UnreadableReason.Unmanifested, "the artifact directory holds no manifest")
		}

		if (manifest.id !== source.artifactID) {
			throw new UnreadableArtifactError(
				path,
				UnreadableReason.Corrupt,
				`the manifest records ${manifest.id} and the selection names ${source.artifactID}`
			)
		}

		if (stats.size !== manifest.bytes) {
			throw new UnreadableArtifactError(
				path,
				UnreadableReason.Corrupt,
				`${stats.size} bytes on disk, and the manifest records ${manifest.bytes}`
			)
		}

		return { source, path, manifest }
	}
}

/**
 * A change to the active selection: the entries to set, keyed by role and scope.
 */
export interface SelectionChange {
	/**
	 * The generation the writer read before planning, or `null` when it read no selection.
	 *
	 * The replacement is refused when the selection on disk has moved past it.
	 */
	basedOn: number | null
	/**
	 * Entries that replace the entry of the same role and scope, or are added when none exists.
	 */
	set: readonly SelectionEntry[]
	/**
	 * Replace the whole entry list with {@link set} rather than merging into it, as a rollback does.
	 */
	replaceAll?: boolean
}

function entryKey(entry: Pick<SelectionEntry, "role" | "scope">): string {
	return `${entry.role}|${entry.scope.country ?? "*"}|${entry.scope.subdivision ?? "*"}`
}

/**
 * The entries of `current` with each entry of `set` replacing the one of its role and scope.
 */
export function mergeSelectionEntries(
	current: readonly SelectionEntry[],
	set: readonly SelectionEntry[]
): SelectionEntry[] {
	const merged = new Map(current.map((entry) => [entryKey(entry), entry]))

	for (const entry of set) {
		merged.set(entryKey(entry), entry)
	}

	return [...merged.values()]
}

/**
 * Check that every source a selection names resolves to an installed file with its recorded size.
 *
 * @throws {@link ActiveSelectionError} listing every source that does not.
 */
async function assertSelectedFilesInstalled(
	dataRoot: string,
	selection: ActiveSelection,
	installations: readonly LayerInstallation[]
): Promise<void> {
	const byID = new Map(installations.map((installation) => [installation.id, installation]))
	const problems: string[] = []

	for (const entry of selection.entries) {
		for (const source of entry.order) {
			const artifact = byID.get(source.installationID)?.artifacts.find((a) => a.artifactID === source.artifactID)

			if (!artifact) continue

			const path = resolvePath(dataRoot, artifact.path)
			const stats = await tryStat(path)
			const manifest = await readInstalledManifest(resolvePath(path, "..")).catch(() => null)

			if (!stats) {
				problems.push(`${source.artifactID} is not on disk at ${path}`)
			} else if (!manifest || manifest.id !== source.artifactID || manifest.bytes !== stats.size) {
				problems.push(`${source.artifactID} at ${path} does not match its manifest`)
			}
		}
	}

	if (problems.length) throw new ActiveSelectionError("selection replacement", problems)
}

/**
 * Replace the active selection with one more generation, atomically.
 *
 * The writer holds the selection lock, reads the generation on disk, and refuses when it differs from
 * {@link SelectionChange.basedOn}: another writer replaced the selection after this one planned.
 * The replacement is validated completely, including every selected file, before the rename.
 *
 * The generation is also kept under `selections/` for rollback.
 * A failure at any step leaves the previous `active.json` in place.
 *
 * @throws {@link ActiveSelectionError} when the replacement is refused or invalid.
 */
export async function replaceActiveSelection(
	dataRoot: PathBuilderLike,
	change: SelectionChange,
	now: () => Date = () => new Date()
): Promise<ActiveSelection> {
	const root = resolvePath(dataRoot.toString())
	const paths = catalogPaths(root)

	await using _lock = await acquireDirectoryLock(
		paths.lock,
		(held) =>
			`another installer holds the selection lock ${paths.lock}` +
			(held ? ` (pid ${held.pid} on ${held.host} since ${held.started_at})` : "") +
			"; wait for it to finish and run the command again"
	)

	const current = await readActiveSelection(root)

	if ((current?.generation ?? null) !== change.basedOn) {
		throw new ActiveSelectionError("selection replacement", [
			`the selection moved to generation ${current?.generation ?? "none"} after this plan read ${change.basedOn ?? "none"}; plan again`,
		])
	}

	const next: ActiveSelection = {
		format: ACTIVE_SELECTION_FORMAT,
		generation: (current?.generation ?? 0) + 1,
		previousGeneration: current?.generation ?? null,
		createdAt: now().toISOString(),
		entries: change.replaceAll ? [...change.set] : mergeSelectionEntries(current?.entries ?? [], change.set),
	}

	assertSelectionSuccessor(current, next)

	const installations = await readInstallations(root)

	assertActiveSelection(next, installations)
	await assertSelectedFilesInstalled(root, next, installations)

	await writeRecordAtomically(next, paths.selectionHistory(`${next.generation}.json`))
	await writeRecordAtomically(next, paths.activeSelection)

	return next
}

/**
 * Select every artifact of one installed installation for the role and scope
 * its manifest records, as a new generation.
 *
 * An entry of the same role and scope is replaced.
 * Other entries are kept.
 *
 * @throws {@link ActiveSelectionError} when the installation is not installed
 * or an artifact fails validation.
 */
export async function activateInstallation(
	dataRoot: PathBuilderLike,
	installationID: LayerInstallationID,
	now: () => Date = () => new Date()
): Promise<ActiveSelection> {
	const root = resolvePath(dataRoot.toString())
	const installation = (await readInstallations(root)).find((candidate) => candidate.id === installationID)

	if (!installation) {
		throw new ActiveSelectionError("activation", [`installation ${installationID} is not installed under ${root}`])
	}

	const set: SelectionEntry[] = []

	for (const artifact of installation.artifacts) {
		const manifest = await readInstalledManifest(resolvePath(root, artifact.path, ".."))

		if (!manifest) {
			throw new ActiveSelectionError("activation", [`${artifact.path} has no manifest`])
		}

		const subdivision = manifest.scope.subdivisions?.[0] ?? null

		const country = subdivision
			? subdivision.slice(0, 2)
			: manifest.scope.countries.length === 1
				? (manifest.scope.countries[0] ?? null)
				: null

		set.push({
			role: manifest.role,
			scope: { country, subdivision },
			order: [{ installationID, artifactID: artifact.artifactID }],
		})
	}

	const current = await readActiveSelection(root)

	return replaceActiveSelection(root, { basedOn: current?.generation ?? null, set }, now)
}

/**
 * Restore the generation the active selection replaced, as a new generation.
 *
 * @throws {@link ActiveSelectionError} when there is no earlier generation,
 * its record is missing, or one of its artifacts is no longer installed.
 */
export async function rollbackActiveSelection(
	dataRoot: PathBuilderLike,
	now: () => Date = () => new Date()
): Promise<ActiveSelection> {
	const root = resolvePath(dataRoot.toString())
	const current = await readActiveSelection(root)

	if (!current?.previousGeneration) {
		throw new ActiveSelectionError("rollback", [
			current ? `generation ${current.generation} replaced no earlier generation` : "no selection has been written",
		])
	}

	const previous = await readSelectionAt(catalogPaths(root).selectionHistory(`${current.previousGeneration}.json`))

	if (!previous) {
		throw new ActiveSelectionError("rollback", [
			`generation ${current.previousGeneration} is not retained under ${catalogPaths(root).selectionHistory}`,
		])
	}

	// Entries the previous generation lacked are cleared by restoring its list whole.
	return replaceActiveSelection(root, { basedOn: current.generation, set: previous.entries, replaceAll: true }, now)
}
