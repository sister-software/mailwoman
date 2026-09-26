/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Offline by default: an artifact on disk is reported "present" against the registry's surveyed `approxBytes`, a
 *   size-only integrity check that catches truncation but is not a version comparison, and `--check-remote` upgrades it
 *   to a live head `Content-Length` probe via `APIClient`.
 */

import type { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers"
import { Text } from "ink"
import type { PathBuilderLike } from "path-ts"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"
import {
	artifactURL,
	bundleArtifactPath,
	BUNDLES,
	needsDownload,
	resolveBundleArtifacts,
	type BundleArtifact,
} from "#data/bundles"
import { existingLocalPath, readReleaseManifest } from "#data/release"

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
	},
} as const satisfies CommandSpec

/**
 * A probe failure yields `undefined` so the caller falls back to the recorded
 * {@link BundleArtifact.approxBytes} rather than treating it as a verdict.
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

async function statusForBundles(
	bundleNames: string[],
	dataRoot: PathBuilderLike,
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
			const localAbsPath = bundleArtifactPath(dataRoot, artifact)
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

const DataStatus: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const { dataRootPath } = await import("@mailwoman/core/data-root")

			const dataRoot = options.dataRoot ?? dataRootPath()
			const names = args.length ? args : Object.keys(BUNDLES)

			return await statusForBundles(names, dataRoot, options.checkRemote)
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">checking…</Text>} />

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} verdict={state.result.ok} />
	}

	return null
}

export default DataStatus
