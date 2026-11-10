/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The interfaces through which repository code reaches the filesystem, databases, the network, child processes and
 *   the environment, and where each one takes its path. The root `AGENTS.md` routes every such effect through these modules. A syntax pass
 *   can therefore find the effects without running the code.
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
	{ name: "readFileSize", parameters: readsFrom(0) },
	{ name: "realPath", parameters: readsFrom(0) },
	{ name: "tryRealPath", parameters: readsFrom(0) },
	{ name: "readLink", parameters: readsFrom(0) },
	{ name: "open", parameters: readsFrom(0) },
]

/**
 * A stat answers whether a path exists and what it is, so a test that calls
 * one depends on that path as a read does.
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
].map((name) => ({ name, parameters: readsFrom(0) }))

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
}

const DATA_ROOT_BUILDERS: readonly PathRootBuilder[] = [
	{ name: "dataRootPath", root: PathRoot.DataRoot },
	{ name: "configRootPath", root: PathRoot.ConfigRoot },
	{ name: "tempRootPath", root: PathRoot.Scratch },
	{ name: "cacheRootPath", root: PathRoot.Scratch },
	{ name: "databaseRootPath", root: PathRoot.DataRoot, rebases: ["db"] },
]

/**
 * Each module that exports a root path builder, by every specifier that reaches it,
 * with the builders it exports.
 *
 * The list follows the resolvers the root `AGENTS.md` and `packages/core/AGENTS.md`
 * route repository paths through.
 */
export const PATH_BUILDER_MODULES: ReadonlyMap<string, readonly PathRootBuilder[]> = new Map([
	["@mailwoman/core/paths", [{ name: "repoRootPath", root: PathRoot.Repository }]],
	["#paths", [{ name: "repoRootPath", root: PathRoot.Repository }]],
	["@mailwoman/core/data-root", DATA_ROOT_BUILDERS],
	["#data-root", DATA_ROOT_BUILDERS],
	["@mailwoman/core/module/resolvers", [{ name: "resolvePackagePath", root: PathRoot.Package, packageFirst: true }]],
	["#module/resolvers", [{ name: "resolvePackagePath", root: PathRoot.Package, packageFirst: true }]],
])
