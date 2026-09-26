/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Scratch directories that remove themselves.
 *
 *   Rooted at `$MAILWOMAN_TEMP_ROOT` rather than the operating system's `tmpdir()`, which is why this lives in
 *   `@mailwoman/core`: the root comes from the typed public environment.
 */

import { mkdtempDisposable } from "node:fs/promises"

import { PathBuilder, type PathBuilderLike } from "path-ts"

import { tempRootPathBuilder } from "#data-root"
import { makeDirectories } from "#fs/writers"

/**
 * A temporary directory that removes itself when the owning scope ends,
 * together with everything registered on it.
 *
 * ```ts
 * await using scratch = await temporaryDirectory("filer-build-")
 * const out = scratch.path("filer.db")
 * ```
 *
 * {@linkcode move} answers this same shape rather than a bare `AsyncDisposableStack`, whose own `move()`
 * drops `path`; {@linkcode moveWith} does that transfer and attaches what the caller asked for.
 */
export interface TemporaryDirectory extends AsyncDisposable {
	/**
	 * The directory itself.
	 *
	 * Call it with segments for a path inside the directory.
	 */
	readonly path: PathBuilder
	/**
	 * Take ownership of a resource, released before the directory is removed,
	 * so a database opened on a file in here is closed while the file still exists.
	 */
	use<T extends AsyncDisposable | Disposable | null | undefined>(resource: T): T
	/**
	 * Hand the directory and everything registered on it to a scope that outlives this one;
	 * this binding disposes no resource afterwards.
	 */
	move(): TemporaryDirectory
	/**
	 * {@linkcode move}, carrying `extras` alongside — the shape a fixture builder returns.
	 */
	moveWith<T extends object>(extras: T): TemporaryDirectory & T
}

function asTemporaryDirectory(_path: PathBuilderLike, resources: AsyncDisposableStack): TemporaryDirectory {
	const pathBuilder = PathBuilder.from(_path)

	return {
		path: pathBuilder,
		use: (resource) => resources.use(resource),
		move: () => asTemporaryDirectory(pathBuilder, resources.move()),
		moveWith: (extras) => Object.assign(asTemporaryDirectory(pathBuilder, resources.move()), extras),
		[Symbol.asyncDispose]: () => resources.disposeAsync(),
	}
}

/**
 * Create a new temporary directory under `$MAILWOMAN_TEMP_ROOT`, removed when the owning scope ends.
 *
 * The root is created if it does not exist, because `mkdtemp` fails on a missing parent.
 */
export async function temporaryDirectory(prefix = "mailwoman-"): Promise<TemporaryDirectory> {
	const root = tempRootPathBuilder()

	await makeDirectories(root)

	const resources = new AsyncDisposableStack()
	// A string, because `mkdtemp` appends its random suffix to the prefix as text.
	const directory = resources.use(await mkdtempDisposable(root(prefix).toString()))

	return asTemporaryDirectory(directory.path, resources)
}
