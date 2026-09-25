#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { makeDirectories, removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import type { WeightsArtifactPlan } from "#weights/fetch-hf-weights/plan"

const bucketClient = new APIClient({ displayName: "release-hf-weights", retry: true })

/**
 * Sends a HEAD request for one bucket object and returns `null` when it exists
 * or the failure message otherwise.
 *
 * The message is returned instead of a boolean because a throttled or unroutable
 * probe must not be reported as a missing artifact.
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
 * Downloads one bucket object whole as a `Buffer`, whichever buffer type the HTTP adapter returns.
 */
export async function downloadRemote(url: string): Promise<Buffer> {
	const response = await bucketClient.fetch<ArrayBuffer | Buffer>({ url, responseType: "arraybuffer" })
	const body = response.data

	return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

/**
 * Writes `bytes` to a workspace file after removing whatever is at the destination, because
 * writing through an existing symlink leaves a symlink that the package registry rejects.
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
