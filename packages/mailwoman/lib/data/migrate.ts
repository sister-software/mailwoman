/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Read-only discovery of the files today's readers select, and the dry-run plan that registers them.
 *
 *   Discovery asks the readers that select files now, rather than scanning for names: the candidate
 *   gazetteer through its pin and conventional path, each US state through `releases.json` and the legacy
 *   names, every published bundle's conventional path, the OpenStreetMap address-point extracts and the WOF
 *   extracts. Each file is described as it stands: a symlink and its target, hard links, a WAL sidecar, a
 *   path outside the data root, and whether it records a `layer_manifest`.
 *
 *   The plan registers each importable file in place as a `legacy` installation, without moving or copying
 *   it, and selects it for the role and scope its reader already resolves. The geocoder therefore reads the
 *   same file before and after. A field the file does not record stays unrecorded. The rollback restores the
 *   generation the migration replaces, or removes `active.json` when none existed.
 *
 *   This module plans only and writes no file.
 */

import { pathExists, readLink, statLink, tryStat } from "@mailwoman/core/fs/readers/stat"
import { ServingRole } from "@mailwoman/core/layers"
import type { PathBuilderLike } from "path-ts"
import { relative, resolvePath } from "path-ts"

import { bundleArtifactPath, BUNDLES, type DataBundle, resolveBundleArtifacts } from "#data/bundles"
import { catalogPaths, LayerCatalog, readActiveSelection } from "#data/catalog"
import { probeManifest } from "#data/inventory"
import { availableDataEntry, selectionScopeOf } from "#data/registry"
import { readReleaseManifest, resolveDatabasePath } from "#data/release"
import { $public } from "#env"
import { addressPointDatabases } from "#geocode/layer-paths"
import { conventionCandidateDBPath, resolveWOFDatabasePaths } from "#resolver-backend"

/**
 * How a discovered file can enter the catalog.
 */
export const MigrationClass = {
	/**
	 * It records a `layer_manifest` and its role is known: register it in place.
	 */
	Importable: "importable",
	/**
	 * It records no `layer_manifest` and is a published registry artifact: register it in place
	 * with a manifest written from the registry's record, which states its role, scope and terms.
	 */
	RegistryManifest: "registry-manifest",
	/**
	 * A local build with no `layer_manifest`: rebuild it from its source to record its inputs.
	 */
	SourceRebuild: "source-rebuild",
	/**
	 * Neither the file nor the registry records where it came from.
	 *
	 * The plan leaves it where it is, and its reader keeps resolving it through the conventional path.
	 */
	UnknownProvenance: "unknown-provenance",
	/**
	 * A WAL sidecar is present, so a writer may hold it open or it closed uncleanly.
	 * Seal it before registering.
	 */
	BlockedWAL: "blocked-wal",
} as const

export type MigrationClass = (typeof MigrationClass)[keyof typeof MigrationClass]

/**
 * Which reader selects a discovered file today.
 */
export type MigrationReader =
	| "candidate-pin"
	| "candidate-convention"
	| "us-state"
	| "bundle-convention"
	| "osm-extract"
	| "wof-extract"

/**
 * One file today's readers select.
 */
export interface DiscoveredArtifact {
	reader: MigrationReader
	/**
	 * The role and scope the file would be selected under, or `null` when no role
	 * reads it through the catalog yet.
	 */
	role: ServingRole | null
	scope: { country: string | null; subdivision: string | null } | null
	path: string
	/**
	 * The file a symlink resolves to, or `null` for a regular file.
	 */
	linkTarget: string | null
	/**
	 * More than one name for the same inode.
	 */
	hardLinks: number
	/**
	 * The size of a `-wal` sidecar, or `null` when none exists.
	 */
	walBytes: number | null
	/**
	 * The path lies outside the data root, as a pin through an environment variable can.
	 */
	external: boolean
	bytes: number
	recordsLayerManifest: boolean
	classification: MigrationClass
	reason: string
}

/**
 * The dry-run migration plan.
 */
export interface MigrationPlan {
	dataRoot: string
	/**
	 * The generation the migration would replace, or `null` when no selection exists.
	 */
	basedOnGeneration: number | null
	artifacts: DiscoveredArtifact[]
	/**
	 * Bytes the migration copies.
	 *
	 * Registration in place copies 0 bytes.
	 * Each registered file is hashed once.
	 */
	bytesToCopy: number
	bytesToHash: number
	/**
	 * What restores the previous state.
	 */
	rollback: string
	/**
	 * The plan's steps, in order.
	 *
	 * Each is resumable: an installation record already written is kept.
	 */
	steps: string[]
}

