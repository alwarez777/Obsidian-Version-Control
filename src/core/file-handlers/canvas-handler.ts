import type { TFile } from 'obsidian';
import type { IFileHandler, ReadMetadataResult, WriteMetadataOptions } from './types';

/**
 * File handler for Canvas (.canvas) files
 * Stores vc-id in a hidden _vc_meta field at the root level of the JSON
 * This field is not rendered on the canvas UI
 */
export class CanvasHandler implements IFileHandler {
  readonly supportedExtensions = ['canvas'];

  private readonly META_KEY = '_vc_meta';

  supportsFile(file: TFile): boolean {
    return file.extension === 'canvas';
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
      let canvasData: Record<string, any>;
      try {
        canvasData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: CanvasHandler failed to parse canvas ${file.path}`, parseError);
        return { 
          vcId: null, 
          isSupported: true, 
          error: 'Invalid JSON format' 
        };
      }

      // Check for vc-meta field
      const vcMeta = canvasData[this.META_KEY];
      
      if (!vcMeta || typeof vcMeta !== 'object') {
        return { vcId: null, isSupported: true };
      }

      const vcId = vcMeta['vc-id'] as string | undefined;
      
      if (vcId && typeof vcId === 'string' && vcId.trim() !== '') {
        return { vcId, isSupported: true };
      }

      return { vcId: null, isSupported: true };
    } catch (error) {
      console.error(`VC: CanvasHandler failed to read metadata for ${file.path}`, error);
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
      let canvasData: Record<string, any>;
      try {
        canvasData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: CanvasHandler failed to parse canvas ${file.path}`, parseError);
        return false;
      }

      // Update or create vc-meta field
      if (!canvasData[this.META_KEY]) {
        canvasData[this.META_KEY] = {};
      }

      canvasData[this.META_KEY]['vc-id'] = options.vcId;
      
      // Add timestamp if provided
      if (options.additionalData?.['timestamp']) {
        canvasData[this.META_KEY]['vc-timestamp'] = options.additionalData['timestamp'];
      }

      // Serialize back to JSON with proper formatting
      const updatedContent = JSON.stringify(canvasData, null, 2);

      // Write back to file
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: CanvasHandler failed to write metadata for ${file.path}`, error);
      return false;
    }
  }

  async removeMetadata(file: TFile): Promise<boolean> {
    try {
      const fileContent = await (file as any).app.vault.read(file);
      
      let canvasData: Record<string, any>;
      try {
        canvasData = JSON.parse(fileContent);
      } catch (parseError) {
        console.error(`VC: CanvasHandler failed to parse canvas ${file.path}`, parseError);
        return false;
      }

      // Remove the vc-meta field entirely
      delete canvasData[this.META_KEY];

      const updatedContent = JSON.stringify(canvasData, null, 2);
      await (file as any).app.vault.modify(file, updatedContent);

      return true;
    } catch (error) {
      console.error(`VC: CanvasHandler failed to remove metadata for ${file.path}`, error);
      return false;
    }
  }

  async validateContent(_file: TFile, content: string): Promise<boolean> {
    try {
      const data = JSON.parse(content);
      
      // Validate it's an object with expected canvas structure
      if (typeof data !== 'object' || data === null) {
        return false;
      }

      // Canvas files should have nodes or edges arrays (or be empty canvas)
      // We're permissive here to allow various canvas structures
      return true;
    } catch {
      return false; // Invalid JSON
    }
  }
}
