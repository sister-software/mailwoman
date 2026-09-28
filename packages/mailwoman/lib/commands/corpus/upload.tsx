/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A corpus must reach R2 before a GPU can access it. `modal volume put` writes are visible to
 *   `modal volume ls/get`. Containers cannot read those writes. Every remote artifact therefore travels
 *   from the local machine to R2, then through container-side rclone.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { BuildCorpusManifest } from "@mailwoman/corpus/build"
import { Box, Text } from "ink"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { useState } from "react"
import { Globerator } from "spliterator/node/fs"

import { isCorpusVersion, type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import { $private } from "#env"

const DEFAULT_BUCKET = "mailwoman-assets"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "upload",
	description: "Upload a corpus version, tokenizer, or training code to R2",
	options: {
		bucket: { type: "string", default: DEFAULT_BUCKET, description: "R2 bucket name" },
		"corpus-version": {
			type: "string",
			validate: isCorpusVersion,
			validationMessage:
				"--corpus-version is the version alone, without the `corpus-v` prefix, as `0.7.0` or `0.7.0-de-holdout`.",
			description: "Corpus version directory under <data-root>/corpus/versioned (repeatable, comma-separated)",
		},
		"corpus-dir": { type: "string", description: "Local corpus root. Default <data-root>/corpus/versioned" },
		tokenizer: { type: "boolean", default: false, description: "Also sync the tokenizer" },
		code: { type: "boolean", default: false, description: "Also sync corpus-python (the training code)" },
		"dry-run": { type: "boolean", default: false, description: "Report the plan and transfer nothing" },
		"allow-share-alike": {
			type: "boolean",
			default: false,
			description:
				"Upload a corpus version whose license set carries or mentions share-alike. " +
				"Without it the upload refuses and reports the values and row counts it read",
		},
	},
} as const satisfies CommandSpec

/**
 * The fields this command reads from a built corpus version's top-level `MANIFEST.json`.
 *
 * Taken from `BuildCorpusManifest` so the field names cannot drift from what the build writes.
 * Both are optional because a manifest written before the build recorded them still parses.
 *
 * An absent `license_policy` reads as unstated rather than as a policy that ran.
 */
type UploadedCorpusManifest = Partial<Pick<BuildCorpusManifest, "licenses" | "license_policy">>

/**
 * Throws when a corpus version's own license set carries or mentions share-alike.
 *
 * The decision reads the obligations recorded for each license value the corpus stores,
 * through `shareAlikeFindings`.
 * It does not read source ids, adapter names or license-string prefixes,
 * because a row's obligation is a property of its license value and a share-alike
 * register can reach a corpus through a source whose id says otherwise.
 *
 * An unreadable or absent `MANIFEST.json` throws as well.
 * A corpus whose license set cannot be read is an unanswered question rather than a clean one.
 */
async function refuseShareAlike(version: string, manifestPath: PathBuilderLike, allow: boolean): Promise<void> {
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")
	const { shareAlikeFindings } = await import("@mailwoman/corpus/utils/license")

	let manifest: UploadedCorpusManifest

	try {
		manifest = await readLocalJSONFile<UploadedCorpusManifest>(manifestPath)
	} catch (error) {
		throw new Error(
			`corpus ${version}: ${manifestPath} could not be read (${(error as Error).message}), so its license ` +
				`set is unknown. Build the version through \`mw corpus build\`, which writes it, or pass ` +
				`--allow-share-alike to upload without the check.`
		)
	}

	if (!manifest.licenses) {
		throw new Error(
			`corpus ${version}: ${manifestPath} records no \`licenses\` map, so its license set is unknown. ` +
				`Pass --allow-share-alike to upload without the check.`
		)
	}

	const findings = shareAlikeFindings(manifest.licenses)

	if (!findings.length) return

	const rows = findings.reduce((total, finding) => total + finding.rows, 0)
	const lines = findings.map((finding) => `  ${finding.kind}  ${finding.rows} rows  ${finding.license}`)

	if (allow) {
		process.stderr.write(
			`corpus ${version}: uploading ${rows} rows under --allow-share-alike across ` +
				`${findings.length} license value(s):\n${lines.join("\n")}\n`
		)

		return
	}

	throw new Error(
		`corpus ${version}: its license set holds ${findings.length} value(s) carrying or mentioning ` +
			`share-alike over ${rows} rows. The build ran under license policy ` +
			`${manifest.license_policy ?? "unstated"}:\n${lines.join("\n")}\n` +
			`Rebuild with \`mw corpus build --license-policy share-alike-free\`, or pass --allow-share-alike ` +
			`to upload this set deliberately.`
	)
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

const CorpusUpload: CommandComponent<typeof spec> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([])

	const state = useCommandTask(async () => {
		const { $ } = await import("zx")

		const corpusRoot = PathBuilder.from(options.corpusDir ?? dataRootPath("corpus", "versioned"))

		const versions = extractDelimited(options.corpusVersion)

		if (!versions.length && !options.tokenizer && !options.code) {
			const available = (await pathExists(corpusRoot))
				? (await Globerator.from("*", { cwd: corpusRoot, absolute: false }).toSorted()).slice(-6)
				: []

			throw new Error(
				"nothing selected. Pass --corpus-version <v> (and/or --tokenizer, --code).\n" +
					`Recent versions under ${corpusRoot}:\n  ${available.join("\n  ")}`
			)
		}

		// rclone reads `:s3:` credentials from the environment.
		// Pointing RCLONE_CONFIG at an empty path keeps its absent-config notice from being read as a failure.
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
			source: PathBuilderLike
			dest: string
			extra: string[]
		}

		const jobs: Job[] = []

		for (const version of versions) {
			// The on-disk layout nests the corpus under its own name: <root>/<version>/corpus-<version>/.
			const nested = corpusRoot(version, `corpus-${version}`)
			const source = (await pathExists(nested)) ? nested : corpusRoot(version)

			await refuseShareAlike(version, corpusRoot(version, "MANIFEST.json"), options.allowShareAlike)

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
				source: dataRootPath("models", "tokenizer"),
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
			// An absent source is reported here because rclone's own error arrives buried under
			// the config notice, where "this version does not exist here" reads as a broken R2.
			if (!(await pathExists(job.source))) {
				update(index, { status: "error", detail: `not found locally: ${job.source}` })

				continue
			}

			update(index, { status: "running" })

			try {
				await $({ env })`rclone sync ${job.source.toString()} ${job.dest} ${job.extra} ${dry} --stats-one-line`.quiet()
				update(index, { status: "done", detail: options.dryRun ? "would sync" : "synced" })
			} catch (error: unknown) {
				const e = error as Record<string, unknown>

				update(index, { status: "error", detail: String(e["stderr"] ?? e["message"] ?? error).slice(0, 160) })
			}
		}
	})

	// A thrown selection or credential error is the whole message.
	// Rendering only the step list would print a bare header.
	// Readers could mistake it for a completed upload of zero files.
	if (state.status === "error") return <CommandTaskResult state={state} />

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
