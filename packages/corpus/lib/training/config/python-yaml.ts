/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parses a training config the way PyYAML's `yaml.safe_load` does, so the TypeScript resolver reads every
 *   committed YAML file into the values the Python loader reads.
 *
 *   PyYAML implements YAML 1.1 with its own implicit resolvers, and the `yaml` package's 1.1 schema differs from
 *   them in three places that change a config. PyYAML reads `5e-4` and `1.0e3` as strings, because its float
 *   pattern requires a dot and a signed exponent. It reads `y` and `n` as strings where the 1.1 schema reads
 *   booleans. And it reads an integer and a float as different types, which the receipt and coverage validations
 *   test. This module replaces the scalar tags with PyYAML's patterns and constructors: an integer becomes a
 *   `bigint`, a float a `number`, and `NO`, `yes`, `on` and `off` booleans.
 */

import { parseDocument, type ScalarTag, type Tags } from "yaml"

/**
 * A value as PyYAML constructs it: a `bigint` is a Python `int` and a `number` is a Python `float`.
 *
 * A mapping is a `Map` because its keys keep their YAML type: a bare `NO:` key is `false`.
 */
export type PythonValue = null | boolean | bigint | number | string | PythonValue[] | PythonMapping

/**
 * A YAML mapping in document order, with each key as PyYAML constructs it.
 */
export type PythonMapping = Map<PythonValue, PythonValue>

// PyYAML 6.0.3 `yaml/resolver.py`, each pattern as registered there.
const PYYAML_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/

const PYYAML_FLOAT =
	/^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/

const PYYAML_INT =
	/^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/

const PYYAML_TIMESTAMP =
	/^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/

/**
 * Splits a leading sign from a scalar, as PyYAML's numeric constructors do.
 */
function splitSign(value: string): { sign: 1 | -1; digits: string } {
	const sign = value.startsWith("-") ? -1 : 1
	const digits = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value

	return { sign, digits }
}

/**
 * `construct_yaml_int`: binary, hexadecimal, a leading zero as octal, and base-60 parts.
 */
function constructInt(source: string): bigint {
	const { sign, digits } = splitSign(source.replaceAll("_", ""))
	const signed = (value: bigint) => (sign < 0 ? -value : value)

	if (digits === "0") return 0n

	if (digits.startsWith("0b")) return signed(BigInt(`0b${digits.slice(2)}`))

	if (digits.startsWith("0x")) return signed(BigInt(`0x${digits.slice(2)}`))

	if (digits.startsWith("0")) return signed(BigInt(`0o${digits.slice(1)}`))

	if (digits.includes(":")) {
		return signed(digits.split(":").reduce((total, part) => total * 60n + BigInt(part), 0n))
	}

	return signed(BigInt(digits))
}

/**
 * `construct_yaml_float`: `.inf`, `.nan`, base-60 parts, and otherwise Python's `float()`.
 */
function constructFloat(source: string): number {
	const { sign, digits } = splitSign(source.replaceAll("_", "").toLowerCase())

	if (digits === ".inf") return sign * Number.POSITIVE_INFINITY

	if (digits === ".nan") return Number.NaN

	if (digits.includes(":")) {
		return sign * digits.split(":").reduce((total, part) => total * 60 + Number(part), 0)
	}

	return sign * Number(digits)
}

const PYYAML_SCALAR_TAGS: readonly ScalarTag[] = [
	{
		tag: "tag:yaml.org,2002:bool",
		default: true,
		test: PYYAML_BOOL,
		identify: (value) => typeof value === "boolean",
		resolve: (source) => ["yes", "true", "on"].includes(source.toLowerCase()),
	},
	{
		tag: "tag:yaml.org,2002:float",
		default: true,
		test: PYYAML_FLOAT,
		identify: (value) => typeof value === "number",
		resolve: constructFloat,
	},
	{
		tag: "tag:yaml.org,2002:int",
		default: true,
		test: PYYAML_INT,
		identify: (value) => typeof value === "bigint",
		resolve: constructInt,
	},
	{
		// PyYAML constructs a `datetime.date` or `datetime.datetime`, which has no JSON form and no config field.
		tag: "tag:yaml.org,2002:timestamp",
		default: true,
		test: PYYAML_TIMESTAMP,
		resolve: (source, onError) => {
			onError(`the plain scalar ${source} reads as a YAML 1.1 timestamp. Quote it if it is a string.`)

			return source
		},
	},
	{
		// PyYAML resolves a bare `=` to the value tag and has no constructor for it.
		tag: "tag:yaml.org,2002:value",
		default: true,
		test: /^=$/,
		resolve: (source, onError) => {
			onError("could not determine a constructor for the tag 'tag:yaml.org,2002:value'")

			return source
		},
	},
]

