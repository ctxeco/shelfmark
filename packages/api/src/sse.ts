// SPDX-License-Identifier: Apache-2.0
// Framework-neutral SSE transport over a raw ServerResponse.
//
// The map route hijacks the reply and drives the raw response, and everything
// this module does exists because of production streaming history:
//
//   * PER-FRAME BYTE CAP. One oversized SSE frame can reproduce a documented
//     proxy-cutoff failure mode (an earlier streaming surface paid for this
//     lesson): the proxy buffers, stalls, and severs the stream. So every
//     frame is measured before it is written, and a frame that busts the cap
//     is REPORTED to the caller (who logs it loudly), never written and never
//     silently shrunk here — degradation policy is the caller's, because only
//     the caller knows which fields a frame can honestly shed.
//
//   * COMMENT-FRAME HEARTBEATS. An SSE comment (`: hb`) is ignored by
//     EventSource but keeps proxies from cutting an idle-looking stream. A
//     stream can legitimately go quiet for longer than a proxy idle timeout
//     while a walk grinds through a huge folder.
//
//   * CLOSED IS CLOSED. Once the client disconnects or the stream ends,
//     every write becomes a no-op — a poll loop that lost its client must
//     not crash the process writing to a dead socket.
//
// The sink is stated structurally (setHeader/write/end) so the module is
// framework-neutral: Node's ServerResponse satisfies it, and so does any
// test double.

/** The slice of a ServerResponse this transport needs. */
export interface SseSink {
  setHeader(name: string, value: string): void;
  write(chunk: string): unknown;
  end(): void;
}

export interface SseStreamOptions {
  /** Idle threshold before a comment heartbeat. 0 means always due. */
  heartbeatMs: number;
  /** Per-frame byte cap. */
  maxFrameBytes: number;
  /** Called when a frame was dropped for busting the cap — log this loudly. */
  onFrameDropped?: (info: { bytes: number; type: string }) => void;
}

export interface SseStream {
  readonly closed: boolean;
  /** Write one `data:` frame unless it busts the cap. Returns false if dropped or closed. */
  writeFrame(payload: Record<string, unknown>): boolean;
  /** Write a comment heartbeat if the stream has been idle past the threshold. */
  heartbeatIfDue(): void;
  /** End the stream (idempotent). */
  end(): void;
  /** Mark the stream closed WITHOUT touching the sink — the client hung up. */
  abandon(): void;
}

export function openSseStream(sink: SseSink, options: SseStreamOptions): SseStream {
  sink.setHeader('Content-Type', 'text/event-stream');
  sink.setHeader('Cache-Control', 'no-cache');
  sink.setHeader('Connection', 'keep-alive');

  let closed = false;
  let lastWriteAt = Date.now();

  return {
    get closed(): boolean {
      return closed;
    },
    writeFrame(payload: Record<string, unknown>): boolean {
      if (closed) return false;
      const frame = JSON.stringify(payload);
      const bytes = Buffer.byteLength(frame);
      if (bytes > options.maxFrameBytes) {
        options.onFrameDropped?.({ bytes, type: String(payload.type) });
        return false;
      }
      sink.write(`data: ${frame}\n\n`);
      lastWriteAt = Date.now();
      return true;
    },
    heartbeatIfDue(): void {
      if (closed) return;
      if (Date.now() - lastWriteAt >= options.heartbeatMs) {
        sink.write(`: hb\n\n`);
        lastWriteAt = Date.now();
      }
    },
    end(): void {
      if (closed) return;
      closed = true;
      sink.end();
    },
    abandon(): void {
      closed = true;
    },
  };
}
