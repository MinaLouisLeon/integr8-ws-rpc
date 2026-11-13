import * as z from 'zod';
import { RpcError } from './rpcError.js';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const helloSchema = z.strictObject({
  transportVersion: versionSchema,
  protocolVersions: z.array(versionSchema).min(1).max(8),
  token: z.string(),
});

const helloResponseSchema = z.strictObject({
  transportVersion: versionSchema,
  protocolVersion: versionSchema,
  sessionId: z.string().min(1).max(128),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

/** Internal negotiated reply; credentials/payload data never belong in a client snapshot. */
export interface NegotiatedHello {
  readonly transportVersion: 1;
  readonly protocolVersion: number;
  readonly sessionId: string;
  readonly expiresAt?: number;
}

/** Internal validated hello; never include it in diagnostics or snapshots. */
export interface Hello {
  readonly transportVersion: 1;
  readonly protocolVersions: readonly number[];
  readonly token: string;
}

/** Validate decoded oRPC input before invoking any authentication adapter. */
export function parseHello(input: unknown): Hello {
  let result: ReturnType<typeof helloSchema.safeParse>;
  try {
    result = helloSchema.safeParse(input);
  } catch {
    throw new RpcError('INVALID_MESSAGE');
  }
  if (!result.success) {
    // Zod issues may retain caller input; deliberately do not attach them as a cause.
    throw new RpcError('INVALID_MESSAGE');
  }
  const { transportVersion, protocolVersions, token } = result.data;
  if (transportVersion !== 1) {
    throw new RpcError('PROTOCOL_MISMATCH');
  }
  if (token.length === 0) {
    throw new RpcError('AUTH_FAILED');
  }
  if (token.length > 8192 || new TextEncoder().encode(token).byteLength > 8192) {
    throw new RpcError('PAYLOAD_TOO_LARGE');
  }
  return Object.freeze({
    transportVersion,
    protocolVersions: Object.freeze([...protocolVersions]),
    token,
  });
}

/** Validate caller-owned server version configuration and detach it from subsequent mutation. */
export function validateProtocolVersions(versions: readonly number[]): readonly number[] {
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    !versions.every((version) => Number.isSafeInteger(version) && version > 0)
  ) {
    throw new RpcError('INVALID_OPTION');
  }
  return Object.freeze([...versions]);
}

/** Select the highest mutually supported application version, independent of preference order. */
export function negotiateProtocol(
  offered: readonly number[],
  supported: readonly number[],
): number {
  const allowed = new Set(supported);
  let selected = 0;
  for (const version of offered) {
    if (allowed.has(version) && version > selected) {
      selected = version;
    }
  }
  if (selected === 0) {
    throw new RpcError('PROTOCOL_MISMATCH');
  }
  return selected;
}

/** Validate the upstream-decoded reserved hello reply before a client can become ready. */
export function parseHelloResponse(input: unknown, offered: readonly number[]): NegotiatedHello {
  let result: ReturnType<typeof helloResponseSchema.safeParse>;
  try {
    result = helloResponseSchema.safeParse(input);
  } catch {
    throw new RpcError('INVALID_MESSAGE');
  }
  if (!result.success) {
    throw new RpcError('INVALID_MESSAGE');
  }
  const { transportVersion, protocolVersion, sessionId, expiresAt } = result.data;
  if (transportVersion !== 1 || !offered.includes(protocolVersion)) {
    throw new RpcError('PROTOCOL_MISMATCH');
  }
  return Object.freeze({
    transportVersion,
    protocolVersion,
    sessionId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}
