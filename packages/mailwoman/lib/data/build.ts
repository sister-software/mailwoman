/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Plans and runs a source build through the installer: acquire the recipe's inputs, build, validate,
 *   install and, when asked, activate.
 *
 *   The sequence matches `data pull`. The plan is read without a network request or a write. Acquisition
 *   stages each input under `tmp/acquire/` with a receipt and resumes a partial transfer only when the remote
 *   identity still matches, then keeps the verified file under `src/<source>/<name>/<release>/`. An input
 *   already kept there with the same remote identity and digest is reused, so one regional extract serves
 *   every country derived from it, in one run or the next.
 *
 *   The build writes into `derived/<recipe>/<build id>/`. The build id is a digest of the recipe, each
 *   output's policy version and the digests of its inputs, so a changed input or policy builds again
 *   instead of reusing an earlier extraction. Each output is validated, hashed and moved into
 *   `db/<role>/<sha256>/` like a download, and the build's own record stays in the derived directory.
 *
 *   Activation adds each built artifact to its country's selection entry after the sources the entry
 *   already lists from other providers, replacing only the sources an earlier run of the same recipe added.
 *   A national register selected for a country therefore stays first.
 */

import type { APIClient } from "@mailwoman/core/api"
import { acquireDirectoryLock } from "@mailwoman/core/fs/lock"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File, sha256File, sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"
import {
	type AcquiredBuildInput,
	type ArtifactManifest,
	artifactIDFromSHA256,
	artifactSetID,
	assertArtifactManifest,
	type BuildInput,
	type BuildOutput,
	type BuildPlan,
	type BuildPrerequisite,
	type BuildRecipe,
	type BuildRequest,
	type LayerInstallation,
	layerInstallationID,
	readerIncompatibility,
	type SelectedSource,
	type SelectionEntry,
} from "@mailwoman/core/layers"
import { isoDate } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike, relative, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { acquireRemoteObject, acquisitionDirectory, readRemoteIdentity, type RemoteIdentity } from "#data/acquire"
import {
	catalogPaths,
	readActiveSelection,
	readInstallations,
	readInstalledManifest,
	replaceActiveSelection,
	writeInstallation,
	writeRecordAtomically,
} from "#data/catalog"
import { placeArtifact, readerCompatibility } from "#data/install"
import { ProblemKind } from "#data/plan"
import { AccessRequirement, AvailabilityKind, type AvailableDataEntry } from "#data/registry"

/**
 * The paths a build reads and writes under the data root.
 */
export function buildPaths(dataRoot: PathBuilderLike) {
	const root = PathBuilder.from(resolvePath(dataRoot.toString()))

	return {
		/**
		 * `src/<source>/<name>/`, which holds one directory per release of an input.
		 */
		inputDirectory: (input: BuildInput) => root("src", input.source, ...input.name.split("/")),
		/**
		 * `derived/<recipe>/<build id>/`.
		 */
		buildDirectory: (recipe: string, buildID: string) => root("derived", recipe, buildID),
	}
}

/**
 * The record kept beside an input under `src/`: the transfer that brought it and its digests.
 */
export interface InputReceipt {
	input: BuildInput
	url: string
	remote: RemoteIdentity
	release: string | null
	sha256: string
	md5: string
	bytes: number
	acquiredAt: string
}

/**
 * One input in a plan: acquired already, or still to download.
 */
export interface PlannedInput {
	input: BuildInput
	/**
	 * The kept copy found under `src/`, verified again before it is used, or `null` when none is kept.
	 */
	kept: InputReceipt | null
	/**
	 * Where the input is kept once acquired.
	 */
	destination: string
}

/**
 * What a build would do, read without a network request or a write.
 */
export interface BuildReport {
	dataRoot: string
	plan: BuildPlan
	prerequisites: BuildPrerequisite[]
	inputs: PlannedInput[]
	/**
	 * The generation the plan read, or `null` when the data root has no selection.
	 */
	generation: number | null
	problems: Array<{ kind: ProblemKind; detail: string }>
}

