import type { TFile } from 'obsidian';
import type { IFileHandler, ReadMetadataResult, WriteMetadataOptions } from './types';

/**
 * File handler for JSON (.json) files
 * Stores vc-id in a _vc_meta field at the root level of the JSON
 * Similar to canvas handler but for generic JSON files
 */
export class JsonHandler implements IFileHandler {
  readonly supportedExtensions = ['json'];

  private readonly META_KEY = '_vc_meta';

  supportsFile(file: TFile): boolean {
    return file.extension === 'json';
  }

  async readMetadata(file: TFile, content?: string): Promise<ReadMetadataResult> {
    try {
      let fileContent: string;
      
      if (content !== undefined) {
        fileContent = content;
      } else {
        fileContent = await (file as any).app.vault.cachedRead(file);
      }

      // Parse JSON safely
      let jsonData: Record<string, any>;
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: JsonHandler failed to parse JSON ${file.path}`, parseError);
        return { 
          vcId: null, 
          isSupported: true, 
          error: 'Invalid JSON format' 
        };
      }

      // Check for vc-meta field
      const vcMeta = jsonData[this.META_KEY];
      
      if (!vcMeta || typeof vcMeta !== 'object') {
        return { vcId: null, isSupported: true };
      }

      const vcId = vcMeta['vc-id'] as string | undefined;
      
      if (vcId && typeof vcId === 'string' && vcId.trim() !== '') {
        return { vcId, isSupported: true };
      }

      return { vcId: null, isSupported: true };
    } catch (error) {
      console.error(`VC: JsonHandler failed to read metadata for ${file.path}`, error);
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

      // Parse JSON
      let jsonData: Record<string, any>;
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: JsonHandler failed to parse JSON ${file.path}`, parseError);
        return false;
      }

      // Update or create vc-meta field
      if (!jsonData[this.META_KEY]) {
        jsonData[this.META_KEY] = {};
      }

      jsonData[this.META_KEY]['vc-id'] = options.vcId;
      
      // Add timestamp if provided
      if (options.additionalData?.['timestamp']) {
        jsonData[this.META_KEY]['vc-timestamp'] = options.additionalData['timestamp'];
      }

      // Serialize back to JSON with proper formatting
      const updatedContent = JSON.stringify(jsonData, null, 2);

      // Write back to file
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: JsonHandler failed to write metadata for ${file.path}`, error);
      return false;
    }
  }

  async removeMetadata(file: TFile): Promise<boolean> {
    try {
      const fileContent = await (file as any).app.vault.read(file);
      
      let jsonData: Record<string, any>;
      try {
        jsonData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: JsonHandler failed to parse JSON ${file.path}`, parseError);
        return false;
      }

      // Remove the vc-meta field entirely
      delete jsonData[this.META_KEY];

      const updatedContent = JSON.stringify(jsonData, null, 2);
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: JsonHandler failed to remove metadata for ${file.path}`, error);
      return false;
    }
  }

  async validateContent(_file: TFile, content: string): Promise<boolean> {
    try {
      const data = JSON.parse(content);
      
      // Validate it's an object or array (valid JSON structures)
      if (typeof data !== 'object' || data === null) {
        return false;
      }

      return true;
    } catch {
      return false; // Invalid JSON
    }
  }
}
