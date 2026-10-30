/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Modal SDK behind {@linkcode ModalBoundary}. Credentials come from `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` or
 *   the active profile in `~/.modal.toml`, as the SDK reads them.
 */

import { type App, type Image, ModalClient, NotFoundError, type Secret, type Volume } from "modal"

import type {
	ModalBoundary,
	SandboxState,
	TrainerImageBuild,
	TrainingSandboxSpec,
} from "#tools/training/launch/boundary"

/**
 * How long a trainer image build may run: the libtorch download, the CUDA wheels
 * and a release build of the trainer.
 */
const IMAGE_BUILD_TIMEOUT_MS = 60 * 60 * 1000

/**
 * How long the snapshot of a built trainer filesystem may take.
 */
const SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000

export interface ModalBoundaryOptions {
	appName: string
	volumeName: string
	mount: string
	/**
	 * A named secret passed to every training sandbox, absent for none.
	 */
	secretName?: string
	log: (line: string) => void
}

/**
 * The launcher's Modal calls over one client, app and volume.
 */
export class SDKModalBoundary implements ModalBoundary {
	readonly #client = new ModalClient()
	readonly #options: ModalBoundaryOptions
	#app: Promise<App> | null = null
	#volume: Promise<Volume> | null = null
	#secret: Promise<Secret> | null = null

	constructor(options: ModalBoundaryOptions) {
		this.#options = options
	}

	#appHandle(): Promise<App> {
		const app = this.#app ?? this.#client.apps.fromName(this.#options.appName, { createIfMissing: true })

		this.#app = app

		return app
	}

	#volumeHandle(): Promise<Volume> {
		const volume = this.#volume ?? this.#client.volumes.fromName(this.#options.volumeName)

		this.#volume = volume

		return volume
	}

	async ensureTrainerImage(build: TrainerImageBuild): Promise<string> {
		try {
			const published = await this.#client.images.fromName(build.name)

			this.#options.log(`Trainer image: ${build.name} (published, ${published.imageId})`)

			return published.imageId
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error
		}

		this.#options.log(`Trainer image: building ${build.name}`)

		const app = await this.#appHandle()

		const base: Image = await this.#client.images
			.fromRegistry(build.baseImage)
			.dockerfileCommands(build.baseCommands)
			.build(app)

		const sandbox = await this.#client.sandboxes.create(app, base, {
			cpu: 8,
			memoryMiB: 16_384,
			timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
			tags: { "mailwoman-image-build": build.name },
		})

		try {
			const process = await sandbox.exec(["bash", "-c", build.buildScript], { stdout: "pipe", stderr: "pipe" })

			await process.stdin.writeText(Buffer.from(build.bundle).toString("base64"))
			await process.stdin.close()

			const [stdout, stderr, code] = await Promise.all([
				process.stdout.readText(),
				process.stderr.readText(),
				process.wait(),
			])

			this.#options.log(stdout.trimEnd())

			if (code !== 0) throw new Error(`the trainer image build exited ${code}:\n${stderr.trimEnd()}`)

			const image = await sandbox.snapshotFilesystem({ timeoutMs: SNAPSHOT_TIMEOUT_MS, ttlMs: null })

			await image.publish(build.name)
			this.#options.log(`Trainer image: published ${build.name} (${image.imageId})`)

			return image.imageId
		} finally {
			await sandbox.terminate()
		}
	}

	async start(spec: TrainingSandboxSpec): Promise<SandboxState> {
		const app = await this.#appHandle()
		const image = await this.#client.images.fromId(spec.imageID)

		this.#secret ??= this.#options.secretName ? this.#client.secrets.fromName(this.#options.secretName) : null

		const sandbox = await this.#client.sandboxes.create(app, image, {
			command: spec.command,
			env: spec.env,
			...(spec.gpu ? { gpu: spec.gpu } : {}),
			cpu: spec.cpu,
			memoryMiB: spec.memoryMiB,
			timeoutMs: spec.timeoutMs,
			volumes: { [this.#options.mount]: await this.#volumeHandle() },
			...(this.#secret ? { secrets: [await this.#secret] } : {}),
			name: spec.name,
			tags: spec.tags,
		})

		// The sandbox runs on after this process exits.
		sandbox.detach()

		return { id: sandbox.sandboxId, tags: spec.tags, exitCode: null }
	}

	async list(tags: Record<string, string>, includeFinished = false): Promise<SandboxState[]> {
		const app = await this.#appHandle()
		const found: SandboxState[] = []

		for await (const sandbox of this.#client.sandboxes.list({ appId: app.appId, tags })) {
			const state = { id: sandbox.sandboxId, tags: await sandbox.getTags(), exitCode: await sandbox.poll() }

			if (includeFinished || state.exitCode === null) {
				found.push(state)
			}
		}

		return found
	}

	async get(id: string): Promise<SandboxState> {
		const sandbox = await this.#client.sandboxes.fromId(id)

		return { id, tags: await sandbox.getTags(), exitCode: await sandbox.poll() }
	}

	async logs(id: string, lines: number): Promise<string> {
		const sandbox = await this.#client.sandboxes.fromId(id)
		const messages: string[] = []

		for await (const entry of sandbox.logs.tail({ entries: lines })) {
			messages.push(entry.message)
		}

		return messages.join("")
	}

	async terminate(id: string): Promise<void> {
		await (await this.#client.sandboxes.fromId(id)).terminate()
	}
}