/**
 * A recipe as an available-data registry entry: what it builds and where, with no download.
 */
export function availableBuildEntry(recipe: BuildRecipe): AvailableDataEntry {
	const plan = recipe.plan({ countries: recipe.countries(), region: null })

	return {
		name: recipe.name,
		kind: AvailabilityKind.Build,
		capabilities: [...new Set(plan.outputs.map((output) => output.role))],
		countries: recipe.countries(),
		subdivisions: null,
		dependencies: [],
		access: AccessRequirement.Public,
		license: [...new Set(plan.inputs.map((input) => input.license))].join(" AND "),
		artifacts: [],
		recipe: recipe.name,
		activation: "selection",
	}
}

function releaseDirectoryName(release: string | null, sha256: string): string {
	return release ?? `unreleased-${sha256.slice(0, 12)}`
}

/**
 * Every receipt kept for an input under `src/`, newest release first.
 */
async function keptReceipts(dataRoot: PathBuilderLike, input: BuildInput): Promise<InputReceipt[]> {
	const directory = buildPaths(dataRoot).inputDirectory(input)

	if (!(await tryStat(directory))) return []

	const names = await Globerator.from("*/receipt.json", { cwd: directory, absolute: false }).toArray()
	const receipts: InputReceipt[] = []

	for (const name of names.toSorted().toReversed()) {
		const receipt = await tryReadLocalJSONFile<InputReceipt>(directory(name))

		if (receipt?.input.fileName === input.fileName) {
			receipts.push(receipt)
		}
	}

	return receipts
}

/**
 * Plan a build: the recipe's plan, its prerequisites, and which inputs are kept already.
 *
 * Reads no network and writes no file.
 */
export async function planBuild(
	dataRoot: PathBuilderLike,
	recipe: BuildRecipe,
	request: BuildRequest
): Promise<BuildReport> {
	const root = resolvePath(dataRoot.toString())
	const plan = recipe.plan(request)
	const prerequisites = await recipe.prerequisites()
	const problems: BuildReport["problems"] = plan.problems.map((detail) => ({ kind: ProblemKind.Unavailable, detail }))

	for (const prerequisite of prerequisites) {
		if (!prerequisite.satisfied) {
			problems.push({ kind: ProblemKind.MissingDependency, detail: `${prerequisite.name}: ${prerequisite.detail}` })
		}
	}

	const inputs: PlannedInput[] = []

	for (const input of plan.inputs) {
		const [kept] = await keptReceipts(root, input)

		inputs.push({
			input,
			kept: kept ?? null,
			destination: buildPaths(root).inputDirectory(input)("<release>", input.fileName).toString(),
		})
	}

	return {
		dataRoot: root,
		plan,
		prerequisites,
		inputs,
		generation: (await readActiveSelection(root))?.generation ?? null,
		problems,
	}
}

/**
 * One output a build installed.
 */
export interface BuiltOutput {
	output: BuildOutput
	path: string
	manifest: ArtifactManifest
	/**
	 * Whether the output came from an earlier run's extraction rather than this one.
	 */
	reused: boolean
}

/**
 * What a build did.
 */
export interface BuildResult {
	buildID: string
	inputs: Array<{ input: BuildInput; path: string; sha256: string; reused: boolean; restartReason: string | null }>
	outputs: BuiltOutput[]
	installation: LayerInstallation
	/**
	 * The generation the build activated, or `null` when it did not activate.
	 */
	activatedGeneration: number | null
}

/**
 * Options for {@link executeBuild}.
 */
export interface ExecuteBuildOptions {
	client: APIClient
	/**
	 * The builder's identity, recorded in each manifest, such as `mailwoman@<version>`.
	 */
	builderSHA: string
	/**
	 * Select every built artifact after it installs.
	 */
	activate: boolean
	signal?: AbortSignal
	onProgress?: (message: string) => void
	now?: () => Date
}

/**
 * A build that cannot start, with every reason.
 */
export class BuildRefusedError extends Error {
	readonly problems: BuildReport["problems"]

