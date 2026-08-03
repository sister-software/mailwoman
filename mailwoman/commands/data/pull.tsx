/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data pull <bundle...>` — the consumer download path (#task-6): fetch a named data
 *   bundle (`candidate`, `us`, `fr`, `poi` — see `data-bundles.ts` for what each ships) from the
 *   public R2 bucket into the local data root, atomically. This is the command `mailwoman doctor`'s
 *   fix hints now point at instead of a bare `curl` line.
 *
 *   NETWORKING SPLIT (AGENTS.md's file-transfer carve-out, applied): the small per-artifact HEAD
 *   probe (`Content-Length`, and — for a bundle that ships one — the `.md5` sidecar text) goes
 *   through `APIClient` (paced, retried, mapped errors — the repo default for API requests). The
 *   artifact BODY itself — every one of these is tens of MB to several GB — is streamed straight to
 *   disk with raw `fetch`, exactly like `osm/sdk/fetch.ts`: response caching is nonsense at this
 *   size, there's nothing to pace on a one-shot GET, and axios buffers a non-stream response type in
 *   memory.
 *
 *   Download → verify → atomic move: each artifact lands at `<dataRoot>/tmp/` first, gets checked
 *   against the sidecar md5 (when `BundleArtifact.md5Sidecar` is true — no shipped artifact publishes
 *   one today, see `data-bundles.ts`'s docstring) or the HEAD `Content-Length` (with a loud warning
 *   when neither signal is available), gets sealed (`sealDatabase`), then `swapDatabaseIntoPlace`
 *   moves it into its final convention path — a crash mid-download can never corrupt an existing
 *   install (`core/utils/sealed-db.ts`'s discipline, applied to a download instead of a local build).
 *
 *   `--dry-run` prints the plan with ZERO network calls: existing-file detection is a plain
 *   filesystem stat (`resolveShardPath` for the versioned `us` per-state shards, `existsSync`
 *   otherwise), never a HEAD. `--only <substring>` narrows a bundle to matching artifacts (e.g.
 *   `data pull us --only nh` for one state instead of the whole ~41 GB tier).
 *
 *   A successful `candidate` pull prints the `export MAILWOMAN_CANDIDATE_DB=...` line `mailwoman
 *   doctor` used to be the only place showing — candidate.db resolution is env-gated
 *   (`resolver-backend.ts`'s `resolveCandidateDBPath`), so writing the file alone doesn't wire it up;
 *   this is the ledgered product finding (FR addresses geocoding to the US on the FTS default) whose
 *   fix path is the candidate backend, so the env line has to be impossible to miss.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { APIClient } from "@mailwoman/core/api"
import { mailwomanDataRoot, md5File, sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/core/utils"
import { Text } from "ink"
import { resolvePath } from "path-ts"
import zod from "zod"

import { type Check, CheckList, commandError, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import {
	artifactURL,
	BUNDLES,
	filterArtifacts,
	resolveBundleArtifacts,
	type BundleArtifact,
	type RemoteArtifactState,
} from "../../data-bundles.ts"
import { readReleaseManifest, resolveShardPath, type DataReleaseManifest } from "../../data-release.ts"
import { formatBytes } from "../../doctor/checks.ts"

const ArgumentsSchema = zod.array(zod.string()).describe(`Bundle name(s) to pull: ${Object.keys(BUNDLES).join(", ")}`)

const OptionsSchema = zod.object({
	dryRun: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Print the download plan; touch no network and write nothing"),
	only: zod
		.string()
		.optional()
		.describe("Only pull artifacts whose remote/local path or state slug contains this substring (e.g. --only nh)"),
	force: zod.boolean().optional().default(false).describe("Re-download even when a local copy already appears present"),
	dataRoot: zod
		.string()
		.optional()
		.describe("Override the data root for this pull (default: $MAILWOMAN_DATA_ROOT or the built-in default)"),
})

export { ArgumentsSchema as args, OptionsSchema as options }

/**
 * The path a `us`-family artifact ALREADY occupies on disk (versioned or legacy, via `resolveShardPath`), or the
 * artifact's own resolved path for a non-family artifact — `null` when nothing is there yet.
 */
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

/**
 * HEAD the artifact (and, when it publishes one, GET its `.md5` sidecar) via the paced/retried `APIClient`. Failures
 * degrade to an empty state rather than throwing — a HEAD that 404s or times out just means "can't verify", handled
 * downstream as a warning, not a hard stop (the GET that follows is the real signal on whether the artifact exists).
 */
async function probeRemote(client: APIClient, artifact: BundleArtifact): Promise<RemoteArtifactState> {
	const url = artifactURL(artifact)
	const state: RemoteArtifactState = {}

	try {
		const res = await client.fetch({ method: "head", url })
		const len = res.headers["content-length"]

		if (len) {
			state.contentLength = Number(len)
		}
	} catch {
		// No live Content-Length — the caller falls back to a warning rather than forcing a re-fetch decision on it.
	}

	if (artifact.md5Sidecar) {
		try {
			const res = await client.fetch<string>({ method: "get", url: `${url}.md5`, responseType: "text" })

			state.md5 = String(res.data).trim().split(/\s+/)[0]
		} catch {
			// No sidecar reachable — falls back to the content-length check above.
		}
	}

	return state
}

/**
 * Stream a GET straight to disk, counting bytes as they pass — the raw-`fetch` half of the networking split (see the
 * module docstring). Mirrors `osm/sdk/fetch.ts`'s `downloadExtract` almost exactly — the one addition is the `Range:
 * bytes=0-` header.
 *
 * MEASURED 2026-08-03 against the live bucket: a plain GET with no `Range` header on `street/us/nh/situs.db` returned
 * Cloudflare's own 403 "Attention Required" block page — reproduced identically with `curl`, native `fetch`, and
 * `axios`, so it's not a client quirk. A HEAD on the same URL returns 200 fine, and a ranged GET (`curl -r 0-`, or this
 * header) returns 206 and streams the complete object end to end (verified byte-for-byte against the known 20,480-byte
 * size). The bucket's intended consumer (`sql.js-httpvfs` in the browser demo) always byte-ranges, so an unranged GET
 * is exactly the request shape nothing else here ever makes — this is almost certainly a WAF rule scoped to that
 * difference, not a fluke. `bytes=0-` (open-ended from the start) is the fix: satisfies the ranged-request requirement
 * while still asking for, and receiving, the whole file.
 */
async function downloadToDisk(url: string, destPath: string): Promise<number> {
	const res = await fetch(url, { headers: { range: "bytes=0-" } })

	if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}) for ${url}`)
	let bytes = 0

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength
			controller.enqueue(chunk)
		},
	})

	await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(destPath))

	return bytes
}

