/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An artifact listed in the active selection is reported with its generation and checked against the size its
 *   own manifest records. A selected artifact of another size raises an unreadable-artifact error with its path.
 *
 *   The command runs offline by default. It reports an on-disk artifact as "present" when its size matches
 *   the registry's surveyed `approxBytes`. This size-only integrity check catches truncation and does not
 *   compare versions. `--check-remote` adds a live head `Content-Length` probe through `APIClient`.
 */

import type { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { UnreadableArtifactError, type UnreadableReason } from "@mailwoman/core/layers"
import { Text } from "ink"
import type { PathBuilderLike } from "path-ts"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import {
	artifactURL,
	bundleArtifactPath,
	BUNDLES,
	needsDownload,
	resolveBundleArtifacts,
	type BundleArtifact,
} from "#data/bundles"
import { LayerCatalog, type ResolvedSource } from "#data/catalog"
import { availableDataEntry, selectionScopeOf } from "#data/registry"
import { existingLocalPath, readReleaseManifest } from "#data/release"
import { headContentLength } from "#data/remote"
import { type InterruptedAcquisition, readInstallationState } from "#data/state"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "status",
	description: "Report data bundle status",
	positionals: [
		{ name: "bundle", multiple: true, description: `Bundle names. Default: ${Object.keys(BUNDLES).join(", ")}` },
	],
	options: {
		"check-remote": { type: "boolean", default: false, description: "Check live artifact sizes" },
		"data-root": { type: "string", description: "Override the data root" },
		json: { type: "boolean", default: false, description: "Emit the status as JSON" },
	},
} as const satisfies CommandSpec

/**
 * A probe failure yields `undefined` so the caller falls back to the recorded
 * {@link BundleArtifact.approxBytes} rather than treating it as a verdict.
 */
async function liveContentLength(client: APIClient, artifact: BundleArtifact): Promise<number | null> {
	try {
		return await headContentLength(client, artifactURL(artifact))
	} catch {
		return null
	}
}

/**
 * One bundle artifact's state, for `--json`.
 *
 * `active`: selected in the current generation.
 * `present`: at its conventional path with the recorded size.
 *
 * `stale`: at its conventional path with another size.
 * `missing`: not installed.
 *
 * `corrupt`, `unopenable`, `unmanifested` and `unsupported`: selected
 * and unusable, as the reader reports it.
 */
interface ArtifactStatus {
	bundle: string
	remotePath: string
	state: "active" | "present" | "stale" | "missing" | UnreadableReason
	path: string | null
}

/**
 * The structured status `--json` prints.
 */
interface StatusReport {
	dataRoot: string
	generation: number | null
	artifacts: ArtifactStatus[]
	inactive: Array<{ installationID: string; remotePath: string | null; artifactID: string; role: string; path: string }>
	interrupted: InterruptedAcquisition[]
}

