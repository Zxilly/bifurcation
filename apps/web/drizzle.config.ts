import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.BIFURCATION_DATABASE_PATH ?? "./data/bifurcation.sqlite" },
});
