/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-neutral command metadata and the small `node:util.parseArgs` adapter behind Mailwoman's lazy CLI.
 * Parsing never imports the help renderer; `@isaacs/cliui` is reached only from {@link renderCommandHelp}.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { type OptionPropertyName, parseArguments } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import type * as React from "react"

type OptionValue = boolean | number | string | boolean[] | number[] | string[]

interface OptionSpecBase {
	description: string
	short?: string
	default?: OptionValue
	multiple?: boolean
	required?: boolean
	/**
	 * The flag this option used to be spelled as.
	 *
	 * It keeps working, with a notice on stderr, and never appears in help.
	 *
	 * A CLI flag is a interface with whatever scripts already call it, so a rename that removes
	 * the old spelling breaks them at the moment of the rename with no way to find out first.
	 * The notice is what turns that into a warning the caller can act on before the alias goes.
	 *
	 * Passing both spellings is a usage error rather than a precedence rule:
	 * the caller meant one of them and the command cannot tell which.
	 */
	deprecatedName?: string
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

/**
 * Collapse an intersection of mapped types into one object type, preserving each property's optionality.
 *
 * {@linkcode OptionsOf} builds its required and optional halves separately, because a single mapped type cannot vary `?` per key. Without this the editor shows the intersection and an error names one half of it.
 */
type OneObject<Shape> = { [Key in keyof Shape]: Shape[Key] }

/**
 * The value stored in a flag's property, before {@linkcode OptionSpec.multiple} is applied.
 *
 * A `choices` list narrows the property to that union rather than leaving it `string`,
 * which is what a hand-written `Options` already did.
 */
type OptionScalar<Option> = Option extends { type: "boolean" }
	? boolean
	: Option extends { type: "number" }
		? number
		: Option extends { choices: readonly (infer Choice extends string)[] }
			? Choice
			: string

type OptionValueOf<Option> = Option extends { multiple: true } ? Array<OptionScalar<Option>> : OptionScalar<Option>

/**
 * The flags the router always supplies a value for: one carrying a `default`, and one declared `required`.
 *
 * Every other flag is absent unless the user passes it.
 */
type AlwaysPresentFlag<Options> = {
	[Flag in keyof Options]: Options[Flag] extends { default: unknown }
		? Flag
		: Options[Flag] extends { required: true }
			? Flag
			: never
}[keyof Options]

/**
 * A command's options object, derived from its own `spec`.
 *
 * The router writes each flag's value to the property `optionPropertyName` derives from it, so a
 * property spelled any other way is never written to and the flag parses, validates, and does nothing.
 * A restated `interface Options` can disagree that way silently.
 *
 * A derived one cannot, because the disagreement becomes a compile error at the read site.
 *
 * A flag carrying a `default`, or marked `required`, is always supplied and its property is required.
 * Every other property is optional.
 *
 * `choices` narrows the property to that union; `multiple` widens it to an array.
 */
export type OptionsOf<Spec extends CommandSpec> = Spec["options"] extends infer Options
	? Options extends Readonly<Record<string, OptionSpec>>
		? OneObject<
				{
					[Flag in AlwaysPresentFlag<Options> & string as OptionPropertyName<Flag>]-?: OptionValueOf<Options[Flag]>
				} & {
					[
						Flag in Exclude<keyof Options, AlwaysPresentFlag<Options>> & string as OptionPropertyName<Flag>
					]?: OptionValueOf<Options[Flag]>
				}
			>
		: Record<string, never>
	: Record<string, never>

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

