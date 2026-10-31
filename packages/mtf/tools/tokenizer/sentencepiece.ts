/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One SentencePiece training call, made with native `spm_train` and written in the Python wheel's model form.
 *
 *   The flags are the keyword arguments a `SentencePieceTrainer.train(**flags)` call took, in the same order and with
 *   the same values. Two lists go through files rather than the command line, because the CLI splits an inline list
 *   on commas and a user-defined symbol may itself be a comma. `minloglevel` sets only the wheel's log level and has
 *   no CLI flag, so it is left off the command line.
 *
 *   `spm_train` sets every trainer flag on its spec, so the model records defaults the caller did not supply.
 *   The wheel's spec holds only fields supplied in the call. After training, the rewrite drops trainer and normalizer
 *   fields absent from the flags. This produces the same bytes the wheel produces for that call.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { editModel, type ModelEditSummary } from "./model.ts"

/**
 * One training argument's value.
 */
export type TrainerFlagValue = string | number | boolean | readonly string[]

/**
 * The keyword arguments of one training call, in call order.
 */
export type TrainerFlags = Readonly<Record<string, TrainerFlagValue>>

/**
 * The list flags `spm_train` reads one entry per line from a file.
 */
const FILE_LIST_FLAGS: Readonly<Record<string, string>> = {
	user_defined_symbols: "user_defined_symbols_file",
	control_symbols: "control_symbols_file",
}

/**
 * The flags only the wheel reads.
 */
const WHEEL_ONLY_FLAGS = new Set(["minloglevel"])

/**
 * This function serializes a list as one CSV row, matching the format Python's
 * `csv.writer` produces for a list flag.
 */
export function csvRow(values: readonly string[]): string {
	return values
		.map((value) =>
			/[",\r\n]/.test(value) || (values.length === 1 && value === "") ? `"${value.replaceAll('"', '""')}"` : value
		)
		.join(",")
}

/**
 * A scalar flag as the wheel's `str(value)` renders it.
 */
function scalar(value: string | number | boolean): string {
	if (typeof value === "boolean") return value ? "true" : "false"

	return String(value)
}

export interface TrainedModel {
	model: string
	vocab: string
	/**
	 * The command line `spm_train` ran with.
	 */
	argv: string[]
	/**
	 * The spec fields the wheel's form dropped.
	 */
	dropped: ModelEditSummary["dropped_fields"]
}

export interface TrainOptions {
	spmTrain: string
	/**
	 * Where the list files and the trainer's log go.
	 */
	workDirectory: string
	/**
	 * The directory where `spm_train` runs.
	 *
	 * Relative `input` and `model_prefix` values resolve from this directory.
	 *
	 * The model records both paths as given, so a recipe written with relative paths
	 * trains to the same bytes in any directory.
	 */
	cwd?: string
}

/**
 * Train with `flags` containing `model_prefix`, then rewrite `<model_prefix>.model` in the wheel's form.
 */
export async function trainSentencePiece(flags: TrainerFlags, options: TrainOptions): Promise<TrainedModel> {
	const prefix = flags["model_prefix"]

	if (typeof prefix !== "string") throw new Error("a training call needs a model_prefix")
	const argv: string[] = []

	for (const [name, value] of Object.entries(flags)) {
		if (WHEEL_ONLY_FLAGS.has(name)) continue

		if (Array.isArray(value)) {
			const listed = value as readonly string[]
			const fileFlag = FILE_LIST_FLAGS[name]

			if (fileFlag) {
				if (!listed.length) continue

				for (const entry of listed) {
					if (/[\r\n]/.test(entry)) throw new Error(`${name} entry ${stringifyJSON(entry)} holds a line break`)
				}

				const file = `${options.workDirectory}/${fileFlag}.txt`

				await writeLocalTextFile(listed, file)
				argv.push(`--${fileFlag}=${file}`)
			} else {
				argv.push(`--${name}=${csvRow(listed)}`)
			}
		} else {
			argv.push(`--${name}=${scalar(value as string | number | boolean)}`)
		}
	}

	const { stderr } = await runFile(options.spmTrain, argv, { maxBuffer: 1 << 30, cwd: options.cwd })

	await writeLocalTextFile(stderr, `${options.workDirectory}/spm_train.log`)
	const base = resolvePath(options.cwd ?? ".", prefix)
	const model = `${base}.model`
	const { dropped_fields } = await editModel(model, model, { wheelFlags: Object.keys(flags) })

	return { model, vocab: `${base}.vocab`, argv, dropped: dropped_fields }
}
