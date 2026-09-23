/**
 * Storage provider factory.
 *
 * Mode selection is explicit (STORAGE_MODE), exactly like every other NOVA
 * provider: Azure is never auto-detected from the presence of credentials.
 *
 *   STORAGE_MODE=local       -> LocalStorageProvider   (filesystem, STORAGE_DIR)
 *   STORAGE_MODE=azure_blob  -> AzureBlobStorageProvider (Azure Blob Storage)
 *
 * There is NO fallback. If Azure Blob storage is selected and its configuration
 * is missing or invalid, construction throws: production files must never be
 * written silently to local disk.
 */
import { getConfig } from "../config/index.ts"
import { BlobClient } from "../azure/blob.ts"
import { AzureBlobStorageProvider } from "./azure_blob.ts"
import { LocalStorageProvider } from "./local.ts"
import { StorageError, type StorageProvider } from "./base.ts"

export function createStorageProvider(): StorageProvider {
	const config = getConfig()
	if (config.modes.storageMode === "azure_blob") return createAzureBlobStorageProvider()
	return new LocalStorageProvider(config.paths.storageDir)
}

/**
 * Builds the Azure Blob provider from configuration. Shared by the runtime
 * factory and the storage:* commands, so there is exactly one place where the
 * connection string, container and account name are wired together.
 */
export function createAzureBlobStorageProvider(): AzureBlobStorageProvider {
	const config = getConfig()
	const storage = config.azure?.storage
	if (!storage?.connectionString) {
		throw new StorageError("STORAGE_MODE=azure_blob requires AZURE_STORAGE_CONNECTION_STRING.", 500, "config")
	}
	if (!storage.container) {
		throw new StorageError("STORAGE_MODE=azure_blob requires AZURE_STORAGE_CONTAINER.", 500, "config")
	}
	return new AzureBlobStorageProvider(
		new BlobClient({
			connectionString: storage.connectionString,
			container: storage.container,
			expectedAccount: storage.account || undefined,
		}),
	)
}

export { LocalStorageProvider } from "./local.ts"
export { AzureBlobStorageProvider } from "./azure_blob.ts"
export {
	StorageError,
	assertSafeObjectKey,
	buildObjectKey,
	contentTypeForExtension,
	isSafeObjectKey,
	keyBelongsToTenant,
	safeExtension,
	tenantKeyPrefix,
	type ObjectMetadata,
	type PutOptions,
	type PutResult,
	type StorageMode,
	type StorageProvider,
} from "./base.ts"
