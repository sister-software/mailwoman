/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Launches the Rust trainer on Modal and operates on a launched run.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/launch/launch.run.ts start --config <yaml> [--device A100-80GB | --cpu] \
 *       [--fresh] [--branch-from <checkpoint>] [--threads <n>] [--retries <n>] [--timeout-seconds <s>] \
 *       [--fail-at-step <n>] [--dry-run]
 *     node packages/mailwoman/tools/training/launch/launch.run.ts status <run key>
 *     node packages/mailwoman/tools/training/launch/launch.run.ts logs <run key> [--lines <n>]
 *     node packages/mailwoman/tools/training/launch/launch.run.ts cancel <run key>
 *     node packages/mailwoman/tools/training/launch/launch.run.ts restart <run key>
 *     node packages/mailwoman/tools/training/launch/launch.run.ts fetch <run key> --out <dir> [--checkpoint <step-NNNNNN>]
 *     node packages/mailwoman/tools/training/launch/launch.run.ts sync --corpus <entry>
 *
 *   `start` resolves the config and admits its source rights. It runs the preflight against the host copy
 *   of the volume under `MAILWOMAN_DATA_ROOT`, and starts one detached sandbox. `--dry-run` runs everything up to the
 *   sandbox and prints what it would start, without contacting Modal. `restart` resumes a stopped run from its newest
 *   complete checkpoint in a fresh sandbox. `fetch` copies the run's output directory, or one checkpoint of it, from
 *   the volume to the host. Every command prints the run key the others take. `sync` stages the bucket's
 *   `corpus/<entry>/` onto the volume (`sync.ts`) and waits for it.
 */

import { readLocalBuffer, tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { integerArgument, parseArguments } from "@mailwoman/core/scripting/arguments"
import { buildResolvedTrainingConfig } from "@mailwoman/corpus/training/config/resolved"
import { resolvePath } from "path-ts"

import { trainingConfigPath } from "#tools/training/config"
import type { ModalBoundary, TrainerImageBuild } from "#tools/training/launch/boundary"
import {
	trainerBaseCommands,
	trainerBuildScript,
	TRAINER_BASE_IMAGES,
	trainerImageName,
	trainerRustToolchain,
	trainerSourceBundle,
	type TrainerVariant,
} from "#tools/training/launch/image"
import {
	type LaunchDependencies,
	type LaunchRecord,
	cancelLaunch,
	fetchRun,
	launchStatus,
	restartLaunch,
	startLaunch,
} from "#tools/training/launch/launch"
import { hostPreflight } from "#tools/training/launch/preflight"
import { launchSettings } from "#tools/training/launch/settings"
import { RCLONE_IMAGE, SYNC_SCRIPT } from "#tools/training/launch/sync"
import { TRAIN_TIMEOUT_SECONDS } from "#tools/training/launch/wall-clock"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		config: { type: "string" },
		device: { type: "string" },
		cpu: { type: "boolean", default: false },
		fresh: { type: "boolean", default: false },
		"branch-from": { type: "string" },
		threads: { type: "string", default: "0" },
		retries: { type: "string" },
		"timeout-seconds": { type: "string" },
		"fail-at-step": { type: "string", default: "0" },
		"dry-run": { type: "boolean", default: false },
		lines: { type: "string", default: "100" },
		corpus: { type: "string" },
		out: { type: "string" },
		checkpoint: { type: "string" },
	},
})

/**
 * How long a staging sandbox may copy: a base corpus is about 30 GB.
 */
const SYNC_TIMEOUT_MS = 4 * 60 * 60 * 1000

const [command, runKey] = positionals
const settings = launchSettings
const recordPath = (key: string) => resolvePath(settings.MAILWOMAN_DATA_ROOT, "launch", "runs", `${key}.json`)
const log = (line: string) => console.log(line)

let boundary: ModalBoundary | null = null

/**
 * The SDK boundary, imported only when a command reaches Modal, so a dry run loads no SDK.
 */
async function modal(): Promise<ModalBoundary> {
	if (!boundary) {
		const { SDKModalBoundary } = await import("#tools/training/launch/modal-boundary")

		boundary = new SDKModalBoundary({
			appName: settings.MAILWOMAN_MODAL_APP,
			volumeName: settings.MAILWOMAN_MODAL_VOLUME,
			mount: settings.MAILWOMAN_VOLUME_MOUNT,
			...(settings.MAILWOMAN_MODAL_R2_SECRET ? { secretName: settings.MAILWOMAN_MODAL_R2_SECRET } : {}),
			log,
		})
	}

	return boundary
}

async function imageBuild(variant: TrainerVariant): Promise<TrainerImageBuild> {
	const toolchain = await trainerRustToolchain()
	const bundle = await trainerSourceBundle()
	await using scratch = await temporaryDirectory("mailwoman-trainer-bundle-")
	const list = scratch.path("files.txt").toString()
	const archive = scratch.path("trainer.tar.gz").toString()

	await writeLocalTextFile(bundle.files, list)
	await runFile("tar", ["-czf", archive, "-C", repoRootPath().toString(), "-T", list])

	return {
		name: trainerImageName(variant, toolchain, bundle.digest),
		baseImage: TRAINER_BASE_IMAGES[variant],
		baseCommands: trainerBaseCommands(variant, toolchain),
		buildScript: trainerBuildScript(variant),
		bundle: await readLocalBuffer(archive),
	}
}

