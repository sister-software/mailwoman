import { stringifyJSON } from "#json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Python's one-line `json.dumps`, kept for the two hashes whose recorded values were computed over its bytes.
 *
 *   `rowIdentity` in `packages/mailwoman/tools/training/sampler.ts` hashes a sampled row as the encoder-parity records
 *   store it, so a sampler change verifies against the 15 records. The DeepSeek transliteration batch id in
 *   `packages/corpus/lib/recipes/deepseek/batches.ts` hashes the seed ids as the first requested batches did, so a
 *   resumed run skips the batches already requested. New output uses `orderedJSON` from `@mailwoman/core/json`.
 */

/**
 * Options for {@linkcode pythonJSONDumps}, named as `json.dumps` names them.
 */
export interface PythonJSONOptions {
	sortKeys?: boolean
	/**
	 * @default true
	 */
	ensureASCII?: boolean
}

function pythonString(value: string, ensureASCII: boolean): string {
	// JSON.stringify escapes the quote, the backslash and the C0 controls as Python's json does.
	// Python's `ensure_ascii` also escapes DEL and every code unit above it, one `\uXXXX` per UTF-16 unit.
	const out = stringifyJSON(value)

	if (!ensureASCII) return out

	let escaped = ""

	for (let i = 0; i < out.length; i++) {
		const code = out.charCodeAt(i)

		escaped += code >= 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : out[i]
	}

	return escaped
}

function pythonValue(value: unknown, options: Required<PythonJSONOptions>): string {
	if (value == null) return "null"

	if (typeof value === "boolean") return value ? "true" : "false"

	if (typeof value === "number") {
		// Python writes a float as `2.0` and an int as `2`, and neither hashed document holds a float.
		if (!Number.isInteger(value)) throw new TypeError(`pythonJSONDumps: ${value} is not an integer`)

		return Object.is(value, -0) ? "0" : String(value)
	}

	if (typeof value === "string") return pythonString(value, options.ensureASCII)

	if (Array.isArray(value)) return `[${value.map((item) => pythonValue(item, options)).join(", ")}]`

	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)

		if (options.sortKeys) {
			entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		}

		const items = entries.map(
			([key, item]) => `${pythonString(key, options.ensureASCII)}: ${pythonValue(item, options)}`
		)

		return `{${items.join(", ")}}`
	}

	throw new TypeError(`pythonJSONDumps: unsupported value of type ${typeof value}`)
}

/**
 * `json.dumps(value, sort_keys=…, ensure_ascii=…)` on one line, byte for byte.
 *
 * @throws When a number is not an integer.
 */
export function pythonJSONDumps(value: unknown, options: PythonJSONOptions = {}): string {
	return pythonValue(value, { sortKeys: options.sortKeys ?? false, ensureASCII: options.ensureASCII ?? true })
}
