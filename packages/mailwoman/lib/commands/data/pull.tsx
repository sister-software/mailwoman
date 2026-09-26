/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Head probes and `.md5` sidecars go through `APIClient` (paced, retried, mapped errors); artifact bodies stream
 *   straight to disk through the raw-`fetch` `streamToDisk`, because response caching, pacing, and in-memory buffering
 *   do not fit a transfer of tens of MB to several GB.
 *
 *   Each artifact lands at `<dataRoot>/tmp/`, is verified against the sidecar md5 or head `Content-Length`, sealed, then
 *   swapped into place, so a crash mid-download can never corrupt an existing install.
 *
 *   A successful `candidate` pull prints the `export MAILWOMAN_CANDIDATE_DB=...` line because candidate.db resolution
 *   is env-restricted, so writing the file alone does not wire it up.
 */

import type { APIClient } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { CommandError } from "@mailwoman/core/scripting/command"
import { streamToDisk } from "@mailwoman/core/utils"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { Text } from "ink"
import { basename, dirname, type PathBuilderLike, resolvePath } from "path-ts"

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
	describeBundleRights,
	filterArtifacts,
	resolveBundleArtifacts,
	type BundleArtifact,
	type RemoteArtifactState,
} from "#data/bundles"
import { existingLocalPath, readReleaseManifest } from "#data/release"
import { conventionCandidateDBPath } from "#resolver-backend"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "pull",
	description: "",
	positionals: [
		{
			name: "bundle",
			required: true,
			multiple: true,
			description: `Bundle name(s) to pull: ${Object.keys(BUNDLES).join(", ")}`,
		},
	],
	options: {
		"dry-run": {
			type: "boolean",
			default: false,
			description: "Print the download plan; touch no network and write no data",
		},
		only: {
			type: "string",
			description: "Only pull artifacts whose remote/local path or state slug contains this substring (e.g. --only nh)",
		},
		force: {
			type: "boolean",
			default: false,
			description: "Re-download even when a local copy already appears present",
		},
		"data-root": {
			type: "string",
			description: "Override the data root for this pull (default: $MAILWOMAN_DATA_ROOT or the built-in default)",
		},
		host: {
			type: "string",
			validate: (value: string) => URL.canParse(value),
			description:
				"Mirror or private-registry base URL serving the same object keys as the public bucket (e.g. https://mirror.example/mailwoman/). Default: the public bucket.",
		},
	},
} as const satisfies CommandSpec

/**
 * A head that 404s or times out degrades to an empty state rather than throwing,
 * because the GET that follows is the real signal on whether the artifact exists.
 */
async function probeRemote(
	client: APIClient,
	artifact: BundleArtifact,
	baseURL?: string
): Promise<RemoteArtifactState> {
	const url = artifactURL(artifact, baseURL)
	const state: RemoteArtifactState = {}

	try {
		const res = await client.fetch({ method: "head", url })
		const len = res.headers["content-length"]

		if (len) {
			state.contentLength = Number(len)
		}
	} catch {
		// No live Content-Length; the caller falls back to a warning rather than forcing a re-fetch decision.
	}

	if (artifact.md5Sidecar) {
		try {
			const res = await client.fetch<string>({
				method: "get",
				url: `${url}.md5`,
				responseType: "text",
				headers: { range: "bytes=0-" },
			})

			state.md5 = String(res.data).trim().split(/\s+/)[0]
		} catch (error) {
			console.error(
				`WARNING: md5 sidecar fetch failed for ${url}.md5 (${error instanceof Error ? error.message : String(error)}) — falling back to size verification`
			)
		}
	}

	return state
}

/**
 * A plain GET with no `Range` header against the live bucket returns Cloudflare's
 * 403 block page while a ranged GET returns 206 and streams the whole object,
 * so every transfer here carries `Range: bytes=0-`.
 */
async function downloadToDisk(url: string, destPath: string): Promise<number> {
	return await streamToDisk({
		url,
		destination: destPath,
		context: "mailwoman data pull",
		headers: { range: "bytes=0-" },
	})
}

interface PullOutcome {
	ok: boolean
	checks: Check[]
	pulledCandidate: boolean
}

