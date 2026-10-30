/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Installation identity and the versioned active-selection document.
 *
 *   An installation is one artifact set placed under the data root, with the origin it came from. The
 *   active selection is one document, replaced whole, that lists which installed artifacts each role reads
 *   for each scope and in what order. A file a directory scan finds is not selected until this document
 *   names it.
 *
 *   Each replacement records the next generation number and the generation it replaced. A writer that
 *   started from generation N may replace only generation N. That rule tells two concurrent activations
 *   apart. A session reads one generation and keeps it until it reloads.
 *
 *   Order means: the first entry whose artifact is installed and readable answers the lookup. An
 *   unsuccessful lookup in that artifact does not fall through to the next entry. That is the behavior of
 *   today's national, Overture and OpenStreetMap provider chain, and falling through after a miss is a
 *   behavior change that needs its own evaluation.
 */

import { sha256Hex } from "#hash"
import { canonicalJSON, stringifyJSON } from "#json"
import {
	type ArtifactID,
	type ArtifactScope,
	type ArtifactSetID,
	isArtifactID,
	isScopeCountryCode,
	isScopeSubdivisionCode,
	ServingRole,
} from "#layers/artifact"

const ROLES = new Set<string>(Object.values(ServingRole))

/**
 * The identity of one installation: `inst-` and 16 hex characters of a digest over its set and origin.
 *
 * The same set installed from the same origin has the same identity, so a repeated
 * pull finds the installation it already completed.
 */
export type LayerInstallationID = `inst-${string}`

/**
 * Where an installation came from.
 */
export type LayerInstallationOrigin =
	| {
			kind: "published"
			/**
			 * The available-data registry entry the installation was planned from.
			 */
			entry: string
			release: string
	  }
	| {
			kind: "built"
			recipe: string
			buildID: string
	  }
	| {
			/**
			 * A file that predates the installation layout, registered without being moved.
			 */
			kind: "legacy"
			/**
			 * Its path relative to the data root.
			 */
			path: string
	  }

/**
 * One installed artifact and where it lives.
 */
export interface InstalledArtifact {
	artifactID: ArtifactID
	role: ServingRole
	/**
	 * The path relative to the data root.
	 */
	path: string
}

/**
 * One artifact set placed under the data root.
 */
export interface LayerInstallation {
	id: LayerInstallationID
	artifactSet: ArtifactSetID
	origin: LayerInstallationOrigin
	artifacts: readonly InstalledArtifact[]
	installedAt: string
}

/**
 * The identity of an installation of `artifactSet` from `origin`.
 */
export function layerInstallationID(artifactSet: ArtifactSetID, origin: LayerInstallationOrigin): LayerInstallationID {
	return `inst-${sha256Hex(canonicalJSON({ artifactSet, origin })).slice(0, 16)}`
}

/**
 * The scope one selection entry answers for.
 */
export interface SelectionScope {
	/**
	 * An uppercase ISO 3166-1 alpha-2 code, or `null` for an entry that is not scoped by country.
	 */
	country: string | null
	/**
	 * An ISO 3166-2 code inside `country`, or `null` for the whole country.
	 */
	subdivision: string | null
}

/**
 * One source in a selection entry's order.
 */
export interface SelectedSource {
	installationID: LayerInstallationID
	artifactID: ArtifactID
}

/**
 * The ordered sources one role reads for one scope.
 */
export interface SelectionEntry {
	role: ServingRole
	scope: SelectionScope
	/**
	 * The sources in the order they are consulted.
	 *
	 * The first installed and readable source answers.
	 * The file comment defines what order means.
	 */
	order: readonly SelectedSource[]
}

/**
 * The version of the active-selection document format this module reads.
 */
export const ACTIVE_SELECTION_FORMAT = 1

/**
 * The active-selection document, `<data-root>/active.json`.
 */
export interface ActiveSelection {
	format: typeof ACTIVE_SELECTION_FORMAT
	/**
	 * A positive integer, one more than the generation this document replaced.
	 */
	generation: number
	/**
	 * The generation this document replaced, or `null` for the first.
	 *
	 * A rollback restores that generation's entries under a new generation number.
	 */
	previousGeneration: number | null
	createdAt: string
	entries: readonly SelectionEntry[]
}

/**
 * A selection that fails validation, listing every problem.
 */
export class ActiveSelectionError extends Error {
	readonly problems: readonly string[]

