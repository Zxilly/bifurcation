import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const script = await readFile(
      resolve(process.cwd(), "../../deploy/install.sh"),
      "utf8",
    );
    return new Response(script, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Installer unavailable", error);
    return new Response("Installer unavailable\n", { status: 503 });
  }
}
