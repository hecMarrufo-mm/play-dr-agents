import type { Readable } from 'node:stream';
import { env } from '../config/env';
import { LocalDiskStorage } from './local';
import { GcsStorage } from './gcs';

/**
 * Storage abstraction so the app can use local disk in dev and Google Cloud
 * Storage in production, selected via STORAGE_DRIVER. Swap implementations
 * without touching the rest of the app.
 */
export interface FileStorage {
  /** Persist bytes under `key`. */
  save(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Stream bytes back (used to serve downloads efficiently). */
  createReadStream(key: string): Readable;
  /** Read all bytes into memory (used to feed file contents to the LLM). */
  getBytes(key: string): Promise<Buffer>;
  /** Remove an object. Must not throw if it is already gone. */
  delete(key: string): Promise<void>;
  /** Whether an object exists (used to confirm a direct upload landed). */
  exists(key: string): Promise<boolean>;
  /**
   * A short-lived URL the browser can PUT bytes to directly (bypassing the app
   * server and Cloud Run's request-size cap). Returns null if the backend can't
   * issue one (e.g. local disk) — callers should fall back to a direct upload.
   */
  createUploadUrl(key: string, contentType: string): Promise<string | null>;
}

function build(): FileStorage {
  if (env.STORAGE_DRIVER === 'gcs') {
    return new GcsStorage(env.GCS_BUCKET, env.GCS_PROJECT_ID || undefined);
  }
  return new LocalDiskStorage(env.LOCAL_STORAGE_DIR);
}

export const storage: FileStorage = build();
