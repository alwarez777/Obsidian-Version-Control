/**
 * File Handler Module
 * 
 * Provides abstraction for handling different file types (.md, .canvas, .js, .json)
 * with unified interface for version control metadata operations.
 */

export { FileHandlerRegistry, fileHandlerRegistry } from './file-handler-registry';
export type { IFileHandler, FileHandlerMetadata, ReadMetadataResult, WriteMetadataOptions } from './types';
