// SPDX-License-Identifier: Apache-2.0
//
// S3DocumentSink — the optional, env-switched sibling of FsDocumentSink and
// the MIGRATION REFERENCE: the same accept() semantics against any
// S3-compatible endpoint (AWS S3, MinIO, R2, Ceph RGW …). This is where an
// object-storage client lives in the demo — the library packages ship none,
// on purpose: bytes cross DocumentSink.accept() and object storage is a
// host decision.
//
// Same behavior as the fs sink, translated to object keys:
//   * bytes    → ingested/<tenant>/<connection>/<remotePath>/<filename>
//   * sidecar  → the same key + '.txt' (extracted plain text)
//   * manifest → manifest/<documentId>/<epoch-ms>.json — one object per
//     accept() (S3 has no append; a per-accept object IS the append-only
//     manifest), full DocumentMeta + outcome, failures and deferrals
//     included.
//
// Contract points carried over:
//   * Unparseable types → {status:'failed'} honestly, nothing stored but
//     the manifest object.
//   * DEMO_DEFER_OVER_MB → {status:'deferred'} on first pass, accepted on
//     the isRetry re-submission.
//   * No-duplicate retry: keys are DETERMINISTIC per document, so a retry
//     overwrites in place. Known limitation vs the fs sink (documented,
//     not hidden): if a file MOVED remotely between attempts, the old key
//     is not garbage-collected — doing that portably needs a state store,
//     which is exactly the kind of thing a real host has and a demo
//     shouldn't fake. The manifest records both locations.
//
// Enable with DEMO_SINK=s3. Endpoint/credentials use the standard AWS SDK
// env chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION), plus:
//   S3_BUCKET       (required)
//   S3_ENDPOINT     (optional — set for MinIO/R2/…; forces path-style)
//   S3_PREFIX       (optional key prefix, default '')
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DocumentMeta, DocumentSink, SinkOutcome } from '@shelfmark/core';
import { extractText } from './extractText.js';
import { safeSegment } from './fsSink.js';

export interface S3SinkOptions {
  client: S3Client;
  bucket: string;
  /** Key prefix, '' or 'some/prefix/' (trailing slash added if missing). */
  prefix?: string;
  deferOverBytes?: number | null;
}

export class S3DocumentSink implements DocumentSink {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly deferOverBytes: number | null;

  constructor(options: S3SinkOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    const p = options.prefix ?? '';
    this.prefix = p === '' || p.endsWith('/') ? p : `${p}/`;
    this.deferOverBytes = options.deferOverBytes ?? null;
  }

  async accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome> {
    if (this.deferOverBytes !== null && content.length > this.deferOverBytes && !meta.isRetry) {
      const outcome: SinkOutcome = {
        status: 'deferred',
        reason: `demo defer threshold: ${content.length} bytes > ${this.deferOverBytes} (DEMO_DEFER_OVER_MB); re-submit with isRetry`,
      };
      await this.putManifest(meta, outcome);
      return outcome;
    }

    const extracted = await extractText(meta.mimetype, content);
    if (!extracted.ok) {
      const outcome: SinkOutcome = { status: 'failed', error: extracted.error };
      await this.putManifest(meta, outcome);
      return outcome;
    }

    const key = this.bytesKey(meta);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentType: meta.mimetype,
        })
      );
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${key}.txt`,
          Body: extracted.text,
          ContentType: 'text/plain; charset=utf-8',
        })
      );
    } catch (err) {
      const outcome: SinkOutcome = {
        status: 'failed',
        error: `s3 put failed: ${(err as Error).message}`,
      };
      await this.putManifest(meta, outcome).catch(() => undefined);
      return outcome;
    }

    const outcome: SinkOutcome = { status: 'ingested' };
    await this.putManifest(meta, outcome);
    return outcome;
  }

  /** Deterministic per-document key — the overwrite-on-retry contract. */
  private bytesKey(meta: DocumentMeta): string {
    const segments = meta.remotePath
      .split('/')
      .filter((s) => s !== '')
      .map(safeSegment);
    return [
      `${this.prefix}ingested`,
      safeSegment(meta.tenantId),
      safeSegment(meta.connectionId),
      ...segments,
      safeSegment(meta.filename),
    ].join('/');
  }

  private async putManifest(meta: DocumentMeta, outcome: SinkOutcome): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}manifest/${safeSegment(meta.documentId)}/${Date.now()}.json`,
        Body: JSON.stringify({ at: new Date().toISOString(), meta, outcome }),
        ContentType: 'application/json',
      })
    );
  }
}

/** Build the sink from env (DEMO_SINK=s3 path). Fails fast, named. */
export function s3SinkFromEnv(options: { deferOverBytes: number | null }): S3DocumentSink {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) {
    // Mirrors DemoConfigError semantics without a circular import.
    const err = new Error('Missing required env var S3_BUCKET — required when DEMO_SINK=s3 (see demo/.env.example)');
    err.name = 'DemoConfigError';
    throw err;
  }
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const client = new S3Client({
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    region: process.env.AWS_REGION?.trim() || 'us-east-1',
  });
  return new S3DocumentSink({
    client,
    bucket,
    prefix: process.env.S3_PREFIX?.trim() || '',
    deferOverBytes: options.deferOverBytes,
  });
}
