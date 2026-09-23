/**
 * LocalStorageProvider - local/demo mode only.
 *
 * Objects live under STORAGE_DIR using the same deterministic key layout as
 * Azure Blob Storage, so switching modes changes where bytes live and nothing
 * else. Every key is validated and the resolved path is proved to stay inside
 * the storage root before any filesystem call.
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import {
	StorageError,
	assertSafeObjectKey,
	contentTypeForExtension,
	type ObjectMetadata,
	type PutOptions,
	type PutResult,
	type StorageProvider,
} from "./base.ts"

/** Sidecar file holding the content type and operational metadata for a key. */
const META_SUFFIX = ".meta.json"

export class LocalStorageProvider implements StorageProvider {
	readonly name = "local-filesystem"
	readonly mode = "local" as const
	readonly root: string

	constructor(rootDir: string) {
		this.root = path.resolve(rootDir)
	}

	get container(): string {
		return this.root
	}

	describe(): string {
		return `local:${this.root}`
	}

	/** Resolves a key to an absolute path that is provably inside the root. */
	private pathFor(key: string): string {
		assertSafeObjectKey(key)
		const resolved = path.resolve(this.root, ...key.split("/"))
		const root = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
		if (!resolved.startsWith(root)) {
			throw new StorageError("Invalid storage object key.", 400, "bad_request")
		}
		return resolved
	}

	async put(key: string, body: Buffer | Readable, options: PutOptions = {}): Promise<PutResult> {
		const target = this.pathFor(key)
		try {
			await fsp.mkdir(path.dirname(target), { recursive: true })
			let size = 0
			if (Buffer.isBuffer(body)) {
				await fsp.writeFile(target, body)
				size = body.byteLength
			} else {
				await pipeline(body, fs.createWriteStream(target))
				size = (await fsp.stat(target)).size
			}
			const contentType = options.contentType || contentTypeForExtension(path.extname(target))
			await fsp.writeFile(
				`${target}${META_SUFFIX}`,
				JSON.stringify({ contentType, metadata: options.metadata ?? {}, contentDisposition: options.contentDisposition ?? null }),
			)
			return { key, size, contentType }
		} catch (error) {
			if (error instanceof StorageError) throw error
			throw new StorageError(`Local storage write failed: ${(error as Error).message}`, 500, "io")
		}
	}

	async get(key: string): Promise<Buffer> {
		const target = this.pathFor(key)
		try {
			return await fsp.readFile(target)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new StorageError("The stored document file was not found.", 404, "not_found")
			}
			throw new StorageError(`Local storage read failed: ${(error as Error).message}`, 500, "io")
		}
	}

	async getStream(key: string): Promise<Readable> {
		const target = this.pathFor(key)
		if (!fs.existsSync(target)) {
			throw new StorageError("The stored document file was not found.", 404, "not_found")
		}
		return fs.createReadStream(target)
	}

	async exists(key: string): Promise<boolean> {
		return fs.existsSync(this.pathFor(key))
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		const target = this.pathFor(key)
		let stat: fs.Stats
		try {
			stat = await fsp.stat(target)
		} catch {
			return null
		}
		let sidecar: { contentType?: string; metadata?: Record<string, string> } = {}
		try {
			sidecar = JSON.parse(await fsp.readFile(`${target}${META_SUFFIX}`, "utf8"))
		} catch {
			// A missing sidecar is not an error: the extension still identifies the type.
		}
		return {
			key,
			size: stat.size,
			contentType: sidecar.contentType || contentTypeForExtension(path.extname(target)),
			lastModified: stat.mtime.toISOString(),
			metadata: sidecar.metadata ?? {},
		}
	}

	async delete(key: string): Promise<boolean> {
		const target = this.pathFor(key)
		let removed = false
		try {
			await fsp.rm(target)
			removed = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new StorageError(`Local storage delete failed: ${(error as Error).message}`, 500, "io")
			}
		}
		await fsp.rm(`${target}${META_SUFFIX}`, { force: true }).catch(() => {})
		return removed
	}

	/**
	 * Legacy escape hatch for versions written before Phase 5, whose
	 * `storage_path` is an absolute filesystem path rather than an object key.
	 * Only used when the row has no object key at all.
	 */
	async readLegacyPath(absolutePath: string): Promise<Buffer> {
		try {
			return await fsp.readFile(absolutePath)
		} catch {
			throw new StorageError("The stored document file was not found.", 404, "not_found")
		}
	}
}
