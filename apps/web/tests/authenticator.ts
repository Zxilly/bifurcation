import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// Minimal CTAP2-style test authenticator. Responses are verified by the real WebAuthn library.
function head(type: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(type << 5) | value]);
  if (value < 256) return Buffer.from([(type << 5) | 24, value]);
  const bytes = Buffer.alloc(3); bytes[0] = (type << 5) | 25; bytes.writeUInt16BE(value, 1); return bytes;
}
function cbor(value: unknown): Buffer {
  if (typeof value === "number") return head(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
  throw new Error("Unsupported test CBOR value");
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();

export function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const idBytes = randomBytes(32);
  const id = idBytes.toString("base64url");
  let counter = 0;
  return {
    id,
    register(challenge: string, origin = "http://localhost:3000") {
      const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
      const length = Buffer.alloc(2); length.writeUInt16BE(idBytes.length);
      const authData = Buffer.concat([digest(new URL(origin).hostname), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, idBytes, cose]);
      const attestationObject = cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id, rawId: id, type: "public-key" as const, clientExtensionResults: {}, response: { attestationObject: attestationObject.toString("base64url"), clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })).toString("base64url"), transports: ["internal"] } };
    },
    authenticate(challenge: string, origin = "http://localhost:3000") {
      const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const authData = Buffer.concat([digest(new URL(origin).hostname), Buffer.from([0x05]), count]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([authData, digest(clientData)]), privateKey);
      return { id, rawId: id, type: "public-key" as const, clientExtensionResults: {}, response: { authenticatorData: authData.toString("base64url"), clientDataJSON: clientData.toString("base64url"), signature: signature.toString("base64url") } };
    },
  };
}
