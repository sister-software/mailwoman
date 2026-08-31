/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-neutral command metadata and the small `node:util.parseArgs` adapter behind Mailwoman's lazy CLI.
 * Parsing never imports the help renderer; `@isaacs/cliui` is reached only from {@link renderCommandHelp}.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

type OptionValue = boolean | number | string | boolean[] | number[] | string[]

interface OptionSpecBase {
	description: string
	short?: string
	default?: OptionValue
	multiple?: boolean
	required?: boolean
}

interface BooleanOptionSpec extends OptionSpecBase {
	type: "boolean"
	default?: boolean | boolean[]
}

interface NumberOptionSpec extends OptionSpecBase {
	type: "number"
	default?: number | number[]
	hint?: string
	validate?: (value: number) => boolean
	validationMessage?: string
}

interface StringOptionSpec extends OptionSpecBase {
	type: "string"
	default?: string | string[]
	hint?: string
	choices?: readonly string[]
	validate?: (value: string) => boolean
	validationMessage?: string
}

type OptionSpec = BooleanOptionSpec | NumberOptionSpec | StringOptionSpec

interface PositionalSpec {
	name: string
	description: string
	required?: boolean
	multiple?: boolean
	choices?: readonly string[]
	validate?: (value: string) => boolean
	validationMessage?: string
}

export interface CommandSpec {
	name: string
	description: string
	usage?: string
	options?: Readonly<Record<string, OptionSpec>>
	positionals?: readonly PositionalSpec[]
}

export interface ParsedCommand {
	positionals: string[]
	values: Record<string, OptionValue | undefined>
}

export class CLIError extends CommandError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "CLIError"
	}
}

export class CLIUsageError extends CLIError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "CLIUsageError"
	}
}

/**
 * Whether an unknown thrown value is a deliberate, user-facing CLI usage error.
 */
export function isCLIUsageError(input: unknown): input is CLIUsageError {
	return input instanceof CLIUsageError
}

const negativeNumberPattern = /^-\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu
const reservedOptionNames = new Set(["help", "version"])
const reservedOptionShortNames = new Set(["h", "v"])

function validateCommandSpec(spec: CommandSpec): void {
	for (const [name, option] of Object.entries(spec.options ?? {})) {
		if (reservedOptionNames.has(name)) {
			throw new TypeError(`Command ${spec.name} cannot declare root-owned option --${name}.`)
		}

		if (option.short && reservedOptionShortNames.has(option.short)) {
			throw new TypeError(`Command ${spec.name} cannot declare root-owned option -${option.short}.`)
		}
	}
}

function protectNegativeNumbers(args: readonly string[]): { args: string[]; restore(value: string): string } {
	const protectedValues = new Map<string, string>()

	const protectedArgs = args.map((value, index) => {
		if (!negativeNumberPattern.test(value)) return value

		const placeholder = `mw-negative-number-${index}`

		protectedValues.set(placeholder, value)

		return placeholder
	})

	return { args: protectedArgs, restore: (value) => protectedValues.get(value) ?? value }
}

function parseNumber(raw: string, name: string, spec: NumberOptionSpec): number {
	const value = Number(raw)

	if (!Number.isFinite(value)) {
		throw new CLIUsageError(`--${name} expects a finite number (received ${JSON.stringify(raw)}).`)
	}

	if (spec.validate && !spec.validate(value)) {
		throw new CLIUsageError(spec.validationMessage ?? `Invalid value for --${name}: ${raw}`)
	}

	return value
}

/**
 * Parse one already-selected command without loading any UI framework or unrelated command module.
 */
