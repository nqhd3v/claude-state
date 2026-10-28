import { serve } from "@hono/node-server";
import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.loadEnvFile();

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const execFileAsync = promisify(execFile);

type ClaudeResult = {
  is_error: boolean;
  result: string;
};

type Status = {
  session: number;
  week: number;
  time: number;
  weekResetIn: number; // hours until reset, e.g. 2.5
  sessionResetIn?: number;
};

type UsageLine = {
  percent: number;
  resetAt?: Dayjs;
};

async function runUsage(): Promise<ClaudeResult> {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", "/usage", "--output-format", "json"],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as ClaudeResult;
}

// Parses e.g. "Oct 28, 2:19pm", "Oct 28, 2pm" or "2:19pm" as wall-clock time in
// `zone`. The year is not printed, so pick the next occurrence that is not in the past.
function parseReset(text: string, zone: string, now: Dayjs): Dayjs | undefined {
  const today = now.tz(zone);
  const hasDate = /^[A-Za-z]/.test(text);
  const dated = hasDate ? text : `${today.format("MMM D")}, ${text}`;
  const format = dated.includes(":") ? "YYYY MMM D, h:mma" : "YYYY MMM D, ha";

  let resetAt = dayjs.tz(`${today.year()} ${dated}`, format, zone);
  if (!resetAt.isValid()) return undefined;

  if (!hasDate && resetAt.isBefore(now)) resetAt = resetAt.add(1, "day");
  if (hasDate && resetAt.isBefore(now.subtract(1, "day")))
    resetAt = resetAt.add(1, "year");
  return resetAt;
}

// Hours from `now` until `resetAt`, rounded to 2 decimals.
function hoursUntil(resetAt: Dayjs, now: Dayjs): number {
  const hours = Math.max(0, resetAt.diff(now, "hour", true));
  return Math.round(hours * 100) / 100;
}

// Matches e.g. "Current week (all models): 23% used · resets Oct 29, 4:59pm (Asia/Ho_Chi_Minh)"
function parseLine(text: string, label: string, now: Dayjs): UsageLine | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `^\\s*${escaped}:\\s*(\\d+(?:\\.\\d+)?)% used(?:\\s*·\\s*resets\\s+(.+?)(?:\\s+\\(([^)]+)\\))?)?\\s*$`,
      "m",
    ),
  );
  if (!match) return null;
  const [, percent, resets, timeZone] = match;
  const zone = timeZone ?? dayjs.tz.guess();
  return {
    percent: Number(percent),
    resetAt: resets ? parseReset(resets, zone, now) : undefined,
  };
}

type Usage = {
  now: Dayjs;
  session: UsageLine;
  week: UsageLine & { resetAt: Dayjs };
};

class UsageError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

async function getUsage(): Promise<Usage> {
  const usage = await runUsage();
  if (usage.is_error)
    throw new UsageError("claude returned an error", usage.result);

  const now = dayjs();
  const session = parseLine(usage.result, "Current session", now);
  const week = parseLine(usage.result, "Current week (all models)", now);
  if (!session || !week || week.resetAt === undefined) {
    throw new UsageError("could not parse usage", usage.result);
  }
  return { now, session, week: { ...week, resetAt: week.resetAt } };
}

// POST /api/usage-state on Workdesk, see workdesk/docs/api.md.
async function pushUsageState(
  usage: Usage,
): Promise<{ status: number; body: unknown }> {
  const { API_URL, API_KEY } = process.env;
  if (!API_URL || !API_KEY)
    throw new Error("API_URL and API_KEY must be set in .env");

  const payload = {
    name: "claude",
    measured_at: usage.now.unix(),
    session: {
      used_pct: usage.session.percent,
      resets_at: usage.session.resetAt?.unix() ?? null,
    },
    week: {
      used_pct: usage.week.percent,
      resets_at: usage.week.resetAt.unix(),
    },
  };

  const res = await fetch(new URL("/api/usage-state", API_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workdesk-key": API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function errorResponse(err: unknown) {
  if (err instanceof UsageError)
    return {
      body: { error: err.message, detail: err.detail },
      status: 502 as const,
    };
  const e = err as { message: string; stderr?: string };
  return { body: { error: e.message, stderr: e.stderr }, status: 500 as const };
}

const app = new Hono();

app.get("/status", async (c) => {
  try {
    const { now, session, week } = await getUsage();
    const status: Status = {
      session: session.percent,
      week: week.percent,
      time: now.valueOf(),
      weekResetIn: hoursUntil(week.resetAt, now),
    };
    if (session.resetAt !== undefined) {
      status.sessionResetIn = hoursUntil(session.resetAt, now);
    }

    return c.json(status);
  } catch (err) {
    const { body, status } = errorResponse(err);
    return c.json(body, status);
  }
});

app.post("/sync", async (c) => {
  try {
    const usage = await getUsage();
    const { status, body } = await pushUsageState(usage);
    if (status !== 201) {
      console.error(`sync failed: ${status} ${JSON.stringify(body)}`);
      return c.json(
        { error: "workdesk rejected usage state", status, body },
        502,
      );
    }
    return c.json({
      synced: true,
      server_time: (body as { server_time?: number } | null)?.server_time,
    });
  } catch (err) {
    const { body, status } = errorResponse(err);
    console.error(`sync failed: ${JSON.stringify(body)}`);
    return c.json(body, status);
  }
});

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
    port: Number(process.env.PORT ?? 3000),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
