/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lightweight argv helpers for the toolshed. A `--flag value` scan that ~30 scripts had each
 *   re-implemented byte-for-byte as a local `const arg = …`; this is the one home.
 *
 *   For NEW scripts with a real flag schema, prefer `node:util`'s `parseArgs` (already the idiom in
 *   ~79 scripts) — it validates, supports `--flag=value`, and wraps cleanly into a `mailwoman
 *   <group> <cmd>` CLI command. Reach for these helpers only for the quick scan-style probes where
 *   a full options schema is overkill.
 */

/**
 * Read `--name <value>` from `process.argv`. Returns the token after `--name` when present and
 * non-empty, else `fallback` (default `""`). Always a string — matching the dominant local copy it
 * replaces, `(k, d = ""): string`: `argv.indexOf("--name")`, then the next token if truthy.
 */
export function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	const value = i >= 0 ? process.argv[i + 1] : undefined
	return value ? value : fallback
}

/** Like {@link arg} but coerced to a number (`Number(...)`); `fallback` when the flag is absent. */
export function numArg(name: string, fallback: number): number {
	const raw = arg(name)
	return raw === "" ? fallback : Number(raw)
}

/** True when the bare `--name` flag is present anywhere in `process.argv`. */
export function flag(name: string): boolean {
	return process.argv.includes(`--${name}`)
}
