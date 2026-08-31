/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus upload` — push a corpus version, the tokenizer, or the training code to R2.
 *
 *   R2 IS THE ONLY WAY IN. `modal volume put` writes to the training volume are visible to
 *   `modal volume ls/get` and NOT to containers — `train_remote.py` documents that in its own source,
 *   and it is why every remote artifact travels local → R2 → container-side rclone. A corpus that never
 *   reaches R2 cannot reach a GPU.
 *
 *   VERSION-GENERAL BY ARGUMENT. This command used to carry a hardcoded five-step script — "sync corpus
 *   v0.3.0", "sync corpus v0.4.0", tokenizer, code — so a new corpus version could not be uploaded
 *   without editing it. Worse, the hardcoded versions had stopped existing locally, so the very first
 *   step failed on a checkout where they were absent and buried the reason under rclone's harmless
 *   missing-config NOTICE. That failure reads as "R2 is not configured" and is not.
 *
 *   Credentials come from `RCLONE_S3_*` in the typed private env, consumed through rclone's `:s3:`
 *   connection-string form. **No `rclone.conf` is involved**, so the NOTICE about one being absent is
 *   expected output, not a fault — it is suppressed here so it stops being read as an error.
 */

import { $private } from "@mailwoman/core/env"
import { pathExists, readDirectory } from "@mailwoman/core/fs/readers"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

const DEFAULT_BUCKET = "mailwoman-assets"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "upload",
	description: "Upload a corpus version, tokenizer, or training code to R2",
	options: {
		bucket: { type: "string", default: DEFAULT_BUCKET, description: "R2 bucket name" },
		"corpus-version": {
			type: "string",
			description: "Corpus version directory under <data-root>/corpus/versioned (repeatable, comma-separated)",
		},
		"corpus-dir": { type: "string", description: "Local corpus root. Default <data-root>/corpus/versioned" },
		tokenizer: { type: "boolean", default: false, description: "Also sync the tokenizer" },
		code: { type: "boolean", default: false, description: "Also sync corpus-python (the training code)" },
		"dry-run": { type: "boolean", default: false, description: "Report the plan and transfer nothing" },
	},
} as const satisfies CommandSpec

interface Options {
	bucket: string
	corpusVersion?: string
	corpusDir?: string
	tokenizer: boolean
	code: boolean
	dryRun: boolean
}

interface Step {
	label: string
	status: "pending" | "running" | "done" | "error" | "skipped"
	detail?: string
}

const MARK: Record<Step["status"], string> = {
	pending: "○",
	running: "◼",
	done: "✓",
	error: "✗",
	skipped: "–",
}

const CorpusUpload: ParsedCommandComponent<Options> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([])

	const state = useCommandTask(async () => {
		const { $ } = await import("zx")

		const { join } = await import("path-ts")

		const corpusRoot = options.corpusDir ?? String(dataRootPath("corpus", "versioned"))

		const versions = (options.corpusVersion ?? "")
			.split(",")
			.map((v) => v.trim())
			.filter((version) => version.length > 0)

		if (!versions.length && !options.tokenizer && !options.code) {
			const available = (await pathExists(corpusRoot)) ? (await readDirectory(corpusRoot)).toSorted().slice(-6) : []

			throw new Error(
				"nothing selected. Pass --corpus-version <v> (and/or --tokenizer, --code).\n" +
					`Recent versions under ${corpusRoot}:\n  ${available.join("\n  ")}`
			)
		}

		// rclone reads `:s3:` credentials from the environment. Point RCLONE_CONFIG at nothing so the
		// "config file not found" NOTICE stops appearing in output that people read as a failure.
		const env = childEnv({
			RCLONE_CONFIG: "",
			RCLONE_S3_PROVIDER: "Cloudflare",
			RCLONE_S3_ENDPOINT: $private.RCLONE_S3_ENDPOINT ?? "",
			RCLONE_S3_ACCESS_KEY_ID: $private.RCLONE_S3_ACCESS_KEY_ID ?? "",
			RCLONE_S3_SECRET_ACCESS_KEY: $private.RCLONE_S3_SECRET_ACCESS_KEY ?? "",
		})

		if (!env["RCLONE_S3_ENDPOINT"] || !env["RCLONE_S3_ACCESS_KEY_ID"]) {
			throw new Error(
				"RCLONE_S3_ENDPOINT / RCLONE_S3_ACCESS_KEY_ID absent from the private env. These are the " +
					"credentials, not an rclone.conf — a missing config file is normal for the `:s3:` form."
			)
		}

		const base = `:s3:${options.bucket}`
		const dry = options.dryRun ? ["--dry-run"] : []

		interface Job {
			label: string
			source: string
			dest: string
			extra: string[]
		}

		const jobs: Job[] = []

		for (const version of versions) {
			// The on-disk layout nests the corpus under its own name: <root>/<version>/corpus-<version>/.
			const nested = join(corpusRoot, version, `corpus-${version}`)
			const source = (await pathExists(nested)) ? nested : join(corpusRoot, version)

			jobs.push({
				label: `corpus ${version}`,
				source,
				dest: `${base}/corpus/${version}/`,
				extra: ["--transfers", "8", "--checkers", "16"],
			})
		}

		if (options.tokenizer) {
			jobs.push({
				label: "tokenizer",
				source: String(dataRootPath("models", "tokenizer")),
				dest: `${base}/models/tokenizer/`,
				extra: ["--transfers", "4"],
			})
		}

		if (options.code) {
			jobs.push({
				label: "training code",
				source: "./corpus-python/",
				dest: `${base}/corpus-python/`,
				extra: ["--exclude", ".venv/**", "--exclude", "__pycache__/**", "--exclude", "*.egg-info/**"],
			})
		}

		setSteps(jobs.map((j) => ({ label: j.label, status: "pending" as const })))

		const update = (index: number, patch: Partial<Step>) =>
			setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))

		for (const [index, job] of jobs.entries()) {
			// CHECK THE SOURCE FIRST. rclone's own error for an absent directory arrives buried under the
			// config NOTICE, which is exactly how "this version does not exist here" got read as "R2 is
			// broken". Say which path was missing instead.
			if (!(await pathExists(job.source))) {
				update(index, { status: "error", detail: `not found locally: ${job.source}` })

				continue
			}

			update(index, { status: "running" })

			try {
				await $({ env })`rclone sync ${job.source} ${job.dest} ${job.extra} ${dry} --stats-one-line`.quiet()
				update(index, { status: "done", detail: options.dryRun ? "would sync" : "synced" })
			} catch (error: unknown) {
				const e = error as Record<string, unknown>

				update(index, { status: "error", detail: String(e["stderr"] ?? e["message"] ?? error).slice(0, 160) })
			}
		}
	})

	// A thrown selection/credential error is the whole message here — rendering only the step list would
	// print a bare header and look like a no-op.
	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return (
		<Box flexDirection="column">
			<Text bold>corpus upload → R2 ({options.bucket})</Text>
			{options.dryRun ? <Text color="yellow">DRY RUN — nothing is transferred</Text> : null}
			<Text> </Text>
			{steps.map((step) => (
				<Text key={step.label}>
					{MARK[step.status]} {step.label}
					{step.detail ? ` — ${step.detail}` : ""}
				</Text>
			))}
		</Box>
	)
}

export default CorpusUpload
