/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus download` — pull corpus + tokenizer from Cloudflare R2 via rclone.
 *
 *   Intended for GPU provider instances: pulls the versioned corpus, tokenizer, and training code
 *   from R2 at datacenter speed (~1-10 Gbps depending on provider locality). Also works locally
 *   for syncing a fresh checkout.
 *
 *   Requires RCLONE_S3_* env vars (Cloudflare R2 credentials).
 */

import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import { $ } from "zx"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const DEFAULT_BUCKET = "mailwoman-corpus"

const OptionsSchema = zod.object({
	bucket: zod.string().optional().default(DEFAULT_BUCKET).describe("R2 bucket name"),
	outDir: zod.string().optional().default("/data").describe("Local output root (corpus lands at <outDir>/corpus/, tokenizer at <outDir>/models/tokenizer/)"),
	dryRun: zod.boolean().optional().default(false).describe("Show what would be downloaded without downloading"),
})

export { OptionsSchema as options }

type Step = { label: string; status: "pending" | "running" | "done" | "error"; detail?: string }

const CorpusDownload: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([
		{ label: "Download corpus v0.3.0", status: "pending" },
		{ label: "Download corpus v0.4.0", status: "pending" },
		{ label: "Download tokenizer", status: "pending" },
		{ label: "Download training code", status: "pending" },
	])

	const updateStep = (idx: number, update: Partial<Step>) => {
		setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...update } : s)))
	}

	useEffect(() => {
		const run = async () => {
			const rcloneBase = `:s3:${options.bucket}`
			const dryFlag = options.dryRun ? "--dry-run" : ""
			const out = options.outDir

			// Step 0: Download v0.3.0 corpus
			updateStep(0, { status: "running" })
			try {
				await $`rclone sync ${rcloneBase}/corpus/v0.3.0/ ${out}/corpus/versioned/v0.3.0/corpus-v0.3.0/ --progress --transfers 8 --checkers 16 ${dryFlag}`.quiet()
				updateStep(0, { status: "done" })
			} catch (e: any) {
				updateStep(0, { status: "error", detail: String(e.stderr ?? e.message).slice(0, 100) })
				return
			}

			// Step 1: Download v0.4.0 adapter shards
			updateStep(1, { status: "running" })
			try {
				await $`rclone sync ${rcloneBase}/corpus/v0.4.0/ ${out}/corpus/versioned/v0.4.0/corpus-v0.4.0/ --progress --transfers 4 ${dryFlag}`.quiet()
				updateStep(1, { status: "done" })
			} catch (e: any) {
				updateStep(1, { status: "error", detail: String(e.stderr ?? e.message).slice(0, 100) })
				return
			}

			// Step 2: Download tokenizer
			updateStep(2, { status: "running" })
			try {
				await $`rclone sync ${rcloneBase}/models/tokenizer/ ${out}/models/tokenizer/ --progress ${dryFlag}`.quiet()
				updateStep(2, { status: "done" })
			} catch (e: any) {
				updateStep(2, { status: "error", detail: String(e.stderr ?? e.message).slice(0, 100) })
				return
			}

			// Step 3: Download training code
			updateStep(3, { status: "running" })
			try {
				await $`rclone sync ${rcloneBase}/corpus-python/ ./corpus-python/ --progress ${dryFlag}`.quiet()
				updateStep(3, { status: "done" })
			} catch (e: any) {
				updateStep(3, { status: "error", detail: String(e.stderr ?? e.message).slice(0, 100) })
				return
			}
		}

		run()
	}, [options])

	return (
		<Box flexDirection="column">
			<Text bold>Corpus Download ← R2 ({options.bucket})</Text>
			{options.dryRun && <Text color="yellow">DRY RUN — no files will be transferred</Text>}
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