	constructor(subject: string, problems: readonly string[]) {
		super(`${subject}: ${problems.join("; ")}`)
		this.name = "ActiveSelectionError"
		this.problems = problems
	}
}

function scopeKey(entry: SelectionEntry): string {
	return `${entry.role}|${entry.scope.country ?? "*"}|${entry.scope.subdivision ?? "*"}`
}

function scopeProblems(entry: SelectionEntry, label: string): string[] {
	const { country, subdivision } = entry.scope ?? {}
	const problems: string[] = []

	if (country === undefined || subdivision === undefined) {
		return [`${label} scope must state country and subdivision, writing null for an unscoped field`]
	}

	if (country !== null && !isScopeCountryCode(country)) {
		problems.push(`${label} country ${stringifyJSON(country)} is not an uppercase ISO 3166-1 alpha-2 code`)
	}

	if (subdivision !== null && !isScopeSubdivisionCode(subdivision, country)) {
		problems.push(
			`${label} subdivision ${stringifyJSON(subdivision)} is not an ISO 3166-2 code inside country ${stringifyJSON(country)}`
		)
	}

	return problems
}

/**
 * A selection document as read from disk, before its format version is checked.
 */
export type UncheckedActiveSelection = Partial<Omit<ActiveSelection, "format">> & { format?: number }

/**
 * Every way a selection document is malformed on its own, or an empty list.
 */
export function activeSelectionProblems(selection: UncheckedActiveSelection): string[] {
	const problems: string[] = []

	if (selection.format !== ACTIVE_SELECTION_FORMAT) {
		problems.push(
			`format ${stringifyJSON(selection.format)} is unsupported; this reader reads ${ACTIVE_SELECTION_FORMAT}`
		)
	}

	const generation = selection.generation

	if (!Number.isSafeInteger(generation) || (generation ?? 0) < 1) {
		problems.push("generation must be a positive integer")
	}

	if (selection.previousGeneration === undefined) {
		problems.push("previousGeneration is missing; write null for the first generation")
	} else if (
		selection.previousGeneration !== null &&
		(!Number.isSafeInteger(selection.previousGeneration) ||
			typeof generation !== "number" ||
			selection.previousGeneration >= generation)
	) {
		problems.push("previousGeneration must be an integer below generation")
	}

	if (!selection.createdAt) {
		problems.push("createdAt is missing")
	}

	if (!Array.isArray(selection.entries)) return [...problems, "entries is missing"]

	const scopes = new Set<string>()

	selection.entries.forEach((entry, index) => {
		const label = `entries[${index}]`

		if (!ROLES.has(entry.role)) {
			problems.push(`${label} role ${stringifyJSON(entry.role)} is not a serving role`)
		}

		problems.push(...scopeProblems(entry, label))

		const key = scopeKey(entry)

		if (scopes.has(key)) {
			problems.push(`${label} repeats the role and scope of an earlier entry`)
		}

		scopes.add(key)

		if (!entry.order?.length) {
			problems.push(`${label} order is empty; remove the entry to select nothing`)

			return
		}

		const installed = new Set<string>()

		for (const source of entry.order) {
			if (!isArtifactID(source.artifactID)) {
				problems.push(`${label} source ${stringifyJSON(source.artifactID)} is not an artifact identity`)
			}

			if (!source.installationID?.startsWith("inst-")) {
				problems.push(`${label} source ${stringifyJSON(source.installationID)} is not an installation identity`)
			}

			const pair = `${source.installationID}|${source.artifactID}`

			if (installed.has(pair)) {
				problems.push(`${label} lists ${source.artifactID} twice`)
			}

			installed.add(pair)
		}
	})

	return problems
}

/**
 * Every selected source that names no installed artifact of the entry's role, or an empty list.
 */
export function selectionInstallationProblems(
	selection: ActiveSelection,
	installations: readonly LayerInstallation[]
): string[] {
	const byID = new Map(installations.map((installation) => [installation.id, installation]))
	const problems: string[] = []

	selection.entries.forEach((entry, index) => {
		for (const source of entry.order) {
			const installation = byID.get(source.installationID)

			if (!installation) {
				problems.push(`entries[${index}] selects installation ${source.installationID}, which is not installed`)

				continue
			}

			const artifact = installation.artifacts.find((candidate) => candidate.artifactID === source.artifactID)

			if (!artifact) {
				problems.push(
					`entries[${index}] selects ${source.artifactID}, which installation ${installation.id} does not hold`
				)
			} else if (artifact.role !== entry.role) {
				problems.push(`entries[${index}] reads ${entry.role} from ${source.artifactID}, which serves ${artifact.role}`)
			}
		}
	})

	return problems
}

