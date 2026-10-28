import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const app = new Hono();

app.get("/", async (c) => {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", "/usage", "--output-format", "json"],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  console.log(JSON.stringify({ stdout }));

  return c.json({ message: "Bad request", statusCode: 400 });
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
