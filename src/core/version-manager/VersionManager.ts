import { App, TFile, MarkdownView, TFolder } from 'obsidian';
import { orderBy } from 'es-toolkit';
import { map } from 'es-toolkit/compat';
import { ManifestManager } from '@/core';
import { NoteManager } from '@/core';
import type { VersionControlSettings, VersionHistoryEntry, NoteManifest, Branch, HistorySettings } from '@/types';
import { generateUniqueFilePath } from '@/utils/file';
import { PluginEvents } from '@/core';
import { VersionContentRepository } from '@/core';
import type VersionControlPlugin from '@/main';
import type { SaveVersionOptions, SaveVersionResult, UpdateVersionDetails, BranchState } from '@/core/version-manager/types';
import { SaveOperation, RestoreOperation, DeleteOperation, UpdateOperation } from '@/core/version-manager/operations';
import { VersionValidator } from '@/core/version-manager/validation';
import { QueueService } from '@/services';
import { SettingsResolver, type LoosePartial } from '@/core/settings';
import { updateFrontmatter, DELETE } from "@/utils/frontmatter";
import type { EditHistoryManager } from '@/core';
import { fileHandlerRegistry } from '@/core/file-handlers';

export class VersionManager {
  private readonly saveOperation: SaveOperation;
  private readonly restoreOperation: RestoreOperation;
  private readonly deleteOperation: DeleteOperation;
  private readonly updateOperation: UpdateOperation;

  constructor(
    private readonly plugin: VersionControlPlugin,
    private readonly app: App,
    private readonly manifestManager: ManifestManager,
    private readonly noteManager: NoteManager,
    private readonly versionContentRepo: VersionContentRepository,
    private readonly eventBus: PluginEvents,
    private readonly queueService: QueueService,
    private readonly editHistoryManager: EditHistoryManager
  ) {
    this.saveOperation = new SaveOperation(
      this.app,
      this.manifestManager,
      this.noteManager,
      this.versionContentRepo,
      this.eventBus,
      this.queueService
    );

    this.restoreOperation = new RestoreOperation(
      this.app,
      this.versionContentRepo,
      this.queueService,
      this.noteManager
    );

    this.deleteOperation = new DeleteOperation(
      this.app,
      this.manifestManager,
      this.versionContentRepo,
      this.eventBus,
      this.plugin,
      this.queueService,
      this.editHistoryManager,
      this.noteManager
    );

    this.updateOperation = new UpdateOperation(
      this.manifestManager,
      this.versionContentRepo,
      this.getEffectiveSettings.bind(this),
      this.queueService
    );
  }

  private get noteIdKey(): string {
    return this.plugin.settings.noteIdFrontmatterKey;
  }

  public async saveNewVersionForFile(file: TFile, options: SaveVersionOptions): Promise<SaveVersionResult> {
    return this.saveOperation.execute(file, options);
  }

  public async updateVersionDetails(noteId: string, versionId: string, details: UpdateVersionDetails): Promise<string> {
    return this.updateOperation.execute(noteId, versionId, details);
  }

  private getEffectiveSettings(noteManifest: NoteManifest): VersionControlSettings {
    const branch = noteManifest.branches[noteManifest.currentBranch];
    const resolvedHistorySettings = SettingsResolver.resolve(
      this.plugin.settings.versionHistorySettings,
      branch?.settings as LoosePartial<HistorySettings> | undefined
    );
    
    return {
      ...this.plugin.settings,
      versionHistorySettings: resolvedHistorySettings,
      ...resolvedHistorySettings
    };
  }

  public async getVersionHistory(noteId: string): Promise<VersionHistoryEntry[]> {
    if (!noteId) return [];
    try {
      const noteManifest = await this.manifestManager.loadNoteManifest(noteId);
      if (!noteManifest) return [];

      const branchName = noteManifest.currentBranch;
      const currentBranch = noteManifest.branches[branchName];
      if (!currentBranch || !currentBranch.versions) return [];

      const history = map(currentBranch.versions, (data, id) => ({
        id,
        noteId,
        notePath: noteManifest.notePath,
        branchName,
        versionNumber: data.versionNumber,
        timestamp: data.timestamp,
        size: data.size,
        ...(data.name && { name: data.name }),
        ...(data.description && { description: data.description }),
        wordCount: data.wordCount,
        wordCountWithMd: data.wordCountWithMd,
        charCount: data.charCount,
        charCountWithMd: data.charCountWithMd,
        lineCount: data.lineCount,
        lineCountWithoutMd: data.lineCountWithoutMd,
      }));

      return orderBy(history, ['versionNumber'], ['desc']);
    } catch (error) {
      console.error(`VC: Failed to get version history for note ${noteId}.`, error);
      throw new Error(`Failed to get version history for note ${noteId}.`);
    }
  }

