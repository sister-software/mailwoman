/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The interface between a source-build recipe and the installer that runs it.
 *
 *   A recipe plans which inputs a request needs and which artifacts it derives, checks the tools its build
 *   runs, and builds artifacts from inputs that are already on disk. The installer acquires the inputs,
 *   validates and installs the outputs, and changes the active selection. The recipe never writes under
 *   `db/` or `active.json`, so a built artifact is validated and activated by the same code as a download.
 *
 *   The recipe and the installer live in different packages: the installer cannot load the recipe's build
 *   dependencies, and the recipe cannot read the installer's records. These declarations are the part both
 *   read.
 */

import type { ArtifactDerivation, ArtifactManifest, ArtifactScope, ServingRole } from "#layers/artifact"

/**
 * The registered build recipes.
 *
 * The name is recorded as {@link ArtifactManifest.recipe} on every artifact the recipe builds,
 * so a reader can tell which installed artifacts a recipe produced.
 */
export const BuildRecipeName = {
	/**
	 * Address points derived from an OpenStreetMap extract, one database per country.
	 */
	OSMAddressPoints: "osm-address-points",
} as const

export type BuildRecipeName = (typeof BuildRecipeName)[keyof typeof BuildRecipeName]

/**
 * What a customer asked a recipe to build.
 */
export interface BuildRequest {
	/**
	 * Uppercase ISO 3166-1 alpha-2 codes.
	 */
	countries: readonly string[]
	/**
	 * The publisher's region to acquire, or `null` to let each country's policy choose its own.
	 */
	region: string | null
}

/**
 * One tool or package the build runs, and whether it is present.
 */
export interface BuildPrerequisite {
	name: string
	satisfied: boolean
	/**
	 * What was found, or what is missing and how to install it.
	 */
	detail: string
}

/**
 * One input file a build reads, before it is acquired.
 */
export interface BuildInput {
	/**
	 * A stable key for the input within the plan, such as `geofabrik:europe/germany`.
	 */
	key: string
	/**
	 * The source group under `<data-root>/src/`, such as `geofabrik`.
	 */
	source: string
	/**
	 * The publisher's identifier for the input, such as `europe/germany`.
	 */
	name: string
	publisher: string
	/**
	 * The URL the bytes are transferred from, or the metadata URL when {@link locate} is set.
	 */
	url: string
	/**
	 * Read the download URL from a JSON metadata document at {@link url}, at this field.
	 */
	locate: { field: string } | null
	/**
	 * Whether the publisher serves an `.md5` sidecar beside the file.
	 */
	md5Sidecar: boolean
	/**
	 * The file name the input is stored under.
	 */
	fileName: string
	license: string
}

/**
 * One artifact a build derives.
 */
export interface BuildOutput {
	/**
	 * The uppercase alpha-2 code the artifact is scoped to.
	 */
	country: string
	role: ServingRole
	fileName: string
	/**
	 * The keys of the inputs it is derived from, the first being the data and the rest the clipping inputs.
	 */
	inputs: readonly string[]
	policy: ArtifactDerivation["policy"]
	scope: ArtifactScope
}

/**
 * A recipe's plan for one request.
 *
 * Several outputs may name one input, so a regional file shared by several countries is acquired once.
 */
export interface BuildPlan {
	recipe: BuildRecipeName
	request: BuildRequest
	inputs: readonly BuildInput[]
	outputs: readonly BuildOutput[]
	/**
	 * Why the request cannot be built as asked, or an empty list.
	 */
	problems: readonly string[]
}

/**
 * One input on disk, verified.
 */
export interface AcquiredBuildInput {
	input: BuildInput
	path: string
	sha256: string
	md5: string | null
	/**
	 * The publisher's release, such as the snapshot date, or `null` when the host stated none.
	 */
	release: string | null
	/**
	 * The URL the bytes came from.
	 */
	url: string
}

/**
 * One artifact a recipe built, before the installer hashes and installs it.
 *
 * The manifest leaves out the fields the installer measures from the bytes.
 */
export interface BuiltArtifact {
	output: BuildOutput
	path: string
	manifest: Omit<ArtifactManifest, "id" | "bytes" | "createdAt"> & { derivation: ArtifactDerivation }
}

/**
 * Options the installer passes to {@link BuildRecipe.build}.
 */
export interface BuildOptions {
	/**
	 * An empty directory on the data root's filesystem, where the recipe writes its outputs.
	 */
	directory: string
	/**
	 * The builder's identity, recorded as {@link ArtifactManifest.builderSHA}.
	 */
	builderSHA: string
	createdAt: string
	signal?: AbortSignal
	onProgress?: (message: string) => void
}

/**
 * A source-build recipe.
 */
export interface BuildRecipe {
	name: BuildRecipeName
	/**
	 * The countries the recipe can build, as uppercase alpha-2 codes.
	 */
	countries(): readonly string[]
	/**
	 * Plan a request without touching the network or the disk.
	 */
	plan(request: BuildRequest): BuildPlan
	/**
	 * Check every tool the build runs, before any input is acquired.
	 */
	prerequisites(): Promise<BuildPrerequisite[]>
	/**
	 * Build every output of the plan from its acquired inputs.
	 *
	 * @throws When the build fails or `options.signal` aborts.
	 * The data root's installed artifacts and selection stay as they were.
	 */
	build(
		plan: BuildPlan,
		inputs: ReadonlyMap<string, AcquiredBuildInput>,
		options: BuildOptions
	): Promise<BuiltArtifact[]>
}
