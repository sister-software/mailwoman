/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write provisioned values into `wrangler.toml` without a TOML library: the file is ours, each environment's vars sit
 *   under a `[env.<name>.vars]` heading, and a var is one `KEY = "value"` line. The rewrite is a pure function over the
 *   text so a test can hold it to the file's actual shape.
 */

/**
 * The environment's `[env.<name>.vars]` block with the given keys set. A key already present is replaced in place; a
 * missing key is appended to the block. Throws when the environment has no vars block, since inventing one would guess
 * at the file's structure.
 */
export function withEnvironmentVars(toml: string, environment: string, vars: Readonly<Record<string, string>>): string {
	const heading = `[env.${environment}.vars]`
	const start = toml.indexOf(`${heading}\n`)

	if (start === -1) throw new Error(`wrangler.toml has no ${heading} block`)

	const bodyStart = start + heading.length + 1
	const nextHeading = toml.indexOf("\n[", bodyStart)
	const bodyEnd = nextHeading === -1 ? toml.length : nextHeading + 1
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one vars block of a hand-sized config file
	const lines = toml.slice(bodyStart, bodyEnd).split("\n")
	const pending = new Map(Object.entries(vars))

	const rewritten = lines.map((line) => {
		const match = /^([A-Z_][A-Z0-9_]*)\s*=/u.exec(line)
		const key = match?.[1]

		if (!key || !pending.has(key)) return line

		const value = pending.get(key)!

		pending.delete(key)

		return `${key} = ${JSON.stringify(value)}`
	})

	// Append what the block lacked, before the blank line that separates it from the next heading.
	const trailingBlank = rewritten.length && rewritten.at(-1) === "" ? rewritten.pop() : undefined

	const trailingSecondBlank = rewritten.length && rewritten.at(-1) === "" ? rewritten.pop() : undefined

	for (const [key, value] of pending) {
		rewritten.push(`${key} = ${JSON.stringify(value)}`)
	}

	if (trailingSecondBlank !== undefined) {
		rewritten.push(trailingSecondBlank)
	}

	if (trailingBlank !== undefined) {
		rewritten.push(trailingBlank)
	}

	return `${toml.slice(0, bodyStart)}${rewritten.join("\n")}${toml.slice(bodyEnd)}`
}

/**
 * The value of one var in one environment's block, or `undefined`.
 */
export function readEnvironmentVar(toml: string, environment: string, key: string): string | undefined {
	const heading = `[env.${environment}.vars]`
	const start = toml.indexOf(`${heading}\n`)

	if (start === -1) return undefined

	const bodyStart = start + heading.length + 1
	const nextHeading = toml.indexOf("\n[", bodyStart)
	const body = toml.slice(bodyStart, nextHeading === -1 ? toml.length : nextHeading)
	const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "mu").exec(body)

	return match?.[1]
}