	constructor(problems: BuildReport["problems"]) {
		super(`the build cannot start: ${problems.map((problem) => problem.detail).join("; ")}`)
		this.name = "BuildRefusedError"
		this.problems = problems
	}
}

/**
 * Whether a kept input still has the remote identity and the bytes its receipt recorded.
 */
async function keptInputMatches(
	dataRoot: string,
	receipt: InputReceipt,
	remote: RemoteIdentity
): Promise<string | null> {
	const path = buildPaths(dataRoot)
		.inputDirectory(receipt.input)(releaseDirectoryName(receipt.release, receipt.sha256), receipt.input.fileName)
		.toString()

	const sameRemote =
		receipt.remote.etag === remote.etag &&
		receipt.remote.lastModified === remote.lastModified &&
		receipt.remote.contentLength === remote.contentLength

	if (!sameRemote) return null

	if ((await tryStat(path))?.size !== receipt.bytes) return null

	return (await sha256File(path)) === receipt.sha256 ? path : null
}

/**
 * The URL an input's bytes are transferred from, reading its metadata document
 * when the input locates it there.
 */
async function downloadURLOf(client: APIClient, input: BuildInput): Promise<string> {
	if (!input.locate) return input.url

	const response = await client.fetch<Record<string, unknown>>({
		method: "get",
		url: input.url,
		responseType: "json",
		cache: false,
	})

	const located = response.data?.[input.locate.field]

	if (typeof located !== "string" || !located) {
		throw new Error(`${input.url} states no ${input.locate.field} for ${input.name}`)
	}

	return new URL(located, input.url).toString()
}

/**
 * The `YYYY-MM-DD` date of a `Last-Modified` header, or `null`.
 */
function releaseOf(remote: RemoteIdentity): string | null {
	const date = remote.lastModified ? new Date(remote.lastModified) : null

	return date && Number.isFinite(date.getTime()) ? isoDate(date) : null
}

async function acquireInput(
	dataRoot: string,
	input: BuildInput,
	options: ExecuteBuildOptions
): Promise<BuildResult["inputs"][number] & { acquired: AcquiredBuildInput }> {
	const url = await downloadURLOf(options.client, input)
	const remote = await readRemoteIdentity(options.client, url, input.md5Sidecar)

	for (const receipt of await keptReceipts(dataRoot, input)) {
		const path = receipt.url === url ? await keptInputMatches(dataRoot, receipt, remote) : null

		if (path) {
			options.onProgress?.(`reusing ${input.name} (${receipt.release ?? "no release date"}) at ${path}`)

			return {
				input,
				path,
				sha256: receipt.sha256,
				reused: true,
				restartReason: null,
				acquired: { input, path, sha256: receipt.sha256, md5: receipt.md5, release: receipt.release, url },
			}
		}
	}

	const acquired = await acquireRemoteObject({
		dataRoot,
		remotePath: input.name,
		identity: remote,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
		...(options.now ? { now: options.now } : {}),
	})

	const sha256 = await sha256File(acquired.path)
	const md5 = await md5File(acquired.path)
	const release = releaseOf(remote)
	const directory = buildPaths(dataRoot).inputDirectory(input)(releaseDirectoryName(release, sha256))
	const path = directory(input.fileName).toString()

	await makeDirectories(directory)
	await movePath(acquired.path, path)

	const receipt: InputReceipt = {
		input,
		url,
		remote,
		release,
		sha256,
		md5,
		bytes: acquired.bytes,
		acquiredAt: (options.now?.() ?? new Date()).toISOString(),
	}

	await writeRecordAtomically(receipt, directory("receipt.json"))
	await writeRecordAtomically(acquired.receipt, directory("transfer.json"))
	await removePathIfPresent(acquisitionDirectory(dataRoot, url))

	return {
		input,
		path,
		sha256,
		reused: false,
		restartReason: acquired.restartReason,
		acquired: { input, path, sha256, md5, release, url },
	}
}

/**
 * The record a completed build keeps in its derived directory.
 */
