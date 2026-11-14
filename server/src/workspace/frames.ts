// Newline-delimited JSON frames for the runtime socket. JSON.stringify never emits a raw newline, so a newline always
// ends a frame. A frame larger than the limit, or one that is not JSON, is a protocol violation: the reader reports it
// once and ignores everything after it, and the caller tears the channel down.

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type FrameError = 'FRAME_TOO_LARGE' | 'FRAME_INVALID';

export const encodeFrame = (message: unknown) => JSON.stringify(message) + '\n';

export function frameReader(
  maxBytes: number,
  onFrame: (value: unknown) => void,
  onError: (error: FrameError) => void,
) {
  let parts: Buffer[] = [];
  let size = 0;
  let failed = false;
  const fail = (error: FrameError) => {
    failed = true;
    parts = [];
    onError(error);
  };
  return (chunk: Buffer) => {
    let rest = chunk;
    while (!failed && rest.length) {
      const at = rest.indexOf(0x0a);
      const piece = at < 0 ? rest : rest.subarray(0, at);
      if (size + piece.length > maxBytes) return fail('FRAME_TOO_LARGE');
      if (at < 0) {
        parts.push(piece);
        size += piece.length;
        return;
      }
      const line = Buffer.concat([...parts, piece]).toString('utf8');
      parts = [];
      size = 0;
      rest = rest.subarray(at + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return fail('FRAME_INVALID');
      }
      onFrame(value);
    }
  };
}
