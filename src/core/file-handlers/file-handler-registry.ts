import type { TFile } from 'obsidian';
import type { IFileHandler } from './types';
import { MarkdownHandler } from './markdown-handler';
import { CanvasHandler } from './canvas-handler';
import { JavaScriptHandler } from './javascript-handler';
import { JsonHandler } from './json-handler';

/**
 * Registry for file handlers
 * Provides a unified interface to access the appropriate handler for any file type
 */
export class FileHandlerRegistry {
  private static instance: FileHandlerRegistry;
  private handlers: Map<string, IFileHandler> = new Map();

  private constructor() {
    this.registerDefaultHandlers();
  }

  /**
   * Get the singleton instance of the registry
   */
  static getInstance(): FileHandlerRegistry {
    if (!FileHandlerRegistry.instance) {
      FileHandlerRegistry.instance = new FileHandlerRegistry();
    }
    return FileHandlerRegistry.instance;
  }

  /**
   * Register default handlers for supported file types
   */
  private registerDefaultHandlers(): void {
    this.registerHandler(new MarkdownHandler());
    this.registerHandler(new CanvasHandler());
    this.registerHandler(new JavaScriptHandler());
    this.registerHandler(new JsonHandler());
  }

  /**
   * Register a new file handler
   * @param handler The handler to register
   */
  registerHandler(handler: IFileHandler): void {
    for (const ext of handler.supportedExtensions) {
      this.handlers.set(ext, handler);
    }
  }

  /**
   * Get the handler for a specific file extension
   * @param extension File extension without dot (e.g., 'md', 'canvas')
   */
  getHandler(extension: string): IFileHandler | undefined {
    return this.handlers.get(extension);
  }

  /**
   * Get the handler for a specific file
   * @param file The TFile to get a handler for
   */
  getHandlerForFile(file: TFile): IFileHandler | undefined {
    return this.handlers.get(file.extension);
  }

  /**
   * Check if a file type is supported
   * @param extension File extension without dot
   */
  isSupported(extension: string): boolean {
    return this.handlers.has(extension);
  }

  /**
   * Get all supported extensions
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Reset registry to defaults (useful for testing)
   */
  reset(): void {
    this.handlers.clear();
    this.registerDefaultHandlers();
  }
}

// Export singleton instance for convenience
export const fileHandlerRegistry = FileHandlerRegistry.getInstance();
