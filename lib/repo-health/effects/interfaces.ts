// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The interfaces through which repository code reaches the filesystem, databases,
 *   the network, child processes and the environment, and where each one takes its path.
 *
 *   The root `AGENTS.md` routes every such effect through these modules.
 *   A syntax pass can therefore find the effects without running the code.
 */

/**
 * What an effect does outside the process.
 */
export const EffectKind = {
	Read: "read",
	Write: "write",
	Network: "network",
	Process: "process",
	/**
	 * A read of one environment variable, through a package's `$public`
	 * or `$private` object or `process.env`.
	 *
	 * The target `*` stands for every variable, when code receives the whole of `process.env`.
	 */
	Environment: "environment",
} as const

export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind]

/**
 * Where one call takes a path, and what it does with it.
 */
interface PathParameter {
	kind: EffectKind
	/**
	 * The argument index the path starts at.
	 */
	index: number
	/**
	 * Every argument from `index` on is a path segment of one path, joined as `resolvePath` joins them.
	 */
	segments?: boolean
	/**
	 * Every argument from `index` on is a separate path, as `makeDirectories` takes them.
	 */
	each?: boolean
	/**
	 * An option that changes the kind: when the object literal at argument `argument`
	 * sets `property` to `true`, the edge has kind `kind`.
	 *
	 * `openBuiltClient(path, { write: true })` opens for writing, and
	 * `new DatabaseClient(path, { readOnly: true })` opens for reading.
	 */
	option?: { argument: number; property: string; kind: EffectKind }
	/**
	 * The path is this property of the object literal at `index`,
	 * as `Globerator.from(pattern, { cwd })` takes its directory.
	 * An absent property leaves the edge unresolved.
	 */
	property?: string
	/**
	 * The call reads the path's own metadata: whether it exists, its size, its link target or its real path.
	 * The answer depends on that path and on no file beneath it.
	 */
	exact?: boolean
}

/**
 * One exported function and the paths it touches.
 */
export interface EffectInterface {
	name: string
	parameters: readonly PathParameter[]
}

const readsFrom = (index: number, segments = false): PathParameter[] => [{ kind: EffectKind.Read, index, segments }]
const writesFrom = (index: number, segments = false): PathParameter[] => [{ kind: EffectKind.Write, index, segments }]
const inspects = (index: number): PathParameter[] => [{ kind: EffectKind.Read, index, exact: true }]

const FS_READERS: readonly EffectInterface[] = [
	{ name: "readFileHead", parameters: readsFrom(0) },
	{ name: "readFileRange", parameters: readsFrom(0) },
	{ name: "readLocalTextFileSync", parameters: readsFrom(0, true) },
	{ name: "readLocalTextFile", parameters: readsFrom(0, true) },
	{ name: "readLocalJSONFile", parameters: readsFrom(0, true) },
	{ name: "tryReadLocalJSONFile", parameters: readsFrom(0, true) },
	{ name: "readLocalBuffer", parameters: readsFrom(0, true) },
	{ name: "directoryHasEntries", parameters: readsFrom(0) },
	{ name: "sortedGlob", parameters: readsFrom(0) },
	{ name: "open", parameters: readsFrom(0) },
]

/**
 * A stat answers whether a path exists and what it is.
 *
 * A test that calls one depends on that path, and on no file beneath a directory it stats.
 */
const FS_STATS: readonly EffectInterface[] = [
	"tryStat",
	"statPath",
	"statLink",
	"tryStatLink",
	"pathExists",
	"assertPathExists",
	"isDirectory",
	"assertIsDirectory",
	"assertIsFile",
	"isFile",
	"isFileSync",
	"isSymbolicLink",
	"isWritable",
	"isExecutable",
	"readFileSize",
	"realPath",
	"tryRealPath",
	"readLink",
].map((name) => ({ name, parameters: inspects(0) }))

