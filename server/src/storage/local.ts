import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable as NodeReadable } from 'node:stream';
import type { FileStorage } from './index';

/** Stores objects on the local filesystem. For development only. */
export class LocalDiskStorage implements FileStorage {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  /** Resolve a key to an absolute path, refusing anything that escapes baseDir. */
  private resolve(key: string): string {
    const full = path.resolve(this.baseDir, key);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  async save(key: string, data: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await pipeline(NodeReadable.from(data), createWriteStream(full));
  }

  createReadStream(key: string): Readable {
    return createReadStream(this.resolve(key));
  }

  async getBytes(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.createReadStream(key)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Local disk can't issue upload URLs — callers fall back to a direct upload. */
  async createUploadUrl(): Promise<string | null> {
    return null;
  }
}
