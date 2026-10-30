/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The key walk `config-keys.run.ts` runs over each committed training config.
 */

import type { PythonValue } from "@mailwoman/corpus/training/config/python-yaml"
import type { ConfigSectionSpec } from "@mailwoman/corpus/training/config/schema"

/**
 * Every dotted key under `node` that `section` does not declare, appended to `junk` in document order.
 *
 * A key whose field is a nested section is walked into.
 * A key whose field is a scalar is not, so an unknown key is reported once, at its own level.
 */
export function unknownConfigKeys(
	node: PythonValue,
	section: ConfigSectionSpec,
	prefix = "",
	junk: string[] = []
): string[] {
	if (!(node instanceof Map)) return junk

	for (const [key, value] of node) {
		const dotted = prefix ? `${prefix}.${String(key)}` : String(key)
		const field = section.fields[String(key)]

		if (!field) {
			junk.push(dotted)

			continue
		}

		if (field.section) {
			unknownConfigKeys(value, field.section, dotted, junk)
		}
	}

	return junk
}