  public async getVersionContent(noteId: string, versionId: string): Promise<string | null> {
    return this.versionContentRepo.read(noteId, versionId);
  }

  public async restoreVersion(liveFile: TFile, noteId: string, versionId: string): Promise<boolean> {
    const result = await this.restoreOperation.execute(liveFile, noteId, versionId);
    if (result) {
      // Write metadata using appropriate handler based on file extension
      if (liveFile.extension === 'md') {
        await this.noteManager.writeNoteIdToFrontmatter(liveFile, noteId);
      } else if (liveFile.extension === 'canvas' || liveFile.extension === 'json' || liveFile.extension === 'js') {
        const handler = fileHandlerRegistry.getHandlerForFile(liveFile);
        if (handler) {
          await handler.writeMetadata(liveFile, { vcId: noteId });
        }
      }
    }
    return result;
  }

  public async createDeviation(noteId: string, versionId: string, targetFolder: TFolder | null, copyVersions: boolean = false): Promise<TFile | null> {
    VersionValidator.validateDeviationParams(noteId, versionId);
    
    // Load version metadata to get version number
    const noteManifest = await this.manifestManager.loadNoteManifest(noteId);
    if (!noteManifest) {
      throw new Error('Note manifest not found for deviation');
    }
    
    const currentBranch = noteManifest.branches[noteManifest.currentBranch];
    if (!currentBranch || !currentBranch.versions[versionId]) {
      throw new Error('Version not found in current branch');
    }
    
    const versionData = currentBranch.versions[versionId];
    const versionNumber = versionData.versionNumber;
    
    const versionContent = await this.getVersionContent(noteId, versionId);
    if (versionContent === null) throw new Error('Could not load version content for deviation.');
    
    // Use format: "Note Name vX" where X is the version number
    const suffix = `v${versionNumber}`;
    
    return this.createDeviationFromContent(noteId, versionContent, targetFolder, suffix, copyVersions ? noteId : undefined, versionId);
  }

  public async createDeviationFromContent(noteId: string, content: string, targetFolder: TFolder | null, suffix: string, sourceNoteId?: string, sourceVersionId?: string): Promise<TFile | null> {
    VersionValidator.validateDeviationParams(noteId);
    const noteManifest = await this.manifestManager.loadNoteManifest(noteId);
    const originalFile = noteManifest ? this.app.vault.getAbstractFileByPath(noteManifest.notePath) : null;
    const originalTFile = originalFile instanceof TFile ? originalFile : null;
    const baseName = originalTFile?.basename || 'Untitled Version';
    const extension = originalTFile?.extension || 'md';

    let parentPath = targetFolder?.isRoot() ? '' : targetFolder?.path ?? originalTFile?.parent?.path ?? '';
    if (parentPath === '/') parentPath = '';

    const newFileNameBase = `${baseName} ${suffix}`;
    const newFilePath = await generateUniqueFilePath(this.app, newFileNameBase, parentPath, extension);

    // CRITICAL: Register pending deviation before creation to block event handlers
    this.noteManager.addPendingDeviation(newFilePath);

    try {
      const newFile = await this.app.vault.create(newFilePath, content);
      if (!newFile) throw new Error('Failed to create the new note file for deviation.');

      if (extension === 'md') {
        try {
          // Prepare updates: remove primary key AND all legacy keys
          const updates: Record<string, any> = {
             [this.noteIdKey]: DELETE
          };
          
          // Add legacy keys to deletion list
          const legacyKeys = this.plugin.settings.legacyNoteIdFrontmatterKeys || [];
          for (const key of legacyKeys) {
              updates[key] = DELETE;
          }

          const result = await updateFrontmatter(this.app, newFile, updates);
          if (!result.success) {
             throw result.error || new Error("Failed to remove ID from deviation");
          }
        } catch (fmError) {
          console.error(`VC: Failed to remove vc-id from new deviation note "${newFilePath}". Trashing.`, fmError);
          await this.app.vault.trash(newFile, true).catch((delErr) => {
            console.error(`VC: CRITICAL: Failed to trash corrupted deviation file "${newFilePath}".`, delErr);
          });
          throw new Error(`Failed to create a clean deviation.`);
        }
      } else if (extension === 'canvas' || extension === 'json' || extension === 'js') {
        // For non-md files, remove metadata using the handler
        try {
          const handler = fileHandlerRegistry.getHandlerForFile(newFile);
          if (handler) {
            await handler.removeMetadata(newFile);
          }
        } catch (metaError) {
          console.error(`VC: Failed to remove vc-id from new deviation file "${newFilePath}". Trashing.`, metaError);
          await this.app.vault.trash(newFile, true).catch((delErr) => {
            console.error(`VC: CRITICAL: Failed to trash corrupted deviation file "${newFilePath}".`, delErr);
          });
          throw new Error(`Failed to create a clean deviation.`);
        }
      }
      
      // If copyVersions is true and sourceNoteId is provided, copy versions from source to new deviation
      if (sourceNoteId && sourceVersionId) {
        await this.copyVersionsToDeviation(sourceNoteId, newFile, sourceVersionId);
      } else if (sourceNoteId) {
        // Fallback for backward compatibility - copy all versions
        await this.copyVersionsToDeviation(sourceNoteId, newFile);
      }
      
      return newFile;
    } catch (error) {
      console.error(`VC: Failed to create deviation for note ${noteId}.`, error);
      throw error;
    } finally {
      // CRITICAL: Only remove from pending list after all operations (success or failure) are complete
      this.noteManager.removePendingDeviation(newFilePath);
    }
  }

