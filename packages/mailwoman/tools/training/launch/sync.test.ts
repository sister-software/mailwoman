/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the staging script under bash against a fake `rclone` over a local directory that stands in for the bucket.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

import { SYNC_SCRIPT } from "#tools/training/launch/sync"

/**
 * An `rclone` that maps `:s3:<bucket>/<path>` onto `$FAKE_BUCKETS/<bucket>/<path>` and runs `ls` or `cp -r`.
 */
const FAKE_RCLONE = String.raw`#!/usr/bin/env bash
command=$1; shift
paths=()
for argument in "$@"; do
	case "$argument" in --*|[0-9]*) ;; *) paths+=("$argument") ;; esac
done
local_of() { printf '%s' "$FAKE_BUCKETS/${"$"}{1#:s3:}"; }
case "$command" in
	lsf) [ -d "$(local_of "${"$"}{paths[0]}")" ] && ls "$(local_of "${"$"}{paths[0]}")" ;;
	copy) cp -r "$(local_of "${"$"}{paths[0]}")/." "${"$"}{paths[1]}" ;;
esac
`

async function stage(layout: "nested" | "wrapped" | "absent", withManifest = true) {
	await using scratch = await temporaryDirectory("mailwoman-sync-")
	const entry = "v0.8.7-overlay"
	const remote = ["buckets", "assets", "corpus", entry, ...(layout === "nested" ? [`corpus-${entry}`] : [])]

	if (layout !== "absent") {
		await writeLocalTextFile("rows", scratch.path(...remote, "train", "part-0000.parquet"))

		if (withManifest) {
			await writeLocalTextFile("{}", scratch.path(...remote, "MANIFEST.json"))
		}
	}

	await writeLocalTextFile(FAKE_RCLONE, scratch.path("rclone"))
	await writeLocalTextFile('#!/usr/bin/env bash\necho "sync $1" >> "$FAKE_LOG"\n', scratch.path("sync"))
	await changeMode(scratch.path("rclone"), 0o755)
	await changeMode(scratch.path("sync"), 0o755)

	const env = {
		MW_BUCKET: "assets",
		MW_ENTRY: entry,
		MW_MOUNT: scratch.path("volume").toString(),
		MW_RCLONE: scratch.path("rclone").toString(),
		MW_SYNC: scratch.path("sync").toString(),
		FAKE_BUCKETS: scratch.path("buckets").toString(),
		FAKE_LOG: scratch.path("syncs.log").toString(),
		PATH: "/usr/bin:/bin",
	}

	const code = await runFile("bash", ["-c", SYNC_SCRIPT], { env }).then(
		() => 0,
		(error: unknown) => {
			if (!isProcessError(error)) throw error

			return Number(error.code)
		}
	)

	const staged = ["volume", "corpus", "versioned", entry, `corpus-${entry}`]

	return {
		code,
		manifest: await pathExists(scratch.path(...staged, "MANIFEST.json")),
		part: await pathExists(scratch.path(...staged, "train", "part-0000.parquet")),
		committed: await pathExists(scratch.path("syncs.log")),
	}
}

describe("the corpus staging script", () => {
	it.each(["nested", "wrapped"] as const)("stages a %s entry at the corpus_dir path and commits", async (layout) => {
		await expect(stage(layout)).resolves.toEqual({ code: 0, manifest: true, part: true, committed: true })
	})

	it("refuses an entry the bucket does not hold", async () => {
		await expect(stage("absent")).resolves.toMatchObject({ code: 1, committed: false })
	})

	it("refuses a copy without a MANIFEST and commits nothing", async () => {
		await expect(stage("wrapped", false)).resolves.toMatchObject({ code: 1, manifest: false, committed: false })
	})
})
