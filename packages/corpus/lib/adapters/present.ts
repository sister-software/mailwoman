/**
 * Normalize a source value and return null when the value is absent.
 */
export function present(
	value: string | number | null | undefined,
	options: { collapseWhitespace?: boolean; absentValues?: readonly string[] } = {}
): string | null {
	if (value == null) return null

	const text = String(value)
	const normalized = (options.collapseWhitespace ? text.replaceAll(/\s+/gu, " ") : text).trim()

	if (!normalized || options.absentValues?.includes(normalized)) return null

	return normalized
}

/**
 * Normalize a source value after collapsing each whitespace run to one space.
 */
export function presentCollapsed(value: string | number | null | undefined): string | null {
	return present(value, { collapseWhitespace: true })
}