async function describe(
	dataRoot: string,
	path: string,
	reader: MigrationReader,
	role: ServingRole | null,
	scope: DiscoveredArtifact["scope"],
	registryRecord: boolean
): Promise<DiscoveredArtifact | null> {
	const link = await statLink(path).catch(() => null)

	if (!link) return null

	const linkTarget = link.isSymbolicLink() ? resolvePath(path, "..", await readLink(path)) : null
	const stats = await tryStat(path)

	if (!stats) return null

	const wal = await tryStat(`${path}-wal`)
	// SQLite creates a `-shm` sidecar when it opens a database that has a WAL,
	// even read-only, so a file with a WAL is described without opening it.
	const probed = wal ? {} : probeManifest(path)
	const recordsLayerManifest = Boolean(probed.manifest)
	const external = relative(dataRoot, path).startsWith("..")
	let classification: MigrationClass
	let reason: string

	if (wal) {
		classification = MigrationClass.BlockedWAL
		reason = `${path}-wal holds ${wal.size} bytes; a writer may hold the file open or it closed uncleanly`
	} else if (recordsLayerManifest && role) {
		classification = MigrationClass.Importable
		reason = `layer_manifest records ${probed.manifest!.source} at ${probed.manifest!.source_vintage}`
	} else if (registryRecord && role) {
		classification = MigrationClass.RegistryManifest
		reason = "no layer_manifest; the registry's published record states its role, scope and terms"
	} else if (reader === "osm-extract" || reader === "wof-extract") {
		classification = MigrationClass.SourceRebuild

		reason = probed.error
			? `could not be opened: ${probed.error}`
			: "a local build with no layer_manifest, so its inputs are unrecorded"
	} else {
		classification = MigrationClass.UnknownProvenance
		reason = "neither the file nor the registry records its origin"
	}

	return {
		reader,
		role,
		scope,
		path,
		linkTarget,
		hardLinks: stats.nlink,
		walBytes: wal?.size ?? null,
		external,
		bytes: stats.size,
		recordsLayerManifest,
		classification,
		reason,
	}
}

/**
 * Discover the files today's readers select and plan their registration, without writing a file.
 *
 * @throws {@link UnreadableArtifactError} when the release manifest or the active selection cannot be read.
 */
export async function planMigration(
	dataRoot: PathBuilderLike,
	registry: Readonly<Record<string, DataBundle>> = BUNDLES
): Promise<MigrationPlan> {
	const root = resolvePath(dataRoot.toString())
	const releases = await readReleaseManifest(root)
	const selection = await readActiveSelection(root)
	const found: DiscoveredArtifact[] = []
	const seen = new Set<string>()

	const add = async (...args: Parameters<typeof describe> extends [string, ...infer Rest] ? Rest : never) => {
		const [path] = args

		if (seen.has(path) || !(await pathExists(path))) return

		seen.add(path)

		const artifact = await describe(root, ...args)

		if (artifact) {
			found.push(artifact)
		}
	}

	const candidateScope = { country: null, subdivision: null }
	const pin = $public.MAILWOMAN_CANDIDATE_DB

	if (pin && pin !== "none") {
		await add(pin, "candidate-pin", ServingRole.Candidate, candidateScope, false)
	}

	await add(conventionCandidateDBPath(root), "candidate-convention", ServingRole.Candidate, candidateScope, true)

	for (const bundle of Object.values(registry)) {
		for (const artifact of resolveBundleArtifacts(bundle, releases)) {
			const [available] = availableDataEntry({ ...bundle, artifacts: [artifact] }).artifacts

			if (!available) continue

			const scope = selectionScopeOf(available)

			if (artifact.family && artifact.stateSlug) {
				// The same resolution the per-state provider runs, without the selection,
				// so a file selected through active.json is left to the catalog.
				const legacy = await resolveDatabasePath(
					root,
					artifact.family,
					artifact.stateSlug,
					releases,
					LayerCatalog.empty(root)
				)

				if (legacy) {
					await add(legacy, "us-state", available.role, scope, true)
				}

				continue
			}

			await add(bundleArtifactPath(root, artifact), "bundle-convention", available.role, scope, true)
		}
	}

	for (const extract of await addressPointDatabases(root)) {
		await add(extract.path, "osm-extract", null, null, false)
	}

	for (const path of resolveWOFDatabasePaths(undefined, root)) {
		await add(path, "wof-extract", ServingRole.WOFExtract, { country: null, subdivision: null }, false)
	}

	const registering = found.filter(
		(artifact) =>
			artifact.classification === MigrationClass.Importable ||
			artifact.classification === MigrationClass.RegistryManifest
	)

	const paths = catalogPaths(root)

	return {
		dataRoot: root,
		basedOnGeneration: selection?.generation ?? null,
		artifacts: found,
		bytesToCopy: 0,
		bytesToHash: registering.reduce((sum, artifact) => sum + artifact.bytes, 0),
		rollback: selection
			? `restore generation ${selection.generation} with \`mailwoman data activate --rollback\`; registered files were neither moved nor changed`
			: `remove ${paths.activeSelection} and ${paths.installations}; registered files were neither moved nor changed`,
		steps: [
			"re-read this plan immediately before execution and stop when any file, link or WAL state differs",
			`hash each of the ${registering.length} registered file(s) and write its manifest beside its installation record`,
			`write one legacy installation record per file under ${paths.installations}`,
			"select each registered file for the role and scope its reader resolves today, in one replacement of active.json",
		],
	}
}