async function statusForBundles(
	bundleNames: string[],
	dataRoot: PathBuilderLike,
	checkRemote: boolean
): Promise<{ ok: boolean; checks: Check[]; report: StatusReport }> {
	const manifest = await readReleaseManifest(dataRoot)
	const catalog = await LayerCatalog.read(dataRoot)
	const checks: Check[] = []
	const artifacts: ArtifactStatus[] = []
	let ok = true

	const client = checkRemote
		? new (await import("@mailwoman/core/api")).APIClient({
				displayName: "mailwoman data status",
				minRequestIntervalMs: 150,
				retry: true,
			})
		: null

	for (const name of bundleNames) {
		const bundle = BUNDLES[name]

		if (!bundle) {
			ok = false

			checks.push({
				ok: false,
				check: name,
				detail: `unknown bundle — known bundles: ${Object.keys(BUNDLES).join(", ")}`,
			})

			continue
		}

		for (const artifact of resolveBundleArtifacts(bundle, manifest)) {
			const label = `${name}: ${artifact.localPath}`
			const localAbsPath = bundleArtifactPath(dataRoot, artifact)

			// An artifact listed in the active selection is checked against the exact
			// size its own manifest records.
			// The registry's surveyed size is an estimate.
			const [available] = availableDataEntry({ ...bundle, artifacts: [artifact] }).artifacts
			let first: ResolvedSource | undefined

			try {
				;[first] = available ? await catalog.resolve(available.role, selectionScopeOf(available)) : []
			} catch (error) {
				if (!(error instanceof UnreadableArtifactError)) throw error

				ok = false
				checks.push({ ok: false, check: label, detail: `${error.reason}: ${error.message}` })
				artifacts.push({ bundle: name, remotePath: artifact.remotePath, state: error.reason, path: error.path })

				continue
			}

			if (first) {
				checks.push({
					ok: true,
					check: label,
					detail: `selected in generation ${catalog.generation} (${ByteFormatter.formatSI(first.manifest.bytes)}, size matches its manifest ${first.manifest.id}) at ${first.path}`,
				})

				artifacts.push({ bundle: name, remotePath: artifact.remotePath, state: "active", path: first.path })

				continue
			}

			const existing = await existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

			if (!existing) {
				ok = false

				checks.push({
					ok: false,
					check: label,
					detail: `missing (expected ~${ByteFormatter.formatSI(artifact.approxBytes)}) — mailwoman data pull ${name}${artifact.stateSlug ? ` --only ${artifact.stateSlug}` : ""}`,
				})

				artifacts.push({ bundle: name, remotePath: artifact.remotePath, state: "missing", path: null })

				continue
			}

			const sizeBytes = (await statPath(existing)).size

			const expected = checkRemote
				? ((await liveContentLength(client!, artifact)) ?? artifact.approxBytes)
				: artifact.approxBytes

			const stale = needsDownload({ exists: true, sizeBytes }, { contentLength: expected })

			ok = ok && !stale

			checks.push({
				ok: !stale,
				check: label,
				detail: stale
					? `stale — ${ByteFormatter.formatSI(sizeBytes)} on disk vs ${ByteFormatter.formatSI(expected)} ${checkRemote ? "(live)" : "(recorded)"} at ${existing}`
					: `present (${ByteFormatter.formatSI(sizeBytes)}) at ${existing}`,
			})

			artifacts.push({
				bundle: name,
				remotePath: artifact.remotePath,
				state: stale ? "stale" : "present",
				path: existing,
			})
		}
	}

	if (client) {
		await client[Symbol.asyncDispose]()
	}

	// Installed artifacts outside the selection and acquisitions that stopped are reported apart from the active ones.
	const installation = await readInstallationState(dataRoot)

	for (const copy of installation.inactive) {
		checks.push({
			ok: true,
			check: "installed, not selected",
			detail: `${copy.receipt?.remotePath ?? copy.manifest.role} at ${copy.path}; \`mailwoman data activate ${copy.installationID}\` or a pull of its bundle selects it`,
		})
	}

	for (const stopped of installation.interrupted) {
		checks.push({
			ok: true,
			check: "interrupted transfer",
			detail: `${stopped.remotePath}: ${ByteFormatter.formatSI(stopped.partialBytes)} of ${stopped.expectedBytes == null ? "an unknown length" : ByteFormatter.formatSI(stopped.expectedBytes)} kept since ${stopped.startedAt}; the next pull resumes it`,
		})
	}

	return {
		ok,
		checks,
		report: {
			dataRoot: installation.dataRoot,
			generation: installation.generation,
			artifacts,
			inactive: installation.inactive.map((copy) => ({
				installationID: copy.installationID,
				remotePath: copy.receipt?.remotePath ?? null,
				artifactID: copy.artifactID,
				role: copy.manifest.role,
				path: copy.path,
			})),
			interrupted: installation.interrupted,
		},
	}
}

const DataStatus: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const { dataRootPath } = await import("@mailwoman/core/data-root")

			const dataRoot = options.dataRoot ?? dataRootPath()
			const names = args.length ? args : Object.keys(BUNDLES)

			const result = await statusForBundles(names, dataRoot, options.checkRemote)

			if (options.json) {
				writeRawStdout({ ok: result.ok, ...result.report })
			}

			return result
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">checking…</Text>} />

	if (options.json) return null

	return <CheckList checks={state.result.checks} verdict={state.result.ok} />
}

export default DataStatus