/**
 * Throws unless a selection is well formed and every source it names is installed with the entry's role.
 *
 * @throws {@link ActiveSelectionError} listing every problem.
 */
export function assertActiveSelection(
	selection: UncheckedActiveSelection,
	installations: readonly LayerInstallation[],
	subject = "active selection"
): asserts selection is ActiveSelection {
	const problems = activeSelectionProblems(selection)

	if (!problems.length) {
		problems.push(...selectionInstallationProblems(selection as ActiveSelection, installations))
	}

	if (problems.length) throw new ActiveSelectionError(subject, problems)
}

/**
 * Throws unless `next` may replace `current`.
 *
 * A writer reads the generation it starts from, builds its replacement on it,
 * and checks again at the moment of replacement.
 * When another writer replaced the document in between, `current` has moved
 * and the replacement is refused rather than overwriting that writer's selection.
 *
 * @param current The document on disk at the moment of replacement, or `null` when none exists yet.
 * @throws {@link ActiveSelectionError} when `next` does not succeed `current`.
 */
export function assertSelectionSuccessor(current: ActiveSelection | null, next: ActiveSelection): void {
	const expected = (current?.generation ?? 0) + 1
	const previous = current?.generation ?? null
	const problems: string[] = []

	if (next.generation !== expected) {
		problems.push(`generation ${next.generation} does not follow ${current?.generation ?? "an empty selection"}`)
	}

	if (next.previousGeneration !== previous) {
		problems.push(`previousGeneration ${next.previousGeneration} is not the current generation ${previous}`)
	}

	if (problems.length) throw new ActiveSelectionError("selection replacement", problems)
}

/**
 * The selection scopes an artifact is activated under, one entry per scope.
 *
 * An artifact scoped to subdivisions gets one entry per subdivision, one scoped to
 * countries one entry per country, and one scoped to neither the unscoped entry.
 * A multi-country artifact therefore answers only for its own countries:
 * the unscoped entry would answer every country's lookup.
 */
export function selectionScopesOf(scope: ArtifactScope): SelectionScope[] {
	if (scope.subdivisions?.length) {
		return scope.subdivisions.map((subdivision) => ({ country: subdivision.slice(0, 2), subdivision }))
	}

	if (scope.countries.length) return scope.countries.map((country) => ({ country, subdivision: null }))

	return [{ country: null, subdivision: null }]
}

/**
 * The ordered sources a role reads for a scope, most specific entry first.
 *
 * A subdivision entry answers before its country's entry, and a country entry before an unscoped one.
 * This returns each entry's order whole and joins them in that sequence.
 * It reads the document only and opens no artifact.
 *
 * An unscoped lookup asks for the role whatever its scope, as the readers that
 * attach every installed source do.
 * It returns the unscoped entry first and then every scoped entry of the role in key order, each source
 * once, because {@link selectionScopesOf} files a multi-country artifact only under its countries.
 */
export function selectedSources(
	selection: ActiveSelection,
	role: ServingRole,
	scope: SelectionScope
): readonly SelectedSource[] {
	if (!scope.country && !scope.subdivision) {
		const entries = selection.entries
			.filter((entry) => entry.role === role)
			.toSorted((a, b) => {
				const unscoped = Number(Boolean(a.scope.country)) - Number(Boolean(b.scope.country))

				return unscoped || scopeKey(a).localeCompare(scopeKey(b))
			})

		const seen = new Set<string>()

		return entries
			.flatMap((entry) => entry.order)
			.filter((source) => {
				const key = `${source.installationID}|${source.artifactID}`

				if (seen.has(key)) return false

				seen.add(key)

				return true
			})
	}

	const keys = [
		scope.subdivision ? `${role}|${scope.country ?? "*"}|${scope.subdivision}` : null,
		scope.country ? `${role}|${scope.country}|*` : null,
		`${role}|*|*`,
	]

	const byKey = new Map(selection.entries.map((entry) => [scopeKey(entry), entry]))

	return keys.flatMap((key) => (key ? (byKey.get(key)?.order ?? []) : []))
}
