/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data status [<bundle...>]` — present/missing/stale per bundle artifact (#task-6), the
 *   read-only sibling of `data pull`. With no bundle names given, reports on every bundle in
 *   `data-bundles.ts`'s registry.
 *
 *   OFFLINE BY DEFAULT: an artifact already on disk (`resolveShardPath` for a versioned `us`
 *   per-state shard, `existsSync` otherwise) is reported "present" against the SURVEYED size baked
 *   into the registry (`BundleArtifact.approxBytes`) — a local size-only integrity check (catches a
 *   truncated/corrupt file), not a live version comparison. `--check-remote` upgrades this to a real
 *   HEAD `Content-Length` probe via `APIClient` (one small paced request per artifact THAT'S ALREADY
 *   PRESENT — nothing is fetched for an artifact reported missing, so the flag stays cheap even
 *   against the `us` bundle's 103 files).
 */

import type { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { Text } from "ink"
import { resolvePath } from "path-ts"

import { type Check, CheckList, type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

import { artifactURL, BUNDLES, needsDownload, resolveBundleArtifacts, type BundleArtifact } from "../../data-bundles.ts"
import { readReleaseManifest, resolveShardPath, type DataReleaseManifest } from "../../data-release.ts"

/**
 * Native command-line contract consumed by the filesystem command router.
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
	},
} as const satisfies CommandSpec

interface Options {
	checkRemote: boolean
	dataRoot?: string
}

/**
 * Live `Content-Length` for one artifact, or `undefined` on any failure (404, timeout, network) — the caller falls back
 * to the recorded {@link BundleArtifact.approxBytes} rather than treating a probe failure as a verdict.
 */
async function headContentLength(client: APIClient, artifact: BundleArtifact): Promise<number | undefined> {
	try {
		const res = await client.fetch({ method: "head", url: artifactURL(artifact) })
		const len = res.headers["content-length"]

		return len ? Number(len) : undefined
	} catch {
		return undefined
	}
}

async function existingLocalPath(
	dataRoot: string,
	manifest: DataReleaseManifest | null,
	artifact: BundleArtifact,
	resolvedAbsPath: string
): Promise<string | null> {
	if (artifact.family && artifact.stateSlug) {
		return await resolveShardPath(dataRoot, artifact.family, artifact.stateSlug, manifest)
	}

	return (await pathExists(resolvedAbsPath)) ? resolvedAbsPath : null
}

async function statusForBundles(
	bundleNames: string[],
	dataRoot: string,
	checkRemote: boolean
): Promise<{ ok: boolean; checks: Check[] }> {
	const manifest = await readReleaseManifest(dataRoot)
	const checks: Check[] = []
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
			const localAbsPath = resolvePath(dataRoot, artifact.localPath)
			const existing = await existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

			if (!existing) {
				ok = false

				checks.push({
					ok: false,
					check: label,
					detail: `missing (expected ~${ByteFormatter.formatSI(artifact.approxBytes)}) — mailwoman data pull ${name}`,
				})

				continue
			}

			const sizeBytes = (await statPath(existing)).size

			const expected = checkRemote
				? ((await headContentLength(client!, artifact)) ?? artifact.approxBytes)
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
		}
	}

	if (client) {
		await client[Symbol.asyncDispose]()
	}

	return { ok, checks }
}

const DataStatus: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const { mailwomanDataRoot } = await import("@mailwoman/core/utils")

			const dataRoot = options.dataRoot ?? mailwomanDataRoot()
			const names = args.length ? args : Object.keys(BUNDLES)

			return await statusForBundles(names, dataRoot, options.checkRemote)
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} verdict={state.result.ok} />
	}

	return <Text color="gray">checking…</Text>
}

export default DataStatus
