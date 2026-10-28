import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exec } from "node:child_process";

const app = new Hono();

app.get("/", (c) => {
  const data = exec("claude -p '/usage' --output-format json");
  console.log(JSON.stringify({ data }));

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
