import { expect, it } from "vitest";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { AuthService, PasskeyOptionsResponseSchema } from "@bifurcation/rpc/panel/auth";
import { ErrorDetailSchema } from "@bifurcation/rpc/panel/types";
import { ApiError } from "@/features/shared/api";
import { panelTransport } from "@/features/shared/rpc";
import { webauthnOptionsJson } from "@/server/rpc/panel/webauthn-json";

it("encodes discoverable Passkey options through the protobuf JSON response", async () => {
  const options = await generateAuthenticationOptions({ rpID: "localhost", userVerification: "required" });
  const response = create(PasskeyOptionsResponseSchema, { flowId: "flow", options: webauthnOptionsJson(options) });
  expect(toJson(PasskeyOptionsResponseSchema, response)).toEqual({ flowId: "flow", options: JSON.parse(JSON.stringify(options)) });
});

it.each(["ARTIFACT_CHANGED", "REAUTH_REQUIRED"])("preserves %s from the real Connect web transport", async (code) => {
  const detail = create(ErrorDetailSchema, { code, requestId: "request-1", fields: { password: { messages: ["required"] } } });
  const client = createClient(AuthService, panelTransport(createConnectTransport({
    baseUrl: "http://localhost/rpc",
    useBinaryFormat: false,
    fetch: async () => new Response(JSON.stringify({ code: "failed_precondition", message: "请重新确认", details: [{ type: ErrorDetailSchema.typeName, value: Buffer.from(toBinary(ErrorDetailSchema, detail)).toString("base64") }] }), { status: 400, headers: { "Content-Type": "application/json" } }),
  })));
  const error = await client.passwordLogin({ username: "test", password: "test" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code, message: "请重新确认", requestId: "request-1", fields: { password: ["required"] } });
});
