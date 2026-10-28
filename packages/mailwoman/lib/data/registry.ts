/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One entry of the available-data registry: what can be downloaded or built, before any of it is installed.
 *
 *   The registry describes downloads and build recipes. An artifact's own manifest, declared in
 *   `@mailwoman/core/layers`, describes what a file contains once it exists. The two are separate
 *   records: a registry entry can list an artifact's expected digest and size, and only the
 *   downloaded file's manifest establishes what the file holds. Neither record stores CLI wording.
 *
 *   `BUNDLES` in `bundles.ts` stays the registry the CLI reads until the installation planner moves
 *   onto these entries.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	type ArtifactID,
	isArtifactID,
	isRecordedMD5,
	isScopeCountryCode,
	isScopeSubdivisionCode,
	ServingRole,
} from "@mailwoman/core/layers"

const ROLES = new Set<string>(Object.values(ServingRole))

/**
 * How a registry entry's data reaches the data root.
 */
export const AvailabilityKind = {
	/**
	 * A published artifact downloaded as it is.
	 */
	Download: "download",
	/**
	 * A recipe the customer runs locally, acquiring its inputs first.
	 */
	Build: "build",
} as const

export type AvailabilityKind = (typeof AvailabilityKind)[keyof typeof AvailabilityKind]

/**
 * What a customer needs before the entry can be acquired.
 */
export const AccessRequirement = {
	/**
	 * Anyone may download it.
	 */
	Public: "public",
	/**
	 * A license token admitting the entry's tier is required.
	 */
	Licensed: "licensed",
} as const

export type AccessRequirement = (typeof AccessRequirement)[keyof typeof AccessRequirement]

/**
 * The state of a recorded size.
 */
export const SizeBasis = {
	/**
	 * Measured from the published file, such as its `Content-Length` or a local copy.
	 */
	Verified: "verified",
	/**
	 * An estimate, such as a build's expected output size.
	 */
	Estimated: "estimated",
	/**
	 * Not recorded.
	 */
	Unknown: "unknown",
} as const

export type SizeBasis = (typeof SizeBasis)[keyof typeof SizeBasis]

/**
 * A recorded size and how it is known.
 */
export type RecordedSize =
	| { basis: typeof SizeBasis.Verified | typeof SizeBasis.Estimated; bytes: number }
	| { basis: typeof SizeBasis.Unknown }

/**
 * One artifact a download entry fetches.
 */
export interface AvailableArtifact {
	role: ServingRole
	/**
	 * The object key relative to the host's base URL.
	 */
	remotePath: string
	/**
	 * The digest the published file is expected to have, or `null` when the registry has not recorded it.
	 *
	 * The installed manifest is still read and validated after download.
	 */
	expectedID: ArtifactID | null
	/**
	 * The published `.md5` sidecar's digest, recorded separately from the SHA-256, or `null`.
	 */
	md5: string | null
	size: RecordedSize
}

/**
 * One entry of the available-data registry.
 */
export interface AvailableDataEntry {
	/**
	 * The name a customer installs it by, such as `candidate` or `us`.
	 */
	name: string
	kind: AvailabilityKind
	/**
	 * The roles the entry adds once installed.
	 */
	capabilities: readonly ServingRole[]
	/**
	 * Uppercase ISO 3166-1 alpha-2 codes, empty for an entry not scoped by country.
	 */
	countries: readonly string[]
	/**
	 * ISO 3166-2 codes when the entry covers part of a country, or `null`.
	 */
	subdivisions: readonly string[] | null
	/**
	 * Names of the entries that must be installed first.
	 */
	dependencies: readonly string[]
	access: AccessRequirement
	/**
	 * The SPDX expression the registry records for the entry's data.
	 *
	 * The installed artifact's own manifest is the authority for the license of its contents.
	 */
	license: string
	/**
	 * The files a download fetches.
	 * Empty for a build entry.
	 */
	artifacts: readonly AvailableArtifact[]
	/**
	 * The recipe a build entry runs, or `null` for a download.
	 */
	recipe: string | null
}

/**
 * Every way one entry is malformed on its own, or an empty list.
 */