const FS_WRITERS: readonly EffectInterface[] = [
	{ name: "makeDirectories", parameters: [{ kind: EffectKind.Write, index: 0, each: true }] },
	{ name: "makeDirectoryExclusive", parameters: writesFrom(0) },
	{ name: "writeLocalTextFile", parameters: writesFrom(1, true) },
	{ name: "writeLocalJSONFile", parameters: writesFrom(1, true) },
	{ name: "writeLocalJSONLFile", parameters: writesFrom(1, true) },
	{ name: "writeLocalBuffer", parameters: writesFrom(1, true) },
	{ name: "writePrivateTextFile", parameters: writesFrom(1, true) },
	{ name: "writeLocalFile", parameters: writesFrom(1, true) },
	{ name: "appendLocalTextFile", parameters: writesFrom(1, true) },
	{ name: "removePath", parameters: writesFrom(0) },
	{ name: "removeEmptyDirectory", parameters: writesFrom(0) },
	{ name: "removeDirectory", parameters: writesFrom(0) },
	{ name: "removeFile", parameters: writesFrom(0) },
	{ name: "removePathIfPresent", parameters: writesFrom(0) },
	{ name: "truncateFile", parameters: writesFrom(0) },
	{ name: "copyPath", parameters: [...readsFrom(0), ...writesFrom(1)] },
	{ name: "copyFileTo", parameters: [...readsFrom(0), ...writesFrom(1)] },
	{ name: "writeLocalJSONFileAtomically", parameters: writesFrom(1) },
	{ name: "replaceFileAtomically", parameters: [...writesFrom(0), ...writesFrom(1)] },
	{ name: "movePath", parameters: [...writesFrom(0), ...writesFrom(1)] },
	{ name: "createSymbolicLink", parameters: writesFrom(1) },
	{ name: "changeMode", parameters: writesFrom(0) },
	{ name: "setTimestamps", parameters: writesFrom(0) },
]

const FS_STREAMS: readonly EffectInterface[] = [
	{ name: "openReadStream", parameters: readsFrom(0) },
	{ name: "openWriteStream", parameters: writesFrom(0) },
]

/**
 * `openBuiltClient` opens a built database for reading, or for writing when its options set `write`.
 */
const SQLITE_OPENERS: readonly EffectInterface[] = [
	{
		name: "openBuiltClient",
		parameters: [
			{ kind: EffectKind.Read, index: 0, option: { argument: 1, property: "write", kind: EffectKind.Write } },
		],
	},
]

const SQLITE_SEALS: readonly EffectInterface[] = [
	{ name: "isSealed", parameters: readsFrom(0) },
	{ name: "assertUnsealedForWrite", parameters: readsFrom(0) },
	{ name: "sealDatabase", parameters: writesFrom(0) },
	{ name: "swapDatabaseIntoPlace", parameters: [...writesFrom(0), ...writesFrom(1)] },
]

const PROCESSES: readonly EffectInterface[] = ["spawnProcess", "runFile", "runFileSync"].map((name) => ({
	name,
	parameters: [{ kind: EffectKind.Process, index: 0 }],
}))

/**
 * The git queries in `@mailwoman/core/git`, by the checkout path each one takes.
 *
 * A query of commit identity, a ref's tree or the history reads the repository's git metadata.
 * No tracked file holds that metadata, so the query reads the checkout path's own metadata only.
 *
 * A listing or status of the working tree reads every file under the path.
 *
 * `git` and `gitSync` run whichever git command the caller passes, in the checkout
 * or in a scratch repository such as one a test builds.
 * They stay undeclared, as a direct `runFile("git", …)` records a process edge
 * and no read of its working directory.
 */
const GIT_QUERIES: readonly EffectInterface[] = [
	{ name: "gitHead", parameters: inspects(0) },
	{ name: "currentBranch", parameters: inspects(0) },
	{ name: "gitCommonDirectory", parameters: inspects(0) },
	{ name: "workingTreeRoot", parameters: inspects(0) },
	{ name: "changedFiles", parameters: inspects(0) },
	{ name: "renamesSince", parameters: inspects(1) },
	{ name: "filesAtRef", parameters: inspects(1) },
	{ name: "movedAwayPaths", parameters: inspects(0) },
	{ name: "trackedFiles", parameters: readsFrom(0) },
	{ name: "streamTrackedFiles", parameters: readsFrom(0) },
	{ name: "dirtyTrackedFiles", parameters: readsFrom(0) },
	{ name: "workingTreeStatus", parameters: readsFrom(0) },
	{ name: "workingTreeFiles", parameters: readsFrom(1) },
]

/**
 * `buildSHA` stamps a layer manifest with the checkout's short commit, a query of commit identity.
 */
