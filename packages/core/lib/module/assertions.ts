/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A module that has been resolved to a default export, the shape of an ES module that has a `default` property.
 */
export interface ResolvedDefaultESModule<DefaultExport> {
	default: DefaultExport
}

/**
 * Asserts that the given module has a default export.
 *
 * @param mod The module to check.
 * @throws {TypeError} If the module is not an object or does not have a default export.
 */
export function assertDefaultExport<T>(mod: unknown): asserts mod is ResolvedDefaultESModule<T> {
	if (!mod || typeof mod !== "object") {
		throw new TypeError("Module is not an object")
	}

	if (!Object.hasOwn(mod, "default")) {
		throw new TypeError("Module does not have a default export")
	}
}
