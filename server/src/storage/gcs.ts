import type { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';
import type { FileStorage } from './index';

/**
 * Stores objects in a Google Cloud Storage bucket. In Cloud Run this uses the
 * service account's Application Default Credentials — no key file needed.
 */
export class GcsStorage implements FileStorage {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(bucketName: string, projectId?: string) {
    if (!bucketName) throw new Error('GcsStorage requires a bucket name');
    this.bucketName = bucketName;
    this.storage = new Storage(projectId ? { projectId } : {});
  }

  private file(key: string) {
    return this.storage.bucket(this.bucketName).file(key);
  }

  async save(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.file(key).save(data, { contentType, resumable: false });
  }

  createReadStream(key: string): Readable {
    return this.file(key).createReadStream();
  }

  async getBytes(key: string): Promise<Buffer> {
    const [contents] = await this.file(key).download();
    return contents;
  }

  async delete(key: string): Promise<void> {
    await this.file(key)
      .delete({ ignoreNotFound: true })
      .catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.file(key).exists();
    return exists;
  }

  /**
   * V4 signed URL for a direct browser PUT. Uses the runtime SA to sign via the
   * IAM SignBlob API (no key file) — the SA needs `iam.serviceAccounts.signBlob`
   * on itself (roles/iam.serviceAccountTokenCreator). The client must PUT with
   * the same Content-Type that was signed.
   */
  async createUploadUrl(key: string, contentType: string): Promise<string> {
    const [url] = await this.file(key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });
    return url;
  }
}
