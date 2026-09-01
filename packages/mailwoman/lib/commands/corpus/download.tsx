/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus download` — pull corpus + tokenizer from Cloudflare R2 via rclone.
 *
 *   Intended for GPU provider instances: pulls the versioned corpus, tokenizer, and training code
 *   from R2 at datacenter speed (~1-10 Gbps depending on provider locality). Also works locally for
 *   syncing a fresh checkout.
 *
 *   Requires RCLONE_S3_* env vars (Cloudflare R2 credentials).
 */

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

const DEFAULT_BUCKET = "mailwoman-assets"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "download",
	description: "Download corpus artifacts from R2.",
	options: {
		bucket: { type: "string", default: DEFAULT_BUCKET, description: "R2 bucket" },
		"out-dir": { type: "string", default: mailwomanDataRoot(), description: "Local output root" },
		"dry-run": { type: "boolean", default: false, description: "Show without downloading" },
	},
} as const satisfies CommandSpec

interface Options {
	bucket: string
	outDir: string
	dryRun: boolean
}

interface Step {
	label: string
	status: "pending" | "running" | "done" | "error"
	detail?: string
}

const CorpusDownload: ParsedCommandComponent<Options> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([
		{ label: "Download corpus v0.3.0", status: "pending" },
		{ label: "Download corpus v0.4.0", status: "pending" },
		{ label: "Download tokenizer", status: "pending" },
		{ label: "Download training code", status: "pending" },
	])

	const updateStep = (idx: number, update: Partial<Step>) => {
		setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...update } : s)))
	}

	useCommandTask(async () => {
		const { $ } = await import("zx")

		const rcloneBase = `:s3:${options.bucket}`
		const dryFlag = options.dryRun ? "--dry-run" : ""
		const out = options.outDir

		// Step 0: Download v0.3.0 corpus
		updateStep(0, { status: "running" })

		try {
			await $`rclone sync ${rcloneBase}/corpus/v0.3.0/ ${out}/corpus/versioned/v0.3.0/corpus-v0.3.0/ --progress --transfers 8 --checkers 16 ${dryFlag}`.quiet()
			updateStep(0, { status: "done" })
		} catch (error: unknown) {
			const e = error as Record<string, unknown>
			updateStep(0, { status: "error", detail: String(e.stderr ?? e.message ?? error).slice(0, 100) })

			return
		}

		// Step 1: Download v0.4.0 adapter slices
		updateStep(1, { status: "running" })

		try {
			await $`rclone sync ${rcloneBase}/corpus/v0.4.0/ ${out}/corpus/versioned/v0.4.0/corpus-v0.4.0/ --progress --transfers 4 ${dryFlag}`.quiet()
			updateStep(1, { status: "done" })
		} catch (error: unknown) {
			const e = error as Record<string, unknown>
			updateStep(1, { status: "error", detail: String(e.stderr ?? e.message ?? error).slice(0, 100) })

			return
		}

		// Step 2: Download tokenizer
		updateStep(2, { status: "running" })

		try {
			await $`rclone sync ${rcloneBase}/models/tokenizer/ ${out}/models/tokenizer/ --progress ${dryFlag}`.quiet()
			updateStep(2, { status: "done" })
		} catch (error: unknown) {
			const e = error as Record<string, unknown>
			updateStep(2, { status: "error", detail: String(e.stderr ?? e.message ?? error).slice(0, 100) })

			return
		}

		// Step 3: Download training code
		updateStep(3, { status: "running" })

		try {
			await $`rclone sync ${rcloneBase}/corpus-python/ ./corpus-python/ --progress ${dryFlag}`.quiet()
			updateStep(3, { status: "done" })
		} catch (error: unknown) {
			const e = error as Record<string, unknown>
			updateStep(3, { status: "error", detail: String(e.stderr ?? e.message ?? error).slice(0, 100) })
		}
	})

	return (
		<Box flexDirection="column">
			<Text bold>Corpus Download ← R2 ({options.bucket})</Text>
			{Boolean(options.dryRun) && <Text color="yellow">DRY RUN — no files will be transferred</Text>}
			<Text> </Text>
			{steps.map((step, i) => (
				<Box key={i}>
					<Text>
						{step.status === "done" ? "✓" : step.status === "running" ? "◼" : step.status === "error" ? "✗" : "○"}{" "}
						{step.label}
						{step.detail ? ` — ${step.detail}` : ""}
					</Text>
				</Box>
			))}
		</Box>
	)
}

export default CorpusDownload
