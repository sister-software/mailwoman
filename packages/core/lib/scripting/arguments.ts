/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-free process argument accessors, kept separate from script cleanup and logging so latency-sensitive CLI
 * dispatchers can read argv without loading the ResourceError, ConsoleLogger, and async-init graphs.
 */

import { parseArgs, type ParseArgsConfig } from "node:util"

export type { ParseArgsConfig } from "node:util"

export type UnsafeCLIArgument = string & { __unsafeCLIArgumentBrand: never }

export type UnsafeCLIArguments = ReadonlyArray<UnsafeCLIArgument>

/**
 * The one blessed accessor for user CLI arguments.
 */
export function cliArguments(): UnsafeCLIArguments {
	// Element-wise because `string[] as ReadonlyArray<Branded>` is not a legal assertion while `string as Branded` is,
	// which is why this accessor exists rather than minting the brand at each call site.
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv accessor
	return process.argv.slice(2).map((value) => value as UnsafeCLIArgument)
}

/**
 * Forward the CLI arguments to a child process; do not use it unless its arguments
 * are being passed to a child process.
 */
export function passThroughCLIArguments(): readonly unknown[] {
	// oxlint-disable-next-line sister-software/no-process-globals -- Forwarding arguments to a child process.
	return process.argv.slice(2)
}

/**
 * The path of the executing script (`argv[1]`).
 */
export function scriptEntryPath(): string {
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv entry-path accessor
	return process.argv[1]!
}

/**
 * Split a string on a delimiter and return the non-empty trimmed entries.
 */
export function extractDelimited(value?: unknown, delimiter = ","): string[] {
	const normalized = typeof value === "string" ? value.trim() : null

	if (!normalized) return []

	return normalized
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/**
 * A flag's value, or a thrown error naming the flag and the command that needs it,
 * because `parseArgs` has no required-option concept and an absent `--name` would
 * otherwise fail far from the flag that caused it.
 */
export function requiredArgument(scope: string, name: string, value: string | undefined): string {
	if (value === undefined) {
		throw new Error(`${scope}: --${name} is required`)
	}

	return value
}

/**
 * Kebab segments whose property spelling capitalizes the whole acronym, because a
 * segment missing here derives a property the command's own `Options` does not declare:
 * the flag still parses but reaches the component under a name no code reads,
 * so add the segment here when a flag carries an acronym.
 */
export const OPTION_INITIALISMS = {
	csv: "CSV",
	db: "DB",
	html: "HTML",
	ids: "IDs",
	json: "JSON",
	jsonl: "JSONL",
	km: "KM",
	svg: "SVG",
	xml: "XML",
} as const

/**
 * Shared by {@linkcode optionPropertyName} and {@linkcode OptionPropertyName}
 * so the value and the type can never capitalize a segment differently.
 */
type InitialismOf<Segment extends string> = Segment extends keyof typeof OPTION_INITIALISMS
	? (typeof OPTION_INITIALISMS)[Segment]
	: Capitalize<Segment>

type TailPropertyName<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${InitialismOf<Head>}${TailPropertyName<Tail>}`
	: InitialismOf<Value>

/**
 * {@linkcode optionPropertyName} at the type level so a command's option properties derive
 * from its flags rather than being restated beside them; the two are read from the one
 * {@linkcode OPTION_INITIALISMS} declaration and must agree for a flag to bind.
 */
export type OptionPropertyName<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${Head}${TailPropertyName<Tail>}`
	: Value

/**
 * Convert a kebab-case option name to its TypeScript property name; `@mailwoman/repo-health`'s
 * `cli-flag-properties` check calls this, so a flag with an undeclared property fails
 * a check rather than silently having no effect at runtime.
 */
export function optionPropertyName(value: string): string {
	const [head = "", ...tail] = value.split("-")

	return (
		head +
		tail
			.map((part) =>
				Object.hasOwn(OPTION_INITIALISMS, part)
					? OPTION_INITIALISMS[part as keyof typeof OPTION_INITIALISMS]
					: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
			)
			.join("")
	)
}

/**
 * Parse CLI arguments against a `node:util` `parseArgs` config, defaulting `args` to
 * {@linkcode cliArguments} so a script never reads `process.argv` itself; a caller that has already
 * taken a command name off the front passes the remainder as `config.args` and it is used as given.
 */
export function parseArguments<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
	// The builtin types its result from the whole config object, so supplying `args` moves the type even
	// though the parsed shape depends on `options`/`allowPositionals` alone, which `T` carries.
	return parseArgs({ args: [...cliArguments()], ...config }) as ReturnType<typeof parseArgs<T>>
}