async function pullBundles(
	bundleNames: string[],
	opts: { dryRun: boolean; only?: string; force: boolean; dataRoot: PathBuilderLike; host?: string }
): Promise<PullOutcome> {
	const { dataRoot } = opts
	const manifest = await readReleaseManifest(dataRoot)
	const checks: Check[] = []
	let ok = true
	let pulledCandidate = false

	const client = opts.dryRun
		? null
		: new (await import("@mailwoman/core/api")).APIClient({
				displayName: "mailwoman data",
				minRequestIntervalMs: 150,
				retry: true,
			})

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

		// Rights are printed before the transfer because taking a copy is the act the
		// terms govern, so an operator can still decline.
		for (const line of describeBundleRights(bundle)) {
			checks.push({ ok: true, check: `${name}: terms`, detail: line })
		}

		const artifacts = filterArtifacts(resolveBundleArtifacts(bundle, manifest), opts.only)

		if (!artifacts.length) {
			ok = false
			checks.push({ ok: false, check: `${name} --only ${opts.only}`, detail: "no artifacts matched --only" })

			continue
		}

		for (const artifact of artifacts) {
			const label = `${name}: ${artifact.remotePath}`
			const localAbsPath = bundleArtifactPath(dataRoot, artifact)
			const existing = await existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

			if (existing && !opts.force) {
				checks.push({ ok: true, check: label, detail: `already present (${existing}) — skipped` })

				if (name === "candidate") {
					pulledCandidate = true
				}

				continue
			}

			if (opts.dryRun) {
				checks.push({
					ok: true,
					check: label,
					detail: `[dry-run] ${ByteFormatter.formatSI(artifact.approxBytes)} ${artifactURL(artifact, opts.host)} → ${localAbsPath}`,
				})

				continue
			}

			console.error(
				`▸ pull ${artifactURL(artifact, opts.host)} (~${ByteFormatter.formatSI(artifact.approxBytes)}) → ${localAbsPath}`
			)

			try {
				const remote = await probeRemote(client!, artifact, opts.host)
				// Staged under this pull's data root because `--data-root` overrides
				// `dataRootPath`'s `$MAILWOMAN_DATA_ROOT`.
				const stageDir = resolvePath(dataRoot, "tmp")

				await makeDirectories(stageDir)
				const tmpPath = resolvePath(stageDir, `${Date.now()}-${basename(artifact.localPath)}`)

				const bytesWritten = await downloadToDisk(artifactURL(artifact, opts.host), tmpPath)

				let verifyDetail: string

				if (artifact.md5Sidecar && remote.md5) {
					const gotMd5 = await md5File(tmpPath)

					if (gotMd5 !== remote.md5) {
						await removePathIfPresent(tmpPath)
						throw new Error(`${artifact.remotePath}: md5 mismatch (expected ${remote.md5}, got ${gotMd5})`)
					}

					verifyDetail = "md5 verified"
				} else if (remote.contentLength !== undefined) {
					if (bytesWritten !== remote.contentLength) {
						await removePathIfPresent(tmpPath)
						throw new Error(
							`${artifact.remotePath}: downloaded ${bytesWritten} bytes, expected ${remote.contentLength} (Content-Length) — aborting`
						)
					}

					verifyDetail = `content-length verified (${ByteFormatter.formatSI(bytesWritten)})`
				} else {
					verifyDetail = `WARNING: no md5 sidecar and no Content-Length available — could not verify (${ByteFormatter.formatSI(bytesWritten)} written, trusting the transfer)`
				}

				await makeDirectories(dirname(localAbsPath))
				await sealDatabase(tmpPath)
				await swapDatabaseIntoPlace(tmpPath, localAbsPath)

				checks.push({ ok: true, check: label, detail: `${verifyDetail} → ${localAbsPath}` })

				if (name === "candidate") {
					pulledCandidate = true
				}
			} catch (error) {
				ok = false
				checks.push({ ok: false, check: label, detail: error instanceof Error ? error.message : String(error) })
			}
		}
	}

	if (client) {
		await client[Symbol.asyncDispose]()
	}

	return { ok, checks, pulledCandidate }
}

const DataPull: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			if (!args.length) {
				throw new CommandError(`mailwoman data pull <bundle...> — known bundles: ${Object.keys(BUNDLES).join(", ")}`)
			}

			const dataRoot = options.dataRoot ?? dataRootPath()

			const result = await pullBundles(args, {
				dryRun: options.dryRun,
				only: options.only,
				force: options.force,
				dataRoot,
				host: options.host,
			})

			if (result.pulledCandidate) {
				console.error(`\nexport MAILWOMAN_CANDIDATE_DB=${conventionCandidateDBPath(dataRoot)}`)
			}

			return result
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">pulling…</Text>} />

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} verdict={state.result.ok} />
	}

	return null
}

export default DataPull