interface BuildRecord {
	recipe: string
	buildID: string
	inputs: Array<{ key: string; sha256: string; release: string | null; url: string }>
	outputs: Array<{ country: string; fileName: string; manifest: ArtifactManifest }>
	builtAt: string
}

/**
 * The identity of a build from these inputs under these policies.
 */
export function buildIdentity(
	plan: BuildPlan,
	inputs: ReadonlyMap<string, AcquiredBuildInput>,
	builderSHA: string
): string {
	return sha256Hex(
		canonicalJSON({
			recipe: plan.recipe,
			builderSHA,
			outputs: plan.outputs.map((output) => ({
				country: output.country,
				fileName: output.fileName,
				policy: output.policy,
				inputs: output.inputs.map((key) => inputs.get(key)?.sha256 ?? null),
			})),
		})
	).slice(0, 16)
}

/**
 * The selection entries that activate `installation`: each artifact appended to its country's entry
 * after the sources other recipes and publishers placed there, replacing the sources of this recipe.
 */
async function activationEntries(
	dataRoot: string,
	installation: LayerInstallation,
	outputs: readonly BuiltOutput[]
): Promise<SelectionEntry[]> {
	const current = await readActiveSelection(dataRoot)
	const installations = new Map((await readInstallations(dataRoot)).map((record) => [record.id, record]))
	const entries: SelectionEntry[] = []

	const recipeOf = async (source: SelectedSource): Promise<string | null> => {
		const artifact = installations
			.get(source.installationID)
			?.artifacts.find((candidate) => candidate.artifactID === source.artifactID)

		if (!artifact) return null

		return (await readInstalledManifest(resolvePath(dataRoot, artifact.path, "..")))?.recipe ?? null
	}

	for (const built of outputs) {
		const scope = { country: built.output.country, subdivision: null }

		const existing =
			current?.entries.find(
				(entry) =>
					entry.role === built.manifest.role && entry.scope.country === scope.country && !entry.scope.subdivision
			)?.order ?? []

		const kept: SelectedSource[] = []

		for (const source of existing) {
			if ((await recipeOf(source)) !== built.manifest.recipe) {
				kept.push(source)
			}
		}

		entries.push({
			role: built.manifest.role,
			scope,
			order: [...kept, { installationID: installation.id, artifactID: built.manifest.id }],
		})
	}

	return entries
}

/**
 * Run a planned build: acquire, build, validate, install and, when asked, activate.
 *
 * Refuses before any transfer when the plan has a problem or a prerequisite is missing.
 * A cancelled transfer or build keeps what was acquired and leaves the selection as it was.
 *
 * @throws {@link BuildRefusedError} when the build cannot start.
 * @throws `AcquisitionCancelledError` from `#data/acquire` when `options.signal` aborts a transfer.
 */
