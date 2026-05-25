/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus upload` — sync the local corpus + tokenizer to Cloudflare R2 via rclone.
 *
 *   Uploads the versioned corpus (v0.3.0 base + v0.4.0 adapter shards), the A1 tokenizer, and the
 *   training code to an R2 bucket so that a remote GPU provider can pull them at datacenter speed.
 *
 *   Requires RCLONE_S3_* env vars set in .env (Cloudflare R2 credentials).
 */

import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"
import { $ } from "zx"
import type { CommandComponent } from "../../sdk/cli.js"

const DEFAULT_BUCKET = "mailwoman-assets"
const DEFAULT_CORPUS_DIR = "/data/corpus/versioned"
const DEFAULT_TOKENIZER_DIR = "/data/models/tokenizer"

const OptionsSchema = zod.object({
	bucket: zod.string().optional().default(DEFAULT_BUCKET).describe("R2 bucket name"),
	corpusDir: zod.string().optional().default(DEFAULT_CORPUS_DIR).describe("Local corpus root"),
	tokenizerDir: zod.string().optional().default(DEFAULT_TOKENIZER_DIR).describe("Local tokenizer root"),
	dryRun: zod.boolean().optional().default(false).describe("Show what would be uploaded without uploading"),
})

export { OptionsSchema as options }

type Step = { label: string; status: "pending" | "running" | "done" | "error"; detail?: string }

const CorpusUpload: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([
		{ label: "Create bucket (if needed)", status: "pending" },
		{ label: "Sync corpus v0.3.0", status: "pending" },
		{ label: "Sync corpus v0.4.0", status: "pending" },
		{ label: "Sync tokenizer", status: "pending" },
		{ label: "Sync training code", status: "pending" },
	])

	const updateStep = (idx: number, update: Partial<Step>) => {
		setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...update } : s)))
	}

	useEffect(() => {
		const run = async () => {
			const rcloneBase = `:s3:${options.bucket}`
			const dryFlag = options.dryRun ? "--dry-run" : ""

			// Step 0: Create bucket
			updateStep(0, { status: "running" })
			try {
				await $`rclone mkdir ${rcloneBase} ${dryFlag}`.quiet()
				updateStep(0, { status: "done" })
			} catch {
				updateStep(0, { status: "done", detail: "bucket may already exist" })
			}

			// Step 1: Sync v0.3.0 corpus
			updateStep(1, { status: "running" })
			try {
				const result =
					await $`rclone sync ${options.corpusDir}/v0.3.0/corpus-v0.3.0/ ${rcloneBase}/corpus/v0.3.0/ --progress --transfers 8 --checkers 16 ${dryFlag}`.quiet()
				updateStep(1, { status: "done", detail: "v0.3.0 synced" })
			} catch (_e: unknown) {
				const e = _e as Record<string, unknown>
				updateStep(1, { status: "error", detail: String(e.stderr ?? e.message ?? _e).slice(0, 100) })
				return
			}

			// Step 2: Sync v0.4.0 adapter shards
			updateStep(2, { status: "running" })
			try {
				await $`rclone sync ${options.corpusDir}/v0.4.0/corpus-v0.4.0/ ${rcloneBase}/corpus/v0.4.0/ --progress --transfers 4 ${dryFlag}`.quiet()
				updateStep(2, { status: "done", detail: "v0.4.0 synced" })
			} catch (_e: unknown) {
				const e = _e as Record<string, unknown>
				updateStep(2, { status: "error", detail: String(e.stderr ?? e.message ?? _e).slice(0, 100) })
				return
			}

			// Step 3: Sync tokenizer
			updateStep(3, { status: "running" })
			try {
				await $`rclone sync ${options.tokenizerDir}/ ${rcloneBase}/models/tokenizer/ --progress ${dryFlag}`.quiet()
				updateStep(3, { status: "done", detail: "tokenizer synced" })
			} catch (_e: unknown) {
				const e = _e as Record<string, unknown>
				updateStep(3, { status: "error", detail: String(e.stderr ?? e.message ?? _e).slice(0, 100) })
				return
			}

			// Step 4: Sync training code
			updateStep(4, { status: "running" })
			try {
				await $`rclone sync ./corpus-python/ ${rcloneBase}/corpus-python/ --exclude '.venv/**' --exclude '__pycache__/**' --exclude '*.egg-info/**' --progress ${dryFlag}`.quiet()
				updateStep(4, { status: "done", detail: "training code synced" })
			} catch (_e: unknown) {
				const e = _e as Record<string, unknown>
				updateStep(4, { status: "error", detail: String(e.stderr ?? e.message ?? _e).slice(0, 100) })
				return
			}
		}

		run()
	}, [options])

	return (
		<Box flexDirection="column">
			<Text bold>Corpus Upload → R2 ({options.bucket})</Text>
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

export default CorpusUpload
