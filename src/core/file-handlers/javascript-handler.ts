import type { TFile } from 'obsidian';
import type { IFileHandler, ReadMetadataResult, WriteMetadataOptions } from './types';

/**
 * File handler for JavaScript (.js) files
 * Stores vc-id in a special comment block at the top of the file
 * Format: /* VC_META: {"vc-id": "..."} *\/
 */
export class JavaScriptHandler implements IFileHandler {
  readonly supportedExtensions = ['js'];

  private readonly META_REGEX = /^\/\*\s*VC_META:\s*(\{[^*]*\})\s*\*\//;

  supportsFile(file: TFile): boolean {
    return file.extension === 'js';
  }

  async readMetadata(file: TFile, content?: string): Promise<ReadMetadataResult> {
    try {
      let fileContent: string;
      
      if (content !== undefined) {
        fileContent = content;
      } else {
        fileContent = await (file as any).app.vault.cachedRead(file);
      }

      // Look for VC_META comment at the beginning of the file
      const lines = fileContent.split('\n');
      let metaLine = '';
      
      // Check first few lines for the meta comment
      for (let i = 0; i < Math.min(5, lines.length); i++) {
        const line = lines[i]?.trim();
        if (line && line.startsWith('/* VC_META:')) {
          metaLine = line;
          break;
        }
      }

      if (!metaLine) {
        return { vcId: null, isSupported: true };
      }

      // Extract JSON from comment
      const match = metaLine.match(this.META_REGEX);
      if (!match || !match[1]) {
        return { vcId: null, isSupported: true };
      }

      try {
        const metaData = JSON.parse(match[1]);
        const vcId = metaData['vc-id'] as string | undefined;
        
        if (vcId && typeof vcId === 'string' && vcId.trim() !== '') {
          return { vcId, isSupported: true };
        }

        return { vcId: null, isSupported: true };
      } catch (parseError) {
        console.error(`VC: JavaScriptHandler failed to parse metadata for ${file.path}`, parseError);
        return { 
          vcId: null, 
          isSupported: true, 
          error: 'Invalid metadata JSON' 
        };
      }
    } catch (error) {
      console.error(`VC: JavaScriptHandler failed to read metadata for ${file.path}`, error);
      return { 
        vcId: null, 
        isSupported: true, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  async writeMetadata(file: TFile, options: WriteMetadataOptions): Promise<boolean> {
    try {
      let fileContent: string;
      
      if (options.additionalData?.['cachedContent']) {
        fileContent = options.additionalData['cachedContent'];
      } else {
        fileContent = await (file as any).app.vault.read(file);
      }

      const metaData: Record<string, string> = {
        'vc-id': options.vcId
      };

      if (options.additionalData?.['timestamp']) {
        metaData['vc-timestamp'] = options.additionalData['timestamp'];
      }

      const metaComment = `/* VC_META: ${JSON.stringify(metaData)} */`;

      // Check if meta comment already exists
      const lines = fileContent.split('\n');
      let foundMeta = false;
      
      for (let i = 0; i < Math.min(5, lines.length); i++) {
        const line = lines[i]?.trim();
        if (line && line.startsWith('/* VC_META:')) {
          lines[i] = metaComment;
          foundMeta = true;
          break;
        }
      }

      if (!foundMeta) {
        // Add meta comment at the beginning
        lines.unshift(metaComment);
      }

      const updatedContent = lines.join('\n');
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: JavaScriptHandler failed to write metadata for ${file.path}`, error);
      return false;
    }
  }

  async removeMetadata(file: TFile): Promise<boolean> {
    try {
      const fileContent = await (file as any).app.vault.read(file);
      const lines = fileContent.split('\n');
      
      // Filter out VC_META comments
      const filteredLines = lines.filter((line: string) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('/* VC_META:');
      });

      const updatedContent = filteredLines.join('\n');
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: JavaScriptHandler failed to remove metadata for ${file.path}`, error);
      return false;
    }
  }

  async validateContent(_file: TFile, content: string): Promise<boolean> {
    // Basic validation: check if file is not empty and has valid JS structure
    // We're permissive here since JS can have many valid formats
    const trimmed = content.trim();
    
    if (trimmed.length === 0) {
      return false; // Empty file
    }

    // Check for obviously invalid content
    if (trimmed.startsWith('{') && !trimmed.includes('/* VC_META:')) {
      // Might be JSON instead of JS
      return false;
    }

    return true;
  }
}