export async function executeBuild(
	report: BuildReport,
	recipe: BuildRecipe,
	options: ExecuteBuildOptions
): Promise<BuildResult> {
	if (report.problems.length) throw new BuildRefusedError(report.problems)

	const root = report.dataRoot
	const now = options.now ?? (() => new Date())
	const paths = catalogPaths(root)

	await makeDirectories(root)

	await using _lock = await acquireDirectoryLock(
		paths.installLock,
		(held) =>
			`another installer holds ${paths.installLock}` +
			(held ? ` (pid ${held.pid} on ${held.host} since ${held.started_at})` : "") +
			"; wait for it to finish and run the command again"
	)

	const acquired = new Map<string, AcquiredBuildInput>()
	const inputs: BuildResult["inputs"] = []

	for (const planned of report.inputs) {
		const result = await acquireInput(root, planned.input, options)

		acquired.set(planned.input.key, result.acquired)

		inputs.push({
			input: result.input,
			path: result.path,
			sha256: result.sha256,
			reused: result.reused,
			restartReason: result.restartReason,
		})
	}

	const buildID = buildIdentity(report.plan, acquired, options.builderSHA)
	const directory = buildPaths(root).buildDirectory(report.plan.recipe, buildID)
	const recorded = await tryReadLocalJSONFile<BuildRecord>(directory("build.json"))
	const outputs: BuiltOutput[] = []

	if (recorded && (await everyOutputInstalled(root, recorded))) {
		options.onProgress?.(
			`reusing build ${buildID}: its inputs and policies are unchanged and its outputs are installed`
		)

		for (const output of report.plan.outputs) {
			const entry = recorded.outputs.find((candidate) => candidate.country === output.country)!

			outputs.push({
				output,
				path: paths.artifactDirectory(entry.manifest.role, entry.manifest.id)(entry.fileName).toString(),
				manifest: entry.manifest,
				reused: true,
			})
		}
	} else {
		const staging = `${directory.toString()}.partial-${process.pid}`

		await removePathIfPresent(staging)
		await makeDirectories(staging)

		const createdAt = now().toISOString()

		try {
			const built = await recipe.build(report.plan, acquired, {
				directory: staging,
				builderSHA: options.builderSHA,
				createdAt,
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onProgress ? { onProgress: options.onProgress } : {}),
			})

			for (const artifact of built) {
				const stats = await tryStat(artifact.path)

				if (!stats) throw new Error(`${artifact.output.country}: the build wrote no file at ${artifact.path}`)

				const manifest = {
					...artifact.manifest,
					id: artifactIDFromSHA256(await sha256File(artifact.path)),
					bytes: stats.size,
					createdAt,
				}

				assertArtifactManifest(manifest, `${artifact.output.fileName} manifest`)

				const refusal = readerIncompatibility(manifest, readerCompatibility(manifest.role))

				if (refusal) throw new Error(`${artifact.output.fileName}: ${refusal}`)

				const path = await placeArtifact(root, artifact.path, artifact.output.fileName, manifest, {
					recipe: report.plan.recipe,
					buildID,
					inputs: artifact.output.inputs.map((key) => ({
						key,
						url: acquired.get(key)?.url ?? null,
						sha256: acquired.get(key)?.sha256 ?? null,
					})),
				})

				outputs.push({ output: artifact.output, path, manifest, reused: false })
			}
		} finally {
			await removePathIfPresent(staging)
		}

		const record: BuildRecord = {
			recipe: report.plan.recipe,
			buildID,
			inputs: [...acquired.entries()].map(([key, input]) => ({
				key,
				sha256: input.sha256,
				release: input.release,
				url: input.url,
			})),
			outputs: outputs.map((built) => ({
				country: built.output.country,
				fileName: built.output.fileName,
				manifest: built.manifest,
			})),
			builtAt: createdAt,
		}

		await writeRecordAtomically(record, directory("build.json"))
	}

	const members = outputs.map((built) => ({
		artifactID: built.manifest.id,
		role: built.manifest.role,
		schemaVersion: built.manifest.schemaVersion,
	}))

	const artifactSet = artifactSetID(members)
	const origin = { kind: "built" as const, recipe: report.plan.recipe, buildID }

	const installation: LayerInstallation = {
		id: layerInstallationID(artifactSet, origin),
		artifactSet,
		origin,
		artifacts: outputs.map((built) => ({
			artifactID: built.manifest.id,
			role: built.manifest.role,
			path: relative(root, built.path),
		})),
		installedAt: now().toISOString(),
	}

	await writeInstallation(root, installation)

	let activatedGeneration: number | null = null

	if (options.activate) {
		const selection = await replaceActiveSelection(root, {
			basedOn: report.generation,
			set: await activationEntries(root, installation, outputs),
		})

		activatedGeneration = selection.generation
	}

	return { buildID, inputs, outputs, installation, activatedGeneration }
}

async function everyOutputInstalled(dataRoot: string, record: BuildRecord): Promise<boolean> {
	const paths = catalogPaths(dataRoot)

	for (const output of record.outputs) {
		const directory = paths.artifactDirectory(output.manifest.role, output.manifest.id)
		const manifest = await readInstalledManifest(directory).catch(() => null)
		const stats = await tryStat(directory(output.fileName))

		if (manifest?.id !== output.manifest.id || stats?.size !== output.manifest.bytes) return false
	}

	return true
}
