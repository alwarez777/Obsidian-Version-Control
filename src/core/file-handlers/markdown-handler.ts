import type { TFile } from 'obsidian';
import type { IFileHandler, ReadMetadataResult, WriteMetadataOptions } from './types';
import { updateFrontmatter, DELETE } from '@/utils/frontmatter';

/**
 * File handler for Markdown (.md) files
 * Uses YAML frontmatter to store vc-id
 */
export class MarkdownHandler implements IFileHandler {
  readonly supportedExtensions = ['md'];

  supportsFile(file: TFile): boolean {
    return file.extension === 'md';
  }

  async readMetadata(file: TFile, _content?: string): Promise<ReadMetadataResult> {
    try {
      const fileCache = (file as any).app?.metadataCache?.getFileCache(file);
      const frontmatter = fileCache?.frontmatter;
      
      if (!frontmatter) {
        return { vcId: null, isSupported: true };
      }

      const vcId = frontmatter['vc-id'] as string | undefined;
      
      if (vcId && typeof vcId === 'string' && vcId.trim() !== '') {
        return { vcId, isSupported: true };
      }

      return { vcId: null, isSupported: true };
    } catch (error) {
      console.error(`VC: MarkdownHandler failed to read metadata for ${file.path}`, error);
      return { 
        vcId: null, 
        isSupported: true, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  async writeMetadata(file: TFile, options: WriteMetadataOptions): Promise<boolean> {
    try {
      const updates: Record<string, any> = {
        'vc-id': options.vcId
      };

      // Clean up legacy keys if provided
      if (options.additionalData?.['legacyKeys']) {
        for (const key of options.additionalData['legacyKeys']) {
          updates[key] = DELETE;
        }
      }

      const result = await updateFrontmatter((file as any).app, file, updates);
      
      if (!result.success) {
        throw result.error || new Error('Failed to update frontmatter');
      }

      return true;
    } catch (error) {
      console.error(`VC: MarkdownHandler failed to write metadata for ${file.path}`, error);
      return false;
    }
  }

  async removeMetadata(file: TFile): Promise<boolean> {
    try {
      const result = await updateFrontmatter((file as any).app, file, {
        'vc-id': DELETE
      });

      return result.success === true;
    } catch (error) {
      console.error(`VC: MarkdownHandler failed to remove metadata for ${file.path}`, error);
      return false;
    }
  }

  async validateContent(_file: TFile, content: string): Promise<boolean> {
    // Basic validation: check if frontmatter exists and is valid YAML
    if (!content.startsWith('---')) {
      return true; // No frontmatter, safe to add
    }

    const endMarker = content.indexOf('---', 3);
    if (endMarker === -1) {
      return false; // Invalid frontmatter (no closing marker)
    }

    return true;
  }
}
