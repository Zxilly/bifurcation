import { z } from "zod";
import { readJson, withApi } from "@/server/http/route";
import { MachineStore } from "@/server/modules/machines/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.object({
  name: z.string().trim().min(1).max(80),
  address: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]-]+$/, "填写域名或 IP 地址"),
  region: z.string().trim().max(80).default(""),
});

export function GET(request: Request) {
  return withApi(request, () => ({ machines: new MachineStore().list() }), {
    admin: true,
  });
}

export function POST(request: Request) {
  return withApi(
    request,
    async () => ({
      machine: new MachineStore().create(input.parse(await readJson(request))),
    }),
    { admin: true },
  );
}
