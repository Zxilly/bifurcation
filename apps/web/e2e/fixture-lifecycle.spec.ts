import { once } from "node:events";
import { connect } from "node:net";
import { test, expect } from "./fixtures";

test.use({ initializeAdmin: false });

test("browser connections close before the application shuts down", async ({ page, app }) => {
  // Reproduce a speculative TCP connection without sending an HTTP request.
  // Its lifetime follows the browser context, so Linux's graceful server exit
  // cannot complete if the app fixture is torn down before that context.
  const connection = connect({
    host: "127.0.0.1",
    port: Number(new URL(app.origin).port),
  });
  connection.on("error", () => connection.destroy());
  page.context().once("close", () => connection.destroy());
  await once(connection, "connect");
  expect(connection.readyState).toBe("open");
});