  /**
   * Copies versions from a source note to a deviation (new note).
   * If sourceVersionId is provided, copies only versions up to and including that version.
   * Creates a new branch in the deviation's manifest with copied version entries.
   * Version content files are duplicated with new naming convention.
   */
  private async copyVersionsToDeviation(sourceNoteId: string, deviationFile: TFile, sourceVersionId?: string): Promise<void> {
    try {
      // Generate a new note ID for the deviation
      const deviationNoteId = await this.noteManager.getOrCreateNoteId(deviationFile);
      if (!deviationNoteId) {
        throw new Error('Failed to create note ID for deviation');
      }

      // Load source note manifest
      const sourceManifest = await this.manifestManager.loadNoteManifest(sourceNoteId);
      if (!sourceManifest) {
        throw new Error('Source note manifest not found');
      }

      const sourceBranchName = sourceManifest.currentBranch;
      const sourceBranch = sourceManifest.branches[sourceBranchName];
      if (!sourceBranch || !sourceBranch.versions || Object.keys(sourceBranch.versions).length === 0) {
        // No versions to copy
        return;
      }

      // Filter versions: if sourceVersionId is provided, include only versions up to and including it
      let versionEntries = Object.entries(sourceBranch.versions);
      if (sourceVersionId) {
        const sourceVersionData = sourceBranch.versions[sourceVersionId];
        if (!sourceVersionData) {
          throw new Error(`Source version ${sourceVersionId} not found`);
        }
        const cutoffTimestamp = new Date(sourceVersionData.timestamp).getTime();
        
        // Include only versions with timestamp <= cutoff (i.e., created before or at the same time as sourceVersionId)
        versionEntries = versionEntries.filter(([, versionData]) => {
          const versionTimestamp = new Date(versionData.timestamp).getTime();
          return versionTimestamp <= cutoffTimestamp;
        });
        
        // Sort by versionNumber to ensure correct order
        versionEntries.sort((a, b) => a[1].versionNumber - b[1].versionNumber);
      }

      // Create a new branch in the deviation's manifest for copied versions
      const copiedBranchName = 'copied-versions';
      
      // Initialize deviation manifest with the copied branch
      await this.manifestManager.updateNoteManifest(deviationNoteId, deviationManifest => {
        const currentBranchSettings = sourceBranch.settings;
        const newBranch: Branch = { 
          versions: {}, 
          totalVersions: 0,
          state: sourceBranch.state ? { ...sourceBranch.state } : undefined
        };
        if (currentBranchSettings) {
          newBranch.settings = { ...currentBranchSettings };
        }
        deviationManifest.branches[copiedBranchName] = newBranch;
        deviationManifest.currentBranch = copiedBranchName;
      });

      // Copy each version entry and content
      for (const [versionId, versionData] of versionEntries) {
        // Read version content from source
        const versionContent = await this.versionContentRepo.read(sourceNoteId, versionId);
        if (!versionContent) {
          console.warn(`VC: Could not read version ${versionId} from source ${sourceNoteId}, skipping...`);
          continue;
        }

        // Generate new version ID for the deviation
        const timestamp = new Date(versionData.timestamp).getTime().toString();
        const newVersionId = `${deviationNoteId}_${timestamp}`;

        // Save version content to the deviation's version storage
        await this.versionContentRepo.write(deviationNoteId, newVersionId, versionContent);

        // Add version entry to deviation's manifest
        await this.manifestManager.updateNoteManifest(deviationNoteId, deviationManifest => {
          const branch = deviationManifest.branches[copiedBranchName];
          if (branch) {
            const { id: _, ...versionDataWithoutId } = versionData as any;
            branch.versions[newVersionId] = {
              ...versionDataWithoutId,
              // Update any metadata that should reflect the new context
              originalVersionId: versionId,
              originalNoteId: sourceNoteId,
            };
            branch.totalVersions = (branch.totalVersions || 0) + 1;
          }
        });
      }

      console.log(`VC: Successfully copied ${versionEntries.length} versions from ${sourceNoteId} to deviation ${deviationNoteId}`);
    } catch (error) {
      console.error(`VC: Failed to copy versions to deviation`, error);
      throw error;
    }
  }