const BUILD_STAMPS: readonly EffectInterface[] = [{ name: "buildSHA", parameters: inspects(0) }]

/**
 * Each effect module by every specifier that reaches it: the public subpath, and inside core its `#` alias.
 */
export const EFFECT_MODULES: ReadonlyMap<string, readonly EffectInterface[]> = new Map([
	["@mailwoman/core/fs/readers", [...FS_READERS, ...FS_STATS]],
	["#fs/readers", [...FS_READERS, ...FS_STATS]],
	["@mailwoman/core/fs/readers/stat", FS_STATS],
	["#fs/readers/stat", FS_STATS],
	["@mailwoman/core/fs/writers", FS_WRITERS],
	["#fs/writers", FS_WRITERS],
	["@mailwoman/core/fs/streams", FS_STREAMS],
	["#fs/streams", FS_STREAMS],
	["@mailwoman/core/process", PROCESSES],
	["#process", PROCESSES],
	["@mailwoman/core/git", GIT_QUERIES],
	["#git", GIT_QUERIES],
	["@mailwoman/gazetteer/tools/pipeline/stamp-manifest", BUILD_STAMPS],
	["#tools/pipeline/stamp-manifest", BUILD_STAMPS],
	["@mailwoman/sqlite", [...SQLITE_OPENERS, ...SQLITE_SEALS]],
	["@mailwoman/sqlite/sealed", SQLITE_OPENERS],
	["#sealed", SQLITE_OPENERS],
	["@mailwoman/sqlite/sealed/db", SQLITE_SEALS],
	["#sealed/db", SQLITE_SEALS],
])

/**
 * A database connection opened by construction.
 *
 * The connection reads and writes its file unless the constructor's options set `readOnly`.
 *
 * `DatabaseSync` is listed for the few modules that open `node:sqlite` directly.
 */
const DATABASE_CONSTRUCTORS: readonly EffectInterface[] = ["DatabaseClient", "DatabaseSync"].map((name) => ({
	name,
	parameters: [
		{ kind: EffectKind.Write, index: 0, option: { argument: 1, property: "readOnly", kind: EffectKind.Read } },
	],
}))

/**
 * A class whose static methods reach the filesystem, with those methods.
 */
export interface StaticEffectClass {
	name: string
	methods: readonly EffectInterface[]
}

/**
 * A spliterator reader's `fromAsync` reads the file its first argument resolves to.
 *
 * Its argument may also be a stream or an iterable.
 * Such an argument leaves the edge unresolved.
 */
const SPLITERATOR_READERS: readonly StaticEffectClass[] = [
	"JSONSpliterator",
	"CSVSpliterator",
	"TSVSpliterator",
	"TextSpliterator",
].map((name) => ({ name, methods: [{ name: "fromAsync", parameters: readsFrom(0) }] }))

/**
 * `Globerator.from` and `Globerator.files` list the directory their options' `cwd` resolves to.
 */
const GLOBERATOR: StaticEffectClass = {
	name: "Globerator",
	methods: ["from", "files"].map((name) => ({
		name,
		parameters: [{ kind: EffectKind.Read, index: 1, property: "cwd" }],
	})),
}

/**
 * Each module that exports a class with filesystem static methods, by the specifier that reaches it.
 */
export const STATIC_EFFECT_MODULES: ReadonlyMap<string, readonly StaticEffectClass[]> = new Map([
	["spliterator", SPLITERATOR_READERS],
	["spliterator/node/fs", [GLOBERATOR]],
])

/**
 * Each module that exports a class whose construction opens a file, by every specifier that reaches it.
 */
export const CONSTRUCTOR_MODULES: ReadonlyMap<string, readonly EffectInterface[]> = new Map([
	["@mailwoman/sqlite", DATABASE_CONSTRUCTORS],
	["@mailwoman/sqlite/client", DATABASE_CONSTRUCTORS],
	["#client", DATABASE_CONSTRUCTORS],
	["node:sqlite", DATABASE_CONSTRUCTORS],
])

/**
 * Each specifier that reaches `APIClient`.
 *
 * A `fetch` call on an `APIClient`, or on a subclass a module declares,
 * is a network edge whose target is the request's `url`.
 */
export const API_CLIENT_MODULES: ReadonlySet<string> = new Set([
	"@mailwoman/core/api",
	"@mailwoman/core/api/APIClient",
	"#api",
	"#api/APIClient",
])

