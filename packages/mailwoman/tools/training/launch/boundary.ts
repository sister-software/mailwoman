/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The calls the training launcher makes to Modal, behind one interface so the launch logic is tested without them.
 */

/**
 * What a training or build sandbox runs on.
 */
export interface SandboxResources {
	/**
	 * A Modal GPU type, absent for a CPU sandbox.
	 */
	gpu?: string
	cpu: number
	memoryMiB: number
	timeoutMs: number
}

/**
 * One training sandbox to start.
 */
export interface TrainingSandboxSpec extends SandboxResources {
	/**
	 * Unique among the app's running sandboxes, so Modal itself refuses a second sandbox under one name.
	 */
	name: string
	imageID: string
	command: string[]
	env: Record<string, string>
	tags: Record<string, string>
}

/**
 * A sandbox's state as Modal reports it.
 */
export interface SandboxState {
	id: string
	tags: Record<string, string>
	/**
	 * The exit code once the sandbox has finished, `null` while it runs.
	 */
	exitCode: number | null
}

/**
 * The inputs of a trainer image build: its registry base, its base layers,
 * the build script and the source tarball.
 */
export interface TrainerImageBuild {
	name: string
	baseImage: string
	baseCommands: string[]
	buildScript: string
	/**
	 * A gzip tarball of the trainer sources, written to the build script's stdin as base64.
	 */
	bundle: Uint8Array
}

/**
 * A sandbox the launcher waits on: a registry image, the training volume mounted,
 * and the named secret when `withSecret`.
 */
export interface OneShotSandboxSpec extends SandboxResources {
	registryImage: string
	command: string[]
	env: Record<string, string>
	withSecret: boolean
}

/**
 * Modal, as the launcher uses it.
 */
export interface ModalBoundary {
	/**
	 * The published image under `build.name`, building and publishing it first when there is none.
	 */
	ensureTrainerImage(build: TrainerImageBuild): Promise<string>
	start(spec: TrainingSandboxSpec): Promise<SandboxState>
	/**
	 * The app's sandboxes whose tags include every entry of `tags`, running ones only
	 * unless `includeFinished`.
	 */
	list(tags: Record<string, string>, includeFinished?: boolean): Promise<SandboxState[]>
	get(id: string): Promise<SandboxState>
	/**
	 * The sandbox's last `lines` lines of output.
	 */
	logs(id: string, lines: number): Promise<string>
	terminate(id: string): Promise<void>
	/**
	 * Runs a sandbox to its exit and returns its exit code and combined output.
	 */
	runToCompletion(spec: OneShotSandboxSpec): Promise<{ exitCode: number; output: string }>
}