		// A retired spelling that is also a live option would delete the live one's value on every run.
		if (option.deprecatedName && option.deprecatedName in (spec.options ?? {})) {
			throw new TypeError(
				`Command ${spec.name} names --${option.deprecatedName} as the old spelling of --${name} while declaring it.`
			)
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
		throw new CLIUsageError(`--${name} expects a finite number (received ${stringifyJSON(raw)}).`)
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

		// The retired spelling parses, and carries no default.
		// A default here would make the alias look supplied on every run and shadow the current flag's own.
		if (option.deprecatedName) {
			definitions[option.deprecatedName] = {
				type: option.type === "boolean" ? "boolean" : "string",
				...(option.multiple ? { multiple: true } : {}),
			}
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
		if (option.deprecatedName) {
			const retired = values[option.deprecatedName]

			// The retired key never survives into the bag a command reads: leaving it
			// there gives one value two homes, and a command that reaches for the old one
			// keeps working past the removal it was warned about.
			values[option.deprecatedName] = undefined

			if (retired !== undefined) {
				// Both spellings is a usage error rather than a precedence rule: the caller
				// meant one of them and the command cannot tell which.
				if (values[name] !== undefined && values[name] !== option.default) {
					throw new CLIUsageError(`--${option.deprecatedName} is the old name for --${name}; pass one of them.`)
				}

				console.error(`--${option.deprecatedName} is deprecated and will be removed; use --${name}.`)

				values[name] = retired
			}
		}

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
 * Render detailed help.
 *
 * This is the only parser path that imports cliui.
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

/**
 * Validator for count-shaped number options.
 */
export const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0

/**
 * Option-descriptor shorthand: a plain string option.
 */
export const stringOption = (description: string) => ({ type: "string", description }) as const

/**
 * Option-descriptor shorthand: a plain number option.
 */
export const numberOption = (description: string) => ({ type: "number", description }) as const

/**
 * Option-descriptor shorthand: a boolean flag defaulting off.
 */
export const booleanOption = (description: string) => ({ type: "boolean", default: false, description }) as const

/**
 * Option-descriptor shorthand: a number option refusing zero, negatives, and fractions.
 */
export const positiveIntegerOption = (description: string, defaultValue?: number) =>
	({
		type: "number",
		...(defaultValue === undefined ? {} : { default: defaultValue }),
		validate: positiveInteger,
		validationMessage: `${description} must be a positive integer.`,
		description,
	}) as const

/**
 * Typed string read over {@link ParsedCommand.values} — `undefined` for anything but a string.
 */
export function stringValue(values: Record<string, unknown>, name: string): string | undefined {
	const value = values[name]

	return typeof value === "string" ? value : undefined
}

/**
 * Typed boolean read over {@link ParsedCommand.values} — strictly `=== true`.
 */
export function booleanValue(values: Record<string, unknown>, name: string): boolean {
	return values[name] === true
}

/**
 * A boolean flag with no schema default: unstated stays `undefined` so the library default applies
 * downstream, and only a stated `--flag` / `--no-flag` reaches the consumer as an explicit value.
 */
export function triStateValue(values: Record<string, unknown>, name: string): boolean | undefined {
	const value = values[name]

	return typeof value === "boolean" ? value : undefined
}

/**
 * Typed number read over {@link ParsedCommand.values} — `undefined` for anything but a number.
 */
export function numberValue(values: Record<string, unknown>, name: string): number | undefined {
	const value = values[name]

	return typeof value === "number" ? value : undefined
}

/**
 * The shared preamble of every native command: parse against `spec`, answer `--help`,
 * then hand the parsed command to `handler`.
 */
export async function runNativeCommand(
	spec: CommandSpec,
	args: readonly string[],
	handler: (parsed: ParsedCommand) => number | Promise<number>
): Promise<number> {
	const parsed = parseCommand(spec, args)

	if (parsed.values.help === true) {
		process.stdout.write(`${await renderCommandHelp(spec)}\n`)

		return 0
	}

	return handler(parsed)
}

/**
 * Render one Ink element and answer the process exit code — the tail shared by
 * the debug view and the filesystem command router.
 *
 * Ink loads lazily, so the ordinary data path never pays for it.
 */
export async function renderInkCommand(element: React.ReactElement): Promise<number> {
	const { render } = await import("ink")
	const instance = render(element)

	await instance.waitUntilExit()

	return typeof process.exitCode === "number" ? process.exitCode : 0
}