/**
 * The exported identifiers of a package's `env` module that hold its live environment objects.
 *
 * A property read on either object is a read of the environment variable of that name.
 */
export const ENVIRONMENT_OBJECTS: ReadonlySet<string> = new Set(["$public", "$private"])

/**
 * Whether `specifier` reaches a package's `env` module: `#env` inside the package,
 * or `@mailwoman/<name>/env`.
 */
export function isEnvironmentModule(specifier: string): boolean {
	return specifier === "#env" || /^@mailwoman\/[a-z0-9-]+\/env$/.test(specifier)
}

/**
 * Where a path builder roots the segments it joins.
 *
 * `scratch` covers the temporary and cache roots.
 * A file under either root belongs to the run that wrote it.
 */
export const PathRoot = {
	Repository: "repo",
	DataRoot: "data-root",
	ConfigRoot: "config-root",
	Package: "package",
	Scratch: "scratch",
	Literal: "literal",
	/**
	 * An environment variable, by name.
	 */
	Environment: "environment",
	/**
	 * The first argument of a function under evaluation.
	 *
	 * A package's `…DatabaseRoot(dataRoot)` function resolves to a path under this root.
	 * A call of that function replaces this root with the root its argument resolves to.
	 */
	Argument: "argument",
} as const

export type PathRoot = (typeof PathRoot)[keyof typeof PathRoot]

/**
 * A function whose literal arguments resolve to a rooted path.
 *
 * `packageFirst` marks `resolvePackagePath`.
 * Its first argument is a package name rather than a segment.
 *
 * `rebases` marks `databaseRootPath(root)`.
 * It joins the listed segments onto the root its first argument resolves to, rather than onto `root`.
 */
export interface PathRootBuilder {
	name: string
	root: PathRoot
	packageFirst?: boolean
	rebases?: readonly string[]
	/**
	 * Segments the builder joins before its arguments, as `workspacePath` roots its arguments at `packages/`.
	 */
	prefix?: readonly string[]
}

const DATA_ROOT_BUILDERS: readonly PathRootBuilder[] = [
	{ name: "dataRootPath", root: PathRoot.DataRoot },
	{ name: "configRootPath", root: PathRoot.ConfigRoot },
	{ name: "tempRootPath", root: PathRoot.Scratch },
	{ name: "cacheRootPath", root: PathRoot.Scratch },
	{ name: "databaseRootPath", root: PathRoot.DataRoot, rebases: ["db"] },
]

/**
 * The builders `@mailwoman/core/paths` exports.
 *
 * `workspacePath` and `workspacePathBuilder` join their arguments under the
 * repository's `packages/` directory.
 */
const REPOSITORY_BUILDERS: readonly PathRootBuilder[] = [
	{ name: "repoRootPath", root: PathRoot.Repository },
	{ name: "workspacePath", root: PathRoot.Repository, prefix: ["packages"] },
	{ name: "workspacePathBuilder", root: PathRoot.Repository, prefix: ["packages"] },
]

/**
 * The builders `@mailwoman/core/module/resolvers` exports.
 *
 * Each takes a package name first.
 * `resolvePackageDirectory(name)` answers a builder that a second call extends.
 */
const PACKAGE_BUILDERS: readonly PathRootBuilder[] = [
	{ name: "resolvePackagePath", root: PathRoot.Package, packageFirst: true },
	{ name: "resolvePackageDirectory", root: PathRoot.Package, packageFirst: true },
]

/**
 * Each module that exports a root path builder, by every specifier that reaches it,
 * with the builders it exports.
 *
 * The list follows the resolvers the root `AGENTS.md` and `packages/core/AGENTS.md`
 * route repository paths through.
 */
export const PATH_BUILDER_MODULES: ReadonlyMap<string, readonly PathRootBuilder[]> = new Map([
	["@mailwoman/core/paths", REPOSITORY_BUILDERS],
	["#paths", REPOSITORY_BUILDERS],
	["@mailwoman/core/data-root", DATA_ROOT_BUILDERS],
	["#data-root", DATA_ROOT_BUILDERS],
	["@mailwoman/core/module/resolvers", PACKAGE_BUILDERS],
	["#module/resolvers", PACKAGE_BUILDERS],
])
