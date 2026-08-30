import { existsSync, mkdirSync, readFileSync, statSync } from "@mailwoman/platform/fs"

/**
 * A `.filter()` predicate and a `.map()` transform. Neither callback is awaited, so neither call can move. The
 * synchronous fallback is opt-in (`--param syncFallback=true`), and this fixture runs WITHOUT it: nothing changes.
 */
export function readPresent(paths: string[]): string[] {
	return paths.filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8"))
}

/**
 * A class constructor runs synchronously by construction.
 */
export class Cache {
	readonly size: number

	constructor(root: string) {
		mkdirSync(root, { recursive: true })
		this.size = statSync(root).size
	}
}