/**
 * The tags the `yaml` package keeps under PyYAML's resolution: collections, strings, nulls and merge keys.
 */
const KEPT_TAGS = new Set([
	"tag:yaml.org,2002:map",
	"tag:yaml.org,2002:seq",
	"tag:yaml.org,2002:str",
	"tag:yaml.org,2002:null",
	"tag:yaml.org,2002:merge",
])

function pythonYAMLTags(defaults: Tags): Tags {
	const kept = defaults.filter((tag) => typeof tag !== "string" && KEPT_TAGS.has(tag.tag))

	return [...kept, ...PYYAML_SCALAR_TAGS]
}

/**
 * Parses one YAML document into the value `yaml.safe_load` returns for it.
 *
 * A repeated key keeps its first position and its last value, as a Python dict assignment does.
 *
 * @throws When the document does not parse, or holds a timestamp or a bare `=`.
 */
export function parsePythonYAML(text: string, source = "<string>"): PythonValue {
	const document = parseDocument(text, {
		version: "1.1",
		customTags: pythonYAMLTags,
		merge: true,
		uniqueKeys: false,
	})

	if (document.errors.length) {
		throw new Error(`${source} does not parse as YAML: ${document.errors.map((error) => error.message).join("; ")}`)
	}

	return (document.toJS({ mapAsMap: true }) ?? null) as PythonValue
}

/**
 * The least decimal exponent CPython's `float_repr_style = 'short'` writes in fixed notation.
 */
const REPR_FIXED_MIN_EXPONENT = -4

/**
 * The decimal exponent from which CPython's `repr` of a float switches back to scientific notation.
 */
const REPR_FIXED_MAX_EXPONENT = 16

/**
 * Python's `repr` of a float: the shortest round-trip digits, with an exponent outside `1e-4 <= |x| < 1e16`.
 */
function floatRepr(value: number): string {
	if (Number.isNaN(value)) return "nan"

	if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf"

	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0"

	const [mantissa = "", exponentText = "0"] = value.toExponential().split("e")
	const exponent = Number(exponentText)

	if (exponent < REPR_FIXED_MIN_EXPONENT || exponent >= REPR_FIXED_MAX_EXPONENT) {
		const sign = exponent < 0 ? "-" : "+"

		return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`
	}

	const fixed = String(value)

	return fixed.includes(".") ? fixed : `${fixed}.0`
}

/**
 * Python's `repr` of a string: single quotes unless the string holds a single quote and no double quote.
 */
function stringRepr(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
	let out = quote

	for (const char of value) {
		const code = char.codePointAt(0)!

		if (char === "\\" || char === quote) {
			out += `\\${char}`
		} else if (char === "\n") {
			out += "\\n"
		} else if (char === "\r") {
			out += "\\r"
		} else if (char === "\t") {
			out += "\\t"
		} else if (code < 0x20 || code === 0x7f) {
			out += `\\x${code.toString(16).padStart(2, "0")}`
		} else {
			out += char
		}
	}

	return out + quote
}

/**
 * Python's `repr` of a value PyYAML constructs, as the Python loader's messages quote it.
 */
export function pythonRepr(value: PythonValue | undefined): string {
	if (value === null || value === undefined) return "None"

	if (typeof value === "boolean") return value ? "True" : "False"

	if (typeof value === "bigint") return value.toString()

	if (typeof value === "number") return floatRepr(value)

	if (typeof value === "string") return stringRepr(value)

	if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`

	return `{${[...value].map(([key, entry]) => `${pythonRepr(key)}: ${pythonRepr(entry)}`).join(", ")}}`
}

/**
 * Python's `type(value).__name__`.
 */
export function pythonTypeName(value: PythonValue): string {
	if (value === null) return "NoneType"

	if (typeof value === "boolean") return "bool"

	if (typeof value === "bigint") return "int"

	if (typeof value === "number") return "float"

	if (typeof value === "string") return "str"

	return Array.isArray(value) ? "list" : "dict"
}