export function parseCommand(spec: CommandSpec, args: readonly string[]): ParsedCommand {
	validateCommandSpec(spec)
	const protectedNumbers = protectNegativeNumbers(args)

	const definitions: Record<
		string,
		{
			type: "boolean" | "string"
			short?: string
			multiple?: boolean
			default?: boolean | string | boolean[] | string[]
		}
	> = {
		help: { type: "boolean", short: "h", default: false },
	}

	for (const [name, option] of Object.entries(spec.options ?? {})) {
		definitions[name] = {
			type: option.type === "boolean" ? "boolean" : "string",
			...(option.short ? { short: option.short } : {}),
			...(option.multiple ? { multiple: true } : {}),
			...(option.default !== undefined && option.type !== "number" ? { default: option.default } : {}),
		}
	}

	let parsed: ReturnType<typeof parseArguments>

	try {
		parsed = parseArguments({
			args: protectedNumbers.args,
			allowNegative: true,
			allowPositionals: true,
			options: definitions,
			strict: true,
		})
	} catch (error) {
		throw new CLIUsageError(error instanceof Error ? error.message : "Could not parse command arguments.", {
			cause: error,
		})
	}

	const values = Object.fromEntries(
		Object.entries(parsed.values).map(([name, value]) => [
			name,
			Array.isArray(value)
				? value.map((item) => (typeof item === "string" ? protectedNumbers.restore(item) : item))
				: typeof value === "string"
					? protectedNumbers.restore(value)
					: value,
		])
	) as Record<string, OptionValue | undefined>

	for (const [name, option] of Object.entries(spec.options ?? {})) {
		const raw = values[name]

		if (values.help !== true && raw === undefined && option.required) {
			throw new CLIUsageError(`Missing required option: --${name}.`)
		}

		if (option.type === "number") {
			if (raw === undefined) {
				values[name] = option.default
			} else if (option.multiple) {
				values[name] = (Array.isArray(raw) ? raw : [raw]).map((value) => parseNumber(String(value), name, option))
			} else {
				values[name] = parseNumber(String(raw), name, option)
			}
		} else if (option.type === "string" && raw !== undefined) {
			const candidates = Array.isArray(raw) ? raw.map(String) : [String(raw)]

			for (const value of candidates) {
				if (option.choices && !option.choices.includes(value)) {
					throw new CLIUsageError(`--${name} must be one of: ${option.choices.join(", ")}.`)
				}

				if (option.validate && !option.validate(value)) {
					throw new CLIUsageError(option.validationMessage ?? `Invalid value for --${name}: ${value}`)
				}
			}
		}
	}

	const positionals = parsed.positionals.map(protectedNumbers.restore)
	const positionalSpecs = spec.positionals ?? []
	const required = positionalSpecs.filter((positional) => positional.required).length
	const acceptsMany = positionalSpecs.at(-1)?.multiple === true

	if (values.help !== true && positionals.length < required) {
		throw new CLIUsageError(`Missing required argument: ${positionalSpecs[positionals.length]?.name ?? "argument"}.`)
	}

	if (values.help !== true && !acceptsMany && positionals.length > positionalSpecs.length) {
		throw new CLIUsageError(`Unexpected argument: ${positionals[positionalSpecs.length]}.`)
	}

	if (values.help !== true) {
		for (const [index, value] of positionals.entries()) {
			const positional = positionalSpecs[Math.min(index, positionalSpecs.length - 1)]

			if (!positional) continue

			if (positional.choices && !positional.choices.includes(value)) {
				throw new CLIUsageError(`${positional.name} must be one of: ${positional.choices.join(", ")}.`)
			}

			if (positional.validate && !positional.validate(value)) {
				throw new CLIUsageError(positional.validationMessage ?? `Invalid value for ${positional.name}: ${value}`)
			}
		}
	}

	return { positionals, values }
}

function optionLabel(name: string, option: OptionSpec): string {
	const displayName = option.type === "boolean" && option.default === true ? `[no-]${name}` : name
	const long = `--${displayName}${option.type === "boolean" ? "" : ` <${option.hint ?? option.type}>`}`

	return option.short ? `-${option.short}, ${long}` : long
}

/**
 * Render detailed help. This is the only parser path that imports CLIUI.
 */
export async function renderCommandHelp(spec: CommandSpec): Promise<string> {
	const { cliui } = await import("@isaacs/cliui/min")
	const ui = cliui({ width: process.stdout.columns || 100 })

	const positionalUsage = (spec.positionals ?? [])
		.map((positional) => {
			const value = `${positional.name}${positional.multiple ? "..." : ""}`

			return positional.required ? `<${value}>` : `[${value}]`
		})
		.join(" ")

	ui.div(`Usage: mw ${spec.usage ?? `${spec.name}${positionalUsage ? ` ${positionalUsage}` : ""} [options]`}`)
	ui.div({ text: spec.description, padding: [1, 0, 1, 0] })

	if (spec.positionals?.length) {
		ui.div("Arguments:")

		for (const positional of spec.positionals) {
			ui.div({ text: positional.name, width: 28, padding: [0, 2, 0, 2] }, { text: positional.description })
		}
	}

	ui.div({ text: "Options:", padding: [1, 0, 0, 0] })
	ui.div({ text: "-h, --help", width: 34, padding: [0, 2, 0, 2] }, { text: "Show command help." })

	for (const [name, option] of Object.entries(spec.options ?? {})) {
		const suffix = option.default === undefined ? "" : ` (default: ${String(option.default)})`

		ui.div(
			{ text: optionLabel(name, option), width: 46, padding: [0, 2, 0, 2] },
			{ text: `${option.description}${suffix}` }
		)
	}

	return ui.toString()
}
