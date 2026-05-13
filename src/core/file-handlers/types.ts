import type { TFile } from 'obsidian';

/**
 * Metadata structure stored in files for version control
 */
export interface FileHandlerMetadata {
  /** Unique identifier for the note */
  'vc-id': string;
  /** Optional timestamp for tracking */
  'vc-timestamp'?: string;
}

/**
 * Result of reading metadata from a file
 */
export interface ReadMetadataResult {
  /** The vc-id if found, null otherwise */
  vcId: string | null;
  /** Whether the file is supported by this handler */
  isSupported: boolean;
  /** Any error encountered during read */
  error?: string;
}

/**
 * Options for writing metadata to a file
 */
export interface WriteMetadataOptions {
  /** The vc-id to write */
  vcId: string;
  /** Additional metadata fields (optional) */
  additionalData?: Record<string, any>;
}

/**
 * Interface that all file handlers must implement
 */
export interface IFileHandler {
  /**
   * File extensions supported by this handler (without dot)
   */
  readonly supportedExtensions: string[];

  /**
   * Check if this handler supports a given file
   */
  supportsFile(file: TFile): boolean;

  /**
   * Read vc-id metadata from a file
   * @param file The file to read from
   * @param content Optional pre-read content to avoid duplicate reads
   */
  readMetadata(file: TFile, content?: string): Promise<ReadMetadataResult>;

  /**
   * Write vc-id metadata to a file
   * @param file The file to write to
   * @param options Metadata options
   */
  writeMetadata(file: TFile, options: WriteMetadataOptions): Promise<boolean>;

  /**
   * Remove vc-id metadata from a file
   * @param file The file to clean
   */
  removeMetadata(file: TFile): Promise<boolean>;

  /**
   * Validate that a file's content is safe to modify
   * @param file The file to validate
   * @param content The file content
   */
  validateContent(file: TFile, content: string): Promise<boolean>;
}
