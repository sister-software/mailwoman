#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize a release's weights artifacts from the PUBLIC Hugging Face bucket — the `--source hf`
 *   half of the #1894 preflight, and the recipe `.github/workflows/publish.yml` now calls in place of
 *   the curl-and-cp block it used to carry inline. ONE recipe, two callers: the preflight points it at
 *   a staging tree, the publish job points it at the checkout. `copy-weights.ts` is the same shape for
 *   the operator's data root; both take a destination root and touch nothing else.
 *
 *   WHAT IS FETCHED IS DERIVED, NOT LISTED. A `neural-weights-<locale>` package's `files` array is its
 *   author stating which artifacts the tarball carries, and `git ls-files` says which of those a
 *   checkout already has; the difference is exactly the set something must materialize — the same
 *   predicate `verify-tarball.ts` refuses a publish over (`literalFilesEntries`, shared with it). The
 *   v9.2.0 release published 49 of 51 workspaces before that audit refused
 *   `@mailwoman/neural-weights-en-au`, whose four declared lexicons the YAML's hand-maintained copy
 *   list did not name. A derived list cannot fall behind a manifest that way.
 *
 *   NO CREDENTIALS, NO WRITES ANYWHERE BUT THE DESTINATION ROOT. The bucket is public — the same files
 *   the browser demo loads. Nothing here writes to Hugging Face, npm, git, or R2.
 */

import { APIClient } from "@mailwoman/core/api"
import { makeDirectories, removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import type { WeightsArtifactPlan } from "#weights/fetch-hf-weights/plan"

/**
 * The bucket client.
 *
 * The house rule routes API REQUESTS through `APIClient` and exempts multi-gigabyte file transfers, where a buffered
 * body is untenable and response caching is nonsense. These objects sit on the API side of that line: the largest is
 * `model.onnx` at 39,419,629 bytes and the whole set is under ~70 MB (measured 2026-08-25 against the v9.1.0
 * directory), each one is md5-checked after arrival, and each is fetched exactly once per run — so a buffered body
 * costs one artifact's worth of memory and a stream would buy nothing. What `APIClient` does buy is the reason the YAML
 * this replaces passed `--retry 6 --retry-all-errors` to every curl: Hugging Face throttles the public bucket from CI,
 * and a 429 read as a missing artifact is the one answer that would have a release believe its weights were never
 * staged.
 *
 * No pacer, deliberately. One run is a score of concurrent HEADs and then sequential whole-object GETs against a public
 * CDN the browser demo already reads at higher concurrency; retry is the only rate control this path has ever needed,
 * and an invented interval would be a number no measurement supports.
 */
const bucketClient = new APIClient({ displayName: "release-hf-weights", retry: true })

/**
 * HEAD-probe one bucket object. Returns the failure's message rather than a bare boolean: a throttled or unroutable
 * probe is indistinguishable from an unstaged artifact at the call site, and "MISSING" is the answer that would send an
 * operator to re-run a staging step that already succeeded.
 */
export async function probeRemote(url: string): Promise<string | null> {
	try {
		await bucketClient.fetch({ url, method: "head" })

		return null
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

/**
 * Download one bucket object whole. Axios's node adapter answers `arraybuffer` with a `Buffer`; its fetch adapter
 * answers with an `ArrayBuffer`, so both shapes are accepted.
 */
export async function downloadRemote(url: string): Promise<Buffer> {
	const response = await bucketClient.fetch<ArrayBuffer | Buffer>({ url, responseType: "arraybuffer" })
	const body = response.data

	return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

/**
 * Write `bytes` to a workspace file.
 *
 * Unlink first. `writeFileSync` FOLLOWS a symlink at the destination and writes THROUGH it, leaving the symlink in
 * place — and the registry refuses a tarball containing one (HTTP 415, YN0035). A dev checkout's weights workspaces are
 * full of symlinks, and the staging tree can inherit one, so the discipline applies to both destinations. Same rule as
 * `copy-weights.ts`; see AGENTS.md "symlinks in the publish tarball".
 */
export async function writeArtifact(destination: string, bytes: Buffer): Promise<void> {
	await makeDirectories(resolvePath(destination, ".."))
	await removePathIfPresent(destination)
	await writeLocalFile(bytes, destination)
}

/**
 * Verify `bytes` against a plan's declared md5, refusing with the artifact named on a mismatch.
 */
export function verifyChecksum(plan: WeightsArtifactPlan, bytes: Buffer, source: string): void {
	if (!plan.expectedMD5) return

	const actual = md5Hex(bytes)

	if (actual !== plan.expectedMD5) {
		throw new Error(
			`fetch-hf-weights: ${plan.filename} does not match the md5 the model cards declare — expected ` +
				`${plan.expectedMD5}, got ${actual} (${source}). A staged object left over from an earlier release is ` +
				"present, non-empty and wrong; re-stage it with `mailwoman release hf` before publishing."
		)
	}
}
