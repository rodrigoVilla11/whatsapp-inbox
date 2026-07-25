import type { MediaStorage } from '../../src/media/media-storage';

/** MediaStorage in-memory: cuenta puts y registra deletes para asserts. */
export class FakeMediaStorage implements MediaStorage {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  putCount = 0;
  deletedKeys: string[] = [];

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.putCount += 1;
    this.objects.set(key, { body, contentType });
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
      this.deletedKeys.push(key);
    }
  }

  async getPresignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return `https://fake-r2.local/${key}?signed=1&ttl=${ttlSeconds}`;
  }
}
