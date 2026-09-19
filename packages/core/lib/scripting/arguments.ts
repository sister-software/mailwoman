/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-free process argument accessors. Kept separate from script cleanup/logging so latency-sensitive CLI
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
	// Element-wise: `string[] as ReadonlyArray<Branded>` is not a legal assertion, while `string as Branded` is —
	// which is the whole reason this accessor exists rather than the brand being minted at each call site.
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv accessor
	return process.argv.slice(2).map((value) => value as UnsafeCLIArgument)
}

/**
 * Forward the CLI arguments to a child process.
 *
 * Do not use this function unless its arguments are being passed to a child process.
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
 * Given a string, splits it on the given delimiter and returns the non-empty trimmed entries.
 *
 * @returns An array of non-empty trimmed entries.
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
 * A flag's value, or a thrown error naming the flag and the command that needs it.
 *
 * `parseArgs` has no required-option concept: an absent `--name` is `undefined`, and a script that forwards that into a
 * path or a URL fails far from the flag that caused it.
 */
export function requiredArgument(scope: string, name: string, value: string | undefined): string {
	if (value === undefined) {
		throw new Error(`${scope}: --${name} is required`)
	}

	return value
}

/**
 * Kebab segments whose property spelling capitalizes the whole acronym, per the house casing convention.
 *
 * A segment missing here derives a property the command's own `Options` does not declare. The flag still parses and
 * still passes validation. it reaches the component under a name nothing reads, so it does nothing and reports no
 * error. Add the segment here when a flag carries an acronym.
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
 * One kebab segment's property spelling. Shared by {@linkcode optionPropertyName} and {@linkcode OptionPropertyName} so
 * the value and the type can never capitalize a segment differently.
 */
type InitialismOf<Segment extends string> = Segment extends keyof typeof OPTION_INITIALISMS
	? (typeof OPTION_INITIALISMS)[Segment]
	: Capitalize<Segment>

type TailPropertyName<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${InitialismOf<Head>}${TailPropertyName<Tail>}`
	: InitialismOf<Value>

/**
 * {@linkcode optionPropertyName} at the type level, so a command's option properties are derived from its flags rather
 * than restated beside them.
 *
 * The two must agree for a flag to bind, and matched tables would not hold that: the type and the value diverge at the
 * points a constant cannot express. They share {@linkcode OPTION_INITIALISMS} itself — one declaration, read by
 * `typeof` here and by `Object.hasOwn` there.
 */
export type OptionPropertyName<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${Head}${TailPropertyName<Tail>}`
	: Value

/**
 * Convert a kebab-case option name to its TypeScript property name.
 *
 * `@mailwoman/repo-health`'s `cli-flag-properties` check derives every command's property names with this function, so
 * a flag whose property nothing declares fails a check rather than doing nothing at runtime.
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
 * Parse CLI arguments against a `node:util` `parseArgs` config — the same `options`, `allowPositionals`, `strict` and
 * `tokens` fields. `args` defaults to {@linkcode cliArguments}, so a script never reads `process.argv` itself. a caller
 * that has already taken a command name off the front passes the remainder as `args` and it is used as given. The
 * result is typed from the config exactly as the builtin types it.
 */
export function parseArguments<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
	// The builtin types its result from the whole config object, so supplying `args` moves the type. the parsed shape
	// depends on `options`/`allowPositionals` alone, which `T` carries.
	return parseArgs({ args: [...cliArguments()], ...config }) as ReturnType<typeof parseArgs<T>>
}
