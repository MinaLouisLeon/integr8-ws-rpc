import { RpcError } from './rpcError.js';

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RpcError('INVALID_OPTION');
  }
}

/** Measure an encoded socket frame without stringifying arbitrary peer data. */
export function assertMessageSize(message: unknown, maxBytes: number): number {
  validateLimit(maxBytes);
  let bytes: number;
  if (typeof message === 'string') {
    // UTF-8 uses at least one byte per UTF-16 code unit, including replacement of lone surrogates.
    // Reject clearly oversized strings before allocating an encoding buffer.
    if (message.length > maxBytes) {
      throw new RpcError('PAYLOAD_TOO_LARGE');
    }
    bytes = new TextEncoder().encode(message).byteLength;
  } else if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
    bytes = message.byteLength;
  } else if (message instanceof Blob) {
    bytes = message.size;
  } else {
    throw new RpcError('INVALID_MESSAGE');
  }
  if (bytes > maxBytes) {
    throw new RpcError('PAYLOAD_TOO_LARGE');
  }
  return bytes;
}

/** Check the encoded next send before adding it to the platform socket's queue. */
export function assertSendCapacity(
  bufferedBytes: number,
  nextBytes: number,
  maxBytes: number,
): void {
  validateLimit(maxBytes);
  if (
    !Number.isSafeInteger(bufferedBytes) ||
    bufferedBytes < 0 ||
    !Number.isSafeInteger(nextBytes) ||
    nextBytes < 0
  ) {
    throw new RpcError('INVALID_MESSAGE');
  }
  // Subtraction avoids overflow in bufferedBytes + nextBytes.
  if (nextBytes > maxBytes || bufferedBytes > maxBytes - nextBytes) {
    throw new RpcError('BACKPRESSURE');
  }
}