  public async deleteVersion(noteId: string, versionId: string): Promise<boolean> {
    return this.deleteOperation.deleteVersion(noteId, versionId);
  }

  public async deleteAllVersionsInCurrentBranch(noteId: string): Promise<boolean> {
    return this.deleteOperation.deleteAllVersionsInCurrentBranch(noteId);
  }

  public async createBranch(noteId: string, newBranchName: string): Promise<void> {
    await this.manifestManager.updateNoteManifest(noteId, manifest => {
      if (manifest.branches[newBranchName]) throw new Error(`Branch "${newBranchName}" already exists.`);
      const currentBranchSettings = manifest.branches[manifest.currentBranch]?.settings;
      const newBranch: Branch = { versions: {}, totalVersions: 0 };
      if (currentBranchSettings) newBranch.settings = currentBranchSettings;
      manifest.branches[newBranchName] = newBranch;
    });
  }

  public async switchBranch(noteId: string, newBranchName: string): Promise<void> {
    const noteManifest = await this.manifestManager.loadNoteManifest(noteId);
    if (!noteManifest) throw new Error('Manifest not found');
    const currentBranchName = noteManifest.currentBranch;
    if (currentBranchName === newBranchName) return;

    let targetView: MarkdownView | null = null;
    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of markdownLeaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === noteManifest.notePath) {
        targetView = leaf.view;
        break;
      }
    }

    if (targetView) {
      let state: BranchState | null = null;
      if (targetView.getMode() === 'source') {
        state = {
          content: targetView.editor.getValue(),
          cursor: targetView.editor.getCursor(),
          scroll: targetView.editor.getScrollInfo()
        };
      } else if (targetView.file) {
        const content = await this.app.vault.read(targetView.file);
        state = { content, cursor: { line: 0, ch: 0 }, scroll: { left: 0, top: 0 } };
      }

      if (state) {
        await this.manifestManager.updateNoteManifest(noteId, manifest => {
          const branch = manifest.branches[currentBranchName];
          if (branch) branch.state = state;
        });
      }
    } else {
      try {
        const content = await this.app.vault.adapter.read(noteManifest.notePath);
        const state: BranchState = { content, cursor: { line: 0, ch: 0 }, scroll: { left: 0, top: 0 } };
        await this.manifestManager.updateNoteManifest(noteId, manifest => {
          const branch = manifest.branches[currentBranchName];
          if (branch) branch.state = state;
        });
      } catch (e) {
        console.warn(`VC: Could not save state for ${noteManifest.notePath}`, e);
      }
    }

    await this.manifestManager.updateNoteManifest(noteId, manifest => {
      if (!manifest.branches[newBranchName]) throw new Error(`Branch "${newBranchName}" does not exist.`);
      manifest.currentBranch = newBranchName;
    });

    const newManifest = await this.manifestManager.loadNoteManifest(noteId);
    if (!newManifest) throw new Error("Failed to reload manifest after switching branch.");

    const newBranch = newManifest.branches[newBranchName];
    const newBranchState = newBranch?.state;
    let contentToRestore: string | null = null;

    if (newBranchState) {
      contentToRestore = newBranchState.content;
    } else {
      contentToRestore = await this.versionContentRepo.getLatestVersionContent(noteId, newManifest);
    }

    if (contentToRestore !== null) {
        const file = this.app.vault.getAbstractFileByPath(noteManifest.notePath);
        if (file instanceof TFile) {
            // IGNORE INTERNAL WRITE: Prevent auto-save or metadata loop when restoring branch content
            this.noteManager.registerInternalWrite(file.path);
            
            await this.app.vault.modify(file, contentToRestore);
            
            if (file.extension === 'md') await this.noteManager.writeNoteIdToFrontmatter(file, noteId);
            if (targetView && newBranchState && targetView.getMode() === 'source') {
                try {
                    targetView.editor.setCursor(newBranchState.cursor);
                    targetView.editor.scrollTo(newBranchState.scroll.left, newBranchState.scroll.top);
                } catch (e) {
                    console.debug("VC: Could not restore cursor position after branch switch.");
                }
            }
        }
    }
  }

  public async deleteBranch(noteId: string, branchName: string): Promise<boolean> {
    return this.deleteOperation.deleteBranch(noteId, branchName);
  }
}
