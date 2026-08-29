import { NotImplementedError } from "./errors.ts"

/**
 * Creates the standard error used by unsupported platform entry points.
 */
export function createNotImplementedError(packageName: string): NotImplementedError {
	return new NotImplementedError(packageName)
}

/**
 * Creates a lazily-throwing stand-in for an unsupported platform export.
 */
export function createNotImplementedFunction(packageName: string): (...args: never[]) => never {
	return () => {
		throw createNotImplementedError(packageName)
	}
}
