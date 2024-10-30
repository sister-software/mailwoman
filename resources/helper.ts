/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { PathBuilder } from "path-ts"

export interface ResourceOptions {
	replace?: RegExp[]
	minlength?: number
	lowercase?: boolean
}

/**
 * Generate a list of filenames from a directory and a list of filenames.
 */
export function generateFilenames(directory: string | PathBuilder, filenamePatterns: string[]): string[] {
	const fileNames: string[] = []

	for (const filename of filenamePatterns) {
		if (filename.indexOf("*") < 0) {
			fileNames.push(filename)
			continue
		}

		if (!existsSync(directory)) {
			continue
		}

		// We use a UNIX syntax in our classifier, so we need to transform this in to a JS RegExp

		const regex = new RegExp(filename.replace("*", ".*"))
		const directories = readdirSync(directory)
		fileNames.push(...directories.filter((f) => regex.test(f)))
	}

	return fileNames
}

/**
 * Load a single resource file.
 */
function singleResourceLoader(
	filepath: string | PathBuilder,
	add: ResourceLineCallback,
	remove: ResourceLineCallback
): void {
	if (!existsSync(filepath)) return

	const dict = readFileSync(filepath, "utf8")

	for (const _row of dict.split("\n")) {
		const row = _row.trim()

		// Comment?
		if (row.startsWith("#")) continue

		if (row.startsWith("!")) {
			row.substring(1).split("|").forEach(remove)
		} else {
			row.split("|").forEach(add)
		}
	}
}

export type ResourceLineCallback = (value: string) => void

export interface MultiResourceLoaderSource {
	directory: string | PathBuilder
	filenames: string[]
}

export interface MultiResourceLoader {
	(source: MultiResourceLoaderSource | string, add: ResourceLineCallback, remove: ResourceLineCallback): void
}

/**
 * Load multiple resource files.
 */
function delegateMultiResourceLoader(
	{ directory, filenames }: MultiResourceLoaderSource,
	add: ResourceLineCallback,
	remove: ResourceLineCallback
): void {
	const directoryBuilder = PathBuilder.from(directory)

	for (const fileName of generateFilenames(directoryBuilder, filenames)) {
		const filePath = directoryBuilder(fileName)

		singleResourceLoader(filePath, add, remove)
	}
}

/**
 * Load a resource.
 */
export function createResourceLoader<Cell extends string = string>(dictPath: string | PathBuilder) {
	const dictPathBuilder = PathBuilder.from(dictPath)

	const loaderInstance: MultiResourceLoader = (source, add, remove) => {
		if (typeof source === "string") {
			const filename = dictPathBuilder(dictPath.toString(), source)
			return singleResourceLoader(filename, add, remove)
		}

		const directory = dictPathBuilder(dictPath.toString(), source.directory.toString())

		return delegateMultiResourceLoader({ directory, filenames: source.filenames }, add, remove)
	}

	return loaderInstance
}

export interface NormalizeCellOptions {
	replace?: {
		from: string | RegExp
		to: string
	}
	minlength?: number
	lowercase?: boolean
	normalizer?: (cell: string) => string
}

/**
 * Normalize a cell value.
 */
export function normalizeCell<T extends string>(cell: string, options?: NormalizeCellOptions): T {
	let value = cell.trim()

	if (options?.replace) {
		value = value.replace(options.replace.from, options.replace.to)
	}

	if (options && options.minlength) {
		if (value.length < options.minlength) {
			return "" as T
		}
	}

	if (options && options.lowercase) {
		value = value.toLowerCase()
	}

	if (options && options.normalizer && typeof options.normalizer === "function") {
		value = options.normalizer(value)
	}

	return value as T
}
