// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The options one `mailwoman geocode` run acts on.
 *
 *   The session's options merge three sources in order: the option schema's defaults,
 *   the config file, and the flags the user typed.
 *   The output options come from the command's own flags.
 */

import type { ScopeStrength } from "@mailwoman/core/resolver"
import type { OutcomeOptions } from "@mailwoman/core/resolver/outcome"
import { optionPropertyName } from "@mailwoman/core/scripting/arguments"
import type { PathBuilderLike } from "path-ts"

import { booleanValue, numberValue, type ParsedCommand, stringValue } from "#cli/native/spec"
import {
	createGeocodeSessionOptions,
	type GeocodeSessionOptions,
	type GeocodeSessionOptionsInput,
	GeocodeSessionOptionsSchema,
	SessionOptionSource,
} from "#geocode/options"
import { loadGeocodeConfigFile } from "#geocode/options/config-file"

/**
 * How the command reads its input and prints its answer.
 *
 * A session reads none of these, so a config file's `geocode` key doesn't hold them.
 */
export interface GeocodeOutputOptions {
	format: "json" | "text" | "jsonld"
	json: boolean
	text: boolean
	jsonld: boolean
	debug: boolean
	debugSize: string
	stdin: boolean
	/**
	 * Worker threads a `--stdin` run geocodes on, each with its own sessions.
	 * 1 geocodes on the calling thread.
	 */
	workers: number
	timing: boolean
	tiles?: string
	/**
	 * The outcome fields every request of the run sends, from `--outcome-hint` and `--outcome-filter`.
	 */
	request: OutcomeOptions
}

export type GeocodeCommandOptions = GeocodeSessionOptions & GeocodeOutputOptions

/**
 * The session options the user typed as flags, keyed as the schema keys them.
 *
 * A flag's schema key is its property name, so `--country-scope` states `countryScope`.
 * A flag the user didn't type is absent, so a config file's value for its key stands.
 * A string flag typed empty states no value.
 */
function typedSessionOptions(parsed: ParsedCommand): Record<string, unknown> {
	const stated: Record<string, unknown> = {}

	for (const flag of parsed.typed) {
		const key = optionPropertyName(flag)
		const value = parsed.values[flag]

		if (key in GeocodeSessionOptionsSchema.shape && value !== "") {
			stated[key] = value
		}
	}

	return stated
}

/**
 * Resolves a parsed `mailwoman geocode` command to the options the run acts on.
 *
 * The config file is the one `--config` gives, else the `mailwoman.config.*` file in `directory`.
 * `--parent` and `--parent-scope` together state the `parentPlace` key: `--parent` replaces a
 * file's parent, and `--parent-scope` without `--parent` restates the strength of the file's.
 *
 * @throws {CommandError} When the config file is absent, can't be loaded or is refused by the schema.
 */
export async function resolveGeocodeCommandOptions(
	parsed: ParsedCommand,
	directory: PathBuilderLike = process.cwd()
): Promise<GeocodeCommandOptions> {
	const { values, typed } = parsed
	const file = await loadGeocodeConfigFile(directory, stringValue(values, "config"))

	const parent = numberValue(values, "parent")
	const strength = stringValue(values, "parent-scope") as ScopeStrength
	const fileParent = file?.options.parentPlace

	const parentPlace =
		parent != null
			? { id: parent, strength }
			: fileParent && typed.has("parent-scope")
				? { ...fileParent, strength }
				: fileParent

	const dataRoot = stringValue(values, "data-root")
	const tiles = stringValue(values, "tiles")

	const flagOptions = typedSessionOptions(parsed)

	// The locale's source is read off the two objects the merge below spreads, in the merge's own order.
	const localeSource =
		"locale" in flagOptions
			? SessionOptionSource.Flag
			: file?.options.locale == null
				? SessionOptionSource.Default
				: SessionOptionSource.ConfigFile

	// The flags were checked by the command's spec and the file by its schema, so this parse only fills defaults.
	const session = createGeocodeSessionOptions({
		...file?.options,
		...flagOptions,
		...(parentPlace ? { parentPlace } : {}),
		...(dataRoot ? { dataRoot } : {}),
		localeSource,
	} as GeocodeSessionOptionsInput)

	return {
		...session,
		format: stringValue(values, "format") as GeocodeOutputOptions["format"],
		json: booleanValue(values, "json"),
		text: booleanValue(values, "text"),
		jsonld: booleanValue(values, "jsonld"),
		debug: booleanValue(values, "debug"),
		debugSize: stringValue(values, "debug-size")!,
		stdin: booleanValue(values, "stdin"),
		workers: numberValue(values, "workers") ?? 1,
		timing: booleanValue(values, "timing"),
		...(tiles ? { tiles } : {}),
		request: outcomeRequest(stringValue(values, "outcome-hint"), stringValue(values, "outcome-filter")),
	}
}

/**
 * The outcome fields of a request, from the two flags as typed.
 *
 * The session checks each id against the vocabulary and refuses an unknown one,
 * so this only splits the list.
 */
function outcomeRequest(hint: string | null, filter: string | null): OutcomeOptions {
	const kinds = (filter ?? "")
		.split(",")
		.map((kind) => kind.trim())
		.filter((kind) => kind !== "")

	return {
		...(hint ? { outcomeHint: hint } : {}),
		...(kinds.length ? { outcomeFilter: kinds } : {}),
	}
}
