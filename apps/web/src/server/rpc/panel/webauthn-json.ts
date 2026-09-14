import type { JsonObject } from "@bufbuild/protobuf";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

// WebAuthn options contain optional properties set to undefined. Apply JSON
// omission semantics before encoding them as google.protobuf.Struct values.
export function webauthnOptionsJson(
  options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON,
): JsonObject {
  return JSON.parse(JSON.stringify(options)) as JsonObject;
}