function dependencies(configPath: string | null, dryRun: boolean): LaunchDependencies {
	const lazy = new Proxy({} as ModalBoundary, {
		get: (_, name: keyof ModalBoundary) => {
			if (dryRun) throw new Error(`a dry run reaches no Modal call (${String(name)})`)

			return async (...args: unknown[]) => ((await modal())[name] as (...a: unknown[]) => unknown)(...args)
		},
	})

	return {
		boundary: dryRun ? { ...lazy, list: async () => [] } : lazy,
		preflight: (config, device, timeoutSeconds) => {
			if (!configPath) throw new Error("a preflight needs --config")

			return hostPreflight(config, device, {
				configPath,
				mount: settings.MAILWOMAN_VOLUME_MOUNT,
				dataRoot: settings.MAILWOMAN_DATA_ROOT,
				timeoutSeconds,
				log,
			})
		},
		imageBuild,
		readRecord: (key) => tryReadLocalJSONFile<LaunchRecord>(recordPath(key)),
		writeRecord: (record) => writeLocalJSONFile(record, recordPath(record.runKey)),
		log,
	}
}

function requireRunKey(): string {
	if (!runKey) throw new Error(`${command} takes a run key, as \`start\` printed it`)

	return runKey
}

switch (command) {
	case "start": {
		if (!values.config) throw new Error("start needs --config <yaml>")

		// A bare name reads the committed config of that name, with or without its `.yaml` extension.
		const configPath = (await isFile(values.config))
			? resolvePath(values.config).toString()
			: trainingConfigPath(values.config.endsWith(".yaml") ? values.config : `${values.config}.yaml`)

		const document = await buildResolvedTrainingConfig(configPath, { log })
		const train = document.config.train

		const record = await startLaunch(
			{
				name: configPath.split("/").at(-1)!,
				text: await readLocalBuffer(configPath),
				resolvedJSON: stringifyJSON(document),
				configSHA256: document.config_sha256,
				outputDir: train.output_dir,
				csvLogPath: train.csv_log_path,
				maxSteps: train.max_steps,
				evalEverySteps: train.eval_every_steps,
				batchSize: train.batch_size,
			},
			{
				device: values.cpu ? "cpu" : (values.device ?? settings.MAILWOMAN_MODAL_TRAIN_GPU),
				mount: settings.MAILWOMAN_VOLUME_MOUNT,
				fresh: values.fresh,
				...(values["branch-from"] ? { branchFrom: values["branch-from"] } : {}),
				threads: integerArgument("threads", values.threads),
				retries: values.retries ? integerArgument("retries", values.retries) : settings.MAILWOMAN_MODAL_TRAIN_RETRIES,
				timeoutSeconds: values["timeout-seconds"]
					? integerArgument("timeout-seconds", values["timeout-seconds"])
					: TRAIN_TIMEOUT_SECONDS,
				failAtStep: integerArgument("fail-at-step", values["fail-at-step"]),
				dryRun: values["dry-run"],
			},
			dependencies(configPath, values["dry-run"])
		)

		log(`Run key: ${record.runKey}`)

		break
	}

	case "status": {
		const { record, sandbox, state } = await launchStatus(requireRunKey(), dependencies(null, false))

		log(
			`${record.runKey}: ${state} (sandbox ${sandbox.id}, exit ${sandbox.exitCode ?? "none yet"}, ${record.sandboxes.length} sandbox(es))`
		)

		break
	}

	case "logs": {
		const deps = dependencies(null, false)
		const { sandbox } = await launchStatus(requireRunKey(), deps)

		log(await deps.boundary.logs(sandbox.id, integerArgument("lines", values.lines)))

		break
	}

	case "cancel": {
		await cancelLaunch(requireRunKey(), dependencies(null, false))

		break
	}

	case "restart": {
		const record = await restartLaunch(requireRunKey(), dependencies(null, false))

		log(`Run key: ${record.runKey} (sandbox ${record.sandboxes.at(-1)})`)

		break
	}

	case "sync": {
		if (!values.corpus) throw new Error("sync needs --corpus <entry>, the bucket's corpus/<entry>/")

		const { exitCode, output } = await (
			await modal()
		).runToCompletion({
			registryImage: RCLONE_IMAGE,
			command: ["sh", "-c", SYNC_SCRIPT],
			env: {
				MW_BUCKET: settings.MAILWOMAN_R2_BUCKET,
				MW_ENTRY: values.corpus,
				MW_MOUNT: settings.MAILWOMAN_VOLUME_MOUNT,
				MW_RCLONE: "rclone",
				MW_SYNC: "sync",
			},
			withSecret: true,
			cpu: 4,
			memoryMiB: 8192,
			timeoutMs: SYNC_TIMEOUT_MS,
		})

		log(output.trimEnd())

		if (exitCode !== 0) throw new Error(`the staging sandbox exited ${exitCode}`)

		break
	}

	case "fetch": {
		if (!values.out) throw new Error("fetch needs --out <directory>")

		const files = await fetchRun(requireRunKey(), values.checkpoint ?? null, values.out, dependencies(null, false))

		log(`Fetched ${files.length} file(s) into ${values.out}`)

		break
	}

	default:
		throw new Error("the first argument is one of start, status, logs, cancel, restart, fetch or sync")
}
