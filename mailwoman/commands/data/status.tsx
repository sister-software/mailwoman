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

import { existsSync, statSync } from "node:fs"

import { APIClient } from "@mailwoman/core/api"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Text } from "ink"
import { resolvePath } from "path-ts"
import zod from "zod"

import { type Check, CheckList, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { artifactURL, BUNDLES, needsDownload, resolveBundleArtifacts, type BundleArtifact } from "../../data-bundles.ts"
import { readReleaseManifest, resolveShardPath, type DataReleaseManifest } from "../../data-release.ts"
import { formatBytes } from "../../doctor/checks.ts"

// `.default([])` (not just `.optional()`) is what makes Pastel emit an OPTIONAL variadic argument
// (`[bundle...]`, zero or more) instead of a required one (`<bundle...>`) — see
// `pastel/build/generate-arguments.js`'s `ZodArray` branch: only `ZodDefault`/`ZodOptional` wrapping
// sets `isOptionalByDefault`. A bare `zod.array(...)` renders `<bundle...>` and Commander then REQUIRES
// at least one positional, so a bare `mailwoman data status` would error instead of reporting on
// every bundle.
const ArgumentsSchema = zod
	.array(zod.string())
	.default([])
	.describe(`Bundle name(s) to report on. Default: every bundle (${Object.keys(BUNDLES).join(", ")})`)

const OptionsSchema = zod.object({
	checkRemote: zod
		.boolean()
		.optional()
		.default(false)
		.describe("HEAD each present artifact's live Content-Length via APIClient instead of trusting the recorded size"),
	dataRoot: zod
		.string()
		.optional()
		.describe("Override the data root (default: $MAILWOMAN_DATA_ROOT or the built-in default)"),
})

export { ArgumentsSchema as args, OptionsSchema as options }

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

function existingLocalPath(
	dataRoot: string,
	manifest: DataReleaseManifest | null,
	artifact: BundleArtifact,
	resolvedAbsPath: string
): string | null {
	if (artifact.family && artifact.stateSlug) {
		return resolveShardPath(dataRoot, artifact.family, artifact.stateSlug, manifest)
	}

	return existsSync(resolvedAbsPath) ? resolvedAbsPath : null
}

async function statusForBundles(
	bundleNames: string[],
	dataRoot: string,
	checkRemote: boolean
): Promise<{ ok: boolean; checks: Check[] }> {
	const manifest = readReleaseManifest(dataRoot)
	const checks: Check[] = []
	let ok = true

	const client = checkRemote
		? new APIClient({ displayName: "mailwoman data status", minRequestIntervalMs: 150, retry: true })
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
			const existing = existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

			if (!existing) {
				ok = false

				checks.push({
					ok: false,
					check: label,
					detail: `missing (expected ~${formatBytes(artifact.approxBytes)}) — mailwoman data pull ${name}`,
				})

				continue
			}

			const sizeBytes = statSync(existing).size

			const expected = checkRemote
				? ((await headContentLength(client!, artifact)) ?? artifact.approxBytes)
				: artifact.approxBytes

			const stale = needsDownload({ exists: true, sizeBytes }, { contentLength: expected })

			ok = ok && !stale

			checks.push({
				ok: !stale,
				check: label,
				detail: stale
					? `stale — ${formatBytes(sizeBytes)} on disk vs ${formatBytes(expected)} ${checkRemote ? "(live)" : "(recorded)"} at ${existing}`
					: `present (${formatBytes(sizeBytes)}) at ${existing}`,
			})
		}
	}

	if (client) {
		await client[Symbol.asyncDispose]()
	}

	return { ok, checks }
}

const DataStatus: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const dataRoot = options.dataRoot ?? mailwomanDataRoot()
		const names = args.length ? args : Object.keys(BUNDLES)

		return statusForBundles(names, dataRoot, options.checkRemote)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} />
	}

	return <Text color="gray">checking…</Text>
}

export default DataStatus