export function availableDataEntryProblems(entry: Partial<AvailableDataEntry>): string[] {
	const problems: string[] = []

	if (!entry.name) {
		problems.push("name is missing")
	}

	if (entry.kind !== AvailabilityKind.Download && entry.kind !== AvailabilityKind.Build) {
		problems.push(`kind ${stringifyJSON(entry.kind)} is neither download nor build`)
	}

	if (!entry.capabilities?.length) {
		problems.push("capabilities is empty")
	}

	for (const role of entry.capabilities ?? []) {
		if (!ROLES.has(role)) {
			problems.push(`capability ${stringifyJSON(role)} is not a serving role`)
		}
	}

	if (!Array.isArray(entry.countries)) {
		problems.push("countries is missing")
	}

	for (const country of entry.countries ?? []) {
		if (!isScopeCountryCode(country)) {
			problems.push(`country ${stringifyJSON(country)} is not an uppercase alpha-2 code`)
		}
	}

	if (entry.subdivisions === undefined) {
		problems.push("subdivisions is missing; write null for whole countries")
	}

	for (const subdivision of entry.subdivisions ?? []) {
		const country = entry.countries?.find((candidate) => candidate === subdivision.slice(0, 2)) ?? null

		if (!isScopeSubdivisionCode(subdivision, country)) {
			problems.push(`subdivision ${stringifyJSON(subdivision)} is not an ISO 3166-2 code in the entry's countries`)
		}
	}

	if (!Array.isArray(entry.dependencies)) {
		problems.push("dependencies is missing")
	}

	if (entry.dependencies?.includes(entry.name ?? "")) {
		problems.push("the entry depends on itself")
	}

	if (entry.access !== AccessRequirement.Public && entry.access !== AccessRequirement.Licensed) {
		problems.push(`access ${stringifyJSON(entry.access)} is neither public nor licensed`)
	}

	if (!entry.license) {
		problems.push("license is missing")
	}

	if (entry.kind === AvailabilityKind.Download) {
		if (!entry.artifacts?.length) {
			problems.push("a download entry lists at least one artifact")
		}

		if (entry.recipe != null) {
			problems.push("a download entry names no recipe")
		}
	}

	if (entry.kind === AvailabilityKind.Build) {
		if (!entry.recipe) {
			problems.push("a build entry names its recipe")
		}

		if (entry.artifacts?.length) {
			problems.push("a build entry lists no download artifacts")
		}
	}

	entry.artifacts?.forEach((artifact, index) => {
		const label = `artifacts[${index}]`

		if (!ROLES.has(artifact.role)) {
			problems.push(`${label}.role is not a serving role`)
		}

		if (!entry.capabilities?.includes(artifact.role)) {
			problems.push(`${label}.role ${artifact.role} is not among the entry's capabilities`)
		}

		if (!artifact.remotePath) {
			problems.push(`${label}.remotePath is missing`)
		}

		if (artifact.expectedID !== null && !isArtifactID(artifact.expectedID)) {
			problems.push(`${label}.expectedID is not sha256:<64 hex>`)
		}

		if (artifact.md5 !== null && !isRecordedMD5(artifact.md5 ?? "")) {
			problems.push(`${label}.md5 is not 32 lowercase hex characters`)
		}

		if (!artifact.size) {
			problems.push(`${label}.size is missing; record {basis: "unknown"} when unrecorded`)
		} else if (
			artifact.size.basis !== SizeBasis.Unknown &&
			!(Number.isSafeInteger(artifact.size.bytes) && artifact.size.bytes >= 0)
		) {
			problems.push(`${label}.size.bytes must be a non-negative integer`)
		}
	})

	return problems
}

/**
 * Every way a registry fails as a whole, or an empty list: a malformed entry, a repeated name,
 * a dependency on an entry the registry does not hold, or a dependency cycle.
 */
export function availableDataRegistryProblems(entries: readonly AvailableDataEntry[]): string[] {
	const problems: string[] = []
	const byName = new Map<string, AvailableDataEntry>()

	for (const entry of entries) {
		for (const problem of availableDataEntryProblems(entry)) {
			problems.push(`${entry.name || "(unnamed)"}: ${problem}`)
		}

		if (byName.has(entry.name)) {
			problems.push(`${entry.name}: the name is repeated`)
		}

		byName.set(entry.name, entry)
	}

	for (const entry of entries) {
		for (const dependency of entry.dependencies) {
			if (!byName.has(dependency)) {
				problems.push(`${entry.name}: depends on ${dependency}, which is not registered`)
			}
		}
	}

	const state = new Map<string, "visiting" | "done">()

	const visit = (name: string, path: readonly string[]): void => {
		if (state.get(name) === "done") return

		if (state.get(name) === "visiting") {
			problems.push(`dependency cycle: ${[...path, name].join(" -> ")}`)

			return
		}

		state.set(name, "visiting")

		for (const dependency of byName.get(name)?.dependencies ?? []) {
			if (byName.has(dependency)) {
				visit(dependency, [...path, name])
			}
		}

		state.set(name, "done")
	}

	for (const entry of entries) {
		visit(entry.name, [])
	}

	return problems
}
