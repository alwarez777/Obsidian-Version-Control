import { App, TFolder, Vault, normalizePath } from "obsidian";
import { executeWithRetry } from "@/utils/retry";

/**
 * A low-level service for direct, robust interactions with the vault's file system adapter.
 * Uses shared retry logic for resilience and recursive folder creation for robustness.
 */
export class StorageService {
    private vault: Vault;

    constructor(app: App) {
        this.vault = app.vault;
    }

    /**
     * Recursively ensures that a folder structure exists.
     * If any part of the path is missing, it is created.
     * If a file exists where a folder is expected, an error is thrown.
     * 
     * @param path The full path of the folder to ensure.
     */
    public async ensureFolderExists(path: string): Promise<void> {
        // Normalize path to ensure consistent separators and remove leading/trailing slashes
        const normalizedPath = normalizePath(path);
        const folders = normalizedPath.split('/');
        
        await executeWithRetry(
            async () => {
                // CRITICAL: Reset currentPath at the start of each retry attempt.
                let currentPath = '';

                // Iterate through each segment of the path to ensure existence recursively
                for (const folder of folders) {
                    // Skip empty segments
                    if (!folder) continue;

                    currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;

                    // 1. Check Cache first (fastest)
                    const item = this.vault.getAbstractFileByPath(currentPath);
                    if (item) {
                        if (item instanceof TFolder) continue;
                        throw new Error(`A file exists at the required folder path "${currentPath}".`);
                    }

                    // 2. Try to create
                    try {
                        await this.vault.createFolder(currentPath);
                    } catch (error) {
                        // 3. Handle "Folder already exists" error
                        // This happens if the cache was stale (item was null) but FS has the folder.
                        // We must verify existence on disk to safely ignore the error.
                        
                        try {
                            const exists = await this.vault.adapter.exists(currentPath);
                            if (exists) {
                                const stat = await this.vault.adapter.stat(currentPath);
                                if (stat?.type === 'folder') {
                                    // It exists and is a folder. We are good.
                                    continue;
                                }
                                if (stat?.type === 'file') {
                                    throw new Error(`A file exists at the required folder path "${currentPath}".`);
                                }
                            }
                        } catch (checkError) {
                            // If adapter check fails, we throw the original error below
                        }

                        // If we are here, it means createFolder failed, and we couldn't verify existence of a folder.
                        // It might be a permissions error, or something else.
                        throw error;
                    }
                }
            },
            {
                context: `ensureFolderExists:${path}`,
                // Validate that the final path exists and is a folder
                validateSuccess: async () => {
                    const exists = await this.vault.adapter.exists(normalizedPath);
                    if (!exists) return false;
                    const stat = await this.vault.adapter.stat(normalizedPath);
                    return stat?.type === 'folder';
                }
            }
        );
    }

    public async permanentlyDeleteFolder(path: string): Promise<void> {
        await executeWithRetry(
            async () => {
                const exists = await this.vault.adapter.exists(path);
                if (exists) {
                    try {
                        await this.vault.adapter.rmdir(path, true);
                    } catch (error) {
                        const stillExists = await this.vault.adapter.exists(path);
                        if (!stillExists) return;
                        throw error;
                    }
                }
            },
            {
                context: `permanentlyDeleteFolder:${path}`,
                validateSuccess: async () => {
                    const exists = await this.vault.adapter.exists(path);
                    return !exists;
                }
            }
        );
    }

    public async renameFolder(oldPath: string, newPath: string): Promise<void> {
        await executeWithRetry(
            async () => {
                const sourceExists = await this.vault.adapter.exists(oldPath);
                const targetExists = await this.vault.adapter.exists(newPath);

                if (!sourceExists) {
                    if (targetExists) return;
                    throw new Error(`Source folder "${oldPath}" does not exist.`);
                }
                if (targetExists) throw new Error(`Destination path "${newPath}" already exists.`);

                try {
                    await this.vault.adapter.rename(oldPath, newPath);
                } catch (error) {
                    const s = await this.vault.adapter.exists(oldPath);
                    const t = await this.vault.adapter.exists(newPath);
                    if (!s && t) return;
                    throw error;
                }
            },
            {
                context: `renameFolder:${oldPath}->${newPath}`,
                validateSuccess: async () => {
                    const sourceExists = await this.vault.adapter.exists(oldPath);
                    const targetExists = await this.vault.adapter.exists(newPath);
                    return !sourceExists && targetExists;
                }
            }
        );
    }

    /**
     * Recursively copies a folder and all its contents to a new location.
     * Used for moving version data to trash or other backup operations.
     */
    public async copyFolder(sourcePath: string, destPath: string): Promise<void> {
        await executeWithRetry(
            async () => {
                const sourceExists = await this.vault.adapter.exists(sourcePath);
                if (!sourceExists) {
                    throw new Error(`Source folder "${sourcePath}" does not exist.`);
                }

                // Ensure destination parent folder exists
                const destParent = destPath.substring(0, destPath.lastIndexOf('/'));
                if (destParent) {
                    await this.ensureFolderExists(destParent);
                }

                // Get all files recursively from source
                const files = await this.vault.adapter.list(sourcePath);
                
                // Copy all files
                for (const filePath of files.files) {
                    const content = await this.vault.adapter.read(filePath);
                    const relativePath = filePath.substring(sourcePath.length + 1);
                    const destFilePath = `${destPath}/${relativePath}`;
                    
                    const destFileParent = destFilePath.substring(0, destFilePath.lastIndexOf('/'));
                    if (destFileParent) {
                        await this.ensureFolderExists(destFileParent);
                    }
                    
                    await this.vault.adapter.write(destFilePath, content);
                }

                // Recursively copy subfolders
                for (const folderPath of files.folders) {
                    const relativePath = folderPath.substring(sourcePath.length + 1);
                    const destFolderPath = `${destPath}/${relativePath}`;
                    await this.copyFolder(folderPath, destFolderPath);
                }
            },
            {
                context: `copyFolder:${sourcePath}->${destPath}`,
                validateSuccess: async () => {
                    const destExists = await this.vault.adapter.exists(destPath);
                    return destExists;
                }
            }
        );
    }

    /**
     * Moves a folder to the trash by copying it first, then deleting the original.
     * This is safer than direct move as it ensures data is preserved even if deletion fails.
     */
    public async moveFolderToTrash(sourcePath: string, trashPath: string): Promise<void> {
        try {
            // First copy to trash
            await this.copyFolder(sourcePath, trashPath);
            
            // Then delete original
            await this.permanentlyDeleteFolder(sourcePath);
        } catch (error) {
            console.error(`VC: Failed to move folder to trash from ${sourcePath}`, error);
            throw error;
        }
    }
}