interface PullOutcome {
	ok: boolean
	checks: Check[]
	pulledCandidate: boolean
}

async function pullBundles(
	bundleNames: string[],
	opts: { dryRun: boolean; only?: string; force: boolean; dataRoot: string }
): Promise<PullOutcome> {
	const { dataRoot } = opts
	const manifest = readReleaseManifest(dataRoot)
	const checks: Check[] = []
	let ok = true
	let pulledCandidate = false

	const client = opts.dryRun
		? null
		: new APIClient({ displayName: "mailwoman data", minRequestIntervalMs: 150, retry: true })

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

		const artifacts = filterArtifacts(resolveBundleArtifacts(bundle, manifest), opts.only)

		if (!artifacts.length) {
			ok = false
			checks.push({ ok: false, check: `${name} --only ${opts.only}`, detail: "no artifacts matched --only" })

			continue
		}

		for (const artifact of artifacts) {
			const label = `${name}: ${artifact.remotePath}`
			const localAbsPath = resolvePath(dataRoot, artifact.localPath)
			const existing = existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

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
					detail: `[dry-run] ${formatBytes(artifact.approxBytes)} ${artifactURL(artifact)} → ${localAbsPath}`,
				})

				continue
			}

			console.error(`▸ pull ${artifactURL(artifact)} (~${formatBytes(artifact.approxBytes)}) → ${localAbsPath}`)

			try {
				const remote = await probeRemote(client!, artifact)
				// Staged under THIS pull's data root (not necessarily the env-configured one — `--data-root`
				// overrides it), so `dataRootPath` (which always reads `$MAILWOMAN_DATA_ROOT`) would be wrong here.
				const stageDir = resolvePath(dataRoot, "tmp")

				mkdirSync(stageDir, { recursive: true })
				const tmpPath = resolvePath(stageDir, `${Date.now()}-${basename(artifact.localPath)}`)

				const bytesWritten = await downloadToDisk(artifactURL(artifact), tmpPath)

				let verifyDetail: string

				if (artifact.md5Sidecar && remote.md5) {
					const gotMd5 = await md5File(tmpPath)

					if (gotMd5 !== remote.md5) {
						rmSync(tmpPath, { force: true })
						throw new Error(`${artifact.remotePath}: md5 mismatch (expected ${remote.md5}, got ${gotMd5})`)
					}

					verifyDetail = "md5 verified"
				} else if (remote.contentLength !== undefined) {
					if (bytesWritten !== remote.contentLength) {
						rmSync(tmpPath, { force: true })
						throw new Error(
							`${artifact.remotePath}: downloaded ${bytesWritten} bytes, expected ${remote.contentLength} (Content-Length) — aborting`
						)
					}

					verifyDetail = `content-length verified (${formatBytes(bytesWritten)})`
				} else {
					verifyDetail = `WARNING: no md5 sidecar and no Content-Length available — could not verify (${formatBytes(bytesWritten)} written, trusting the transfer)`
				}

				mkdirSync(dirname(localAbsPath), { recursive: true })
				sealDatabase(tmpPath)
				swapDatabaseIntoPlace(tmpPath, localAbsPath)

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

const DataPull: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			if (!args.length) {
				throw commandError(`mailwoman data pull <bundle...> — known bundles: ${Object.keys(BUNDLES).join(", ")}`)
			}

			const dataRoot = options.dataRoot ?? mailwomanDataRoot()

			const result = await pullBundles(args, {
				dryRun: options.dryRun,
				only: options.only,
				force: options.force,
				dataRoot,
			})

			if (result.pulledCandidate) {
				console.error(`\nexport MAILWOMAN_CANDIDATE_DB=${resolvePath(dataRoot, "wof/candidate.db")}`)
			}

			return result
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return <CheckList checks={state.result.checks} verdict={state.result.ok} />
	}

	return <Text color="gray">pulling…</Text>
}

export default DataPull
