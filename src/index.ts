import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

process.loadEnvFile();

// Same endpoint Claude Code's /usage screen reads. No model call, so no tokens
// are spent. Internal and undocumented: it can change without notice.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code's public OAuth client

// Written by `claude` login on Linux. macOS keeps it in the Keychain instead.
const CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS ??
  join(homedir(), ".claude", ".credentials.json");

type OAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes?: string[];
};

type Credentials = { claudeAiOauth?: OAuth };

type UsageWindow = {
  utilization?: number | null;
  resets_at?: string | null;
};

type UsageResponse = {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
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
  resetAt?: number; // unix seconds
};

type Usage = {
  now: number; // epoch ms
  session: UsageLine;
  week: UsageLine & { resetAt: number };
};

class UsageError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

async function refreshAccessToken(creds: Credentials, oauth: OAuth) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      ...(oauth.scopes && { scope: oauth.scopes.join(" ") }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new UsageError(
      `token refresh returned ${res.status}`,
      await res.text(),
    );

  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  oauth.accessToken = token.access_token;
  // Refresh tokens rotate: persist the new one or the next refresh fails.
  oauth.refreshToken = token.refresh_token ?? oauth.refreshToken;
  oauth.expiresAt = Date.now() + token.expires_in * 1000;

  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(creds), { mode: 0o600 });
  await rename(tmp, CREDENTIALS_PATH);
  return oauth.accessToken;
}

// /status and /sync can overlap. A second refresh would replay the rotated token.
let refreshing: Promise<string> | undefined;

async function getAccessToken(): Promise<string> {
  const creds = JSON.parse(
    await readFile(CREDENTIALS_PATH, "utf8"),
  ) as Credentials;
  const oauth = creds.claudeAiOauth;
  if (!oauth)
    throw new UsageError("not logged in", `no OAuth in ${CREDENTIALS_PATH}`);

  // Refresh a minute early.
  if (oauth.expiresAt > Date.now() + 60_000) return oauth.accessToken;

  refreshing ??= refreshAccessToken(creds, oauth).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

function unixSeconds(iso?: string | null): number | undefined {
  return iso ? Math.floor(Date.parse(iso) / 1000) : undefined;
}

// Hours from `now` (epoch ms) until `resetAt` (unix seconds), rounded to 2 decimals.
function hoursUntil(resetAt: number, now: number): number {
  const hours = Math.max(0, (resetAt * 1000 - now) / 3_600_000);
  return Math.round(hours * 100) / 100;
}

async function getUsage(): Promise<Usage> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new UsageError(`usage endpoint returned ${res.status}`, text);

  const usage = JSON.parse(text) as UsageResponse;
  const weekResetAt = unixSeconds(usage.seven_day?.resets_at);
  if (weekResetAt === undefined)
    throw new UsageError("could not parse usage", text);

  return {
    now: Date.now(),
    session: {
      percent: usage.five_hour?.utilization ?? 0,
      resetAt: unixSeconds(usage.five_hour?.resets_at),
    },
    week: {
      percent: usage.seven_day?.utilization ?? 0,
      resetAt: weekResetAt,
    },
  };
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
    measured_at: Math.floor(usage.now / 1000),
    session: {
      used_pct: usage.session.percent,
      resets_at: usage.session.resetAt ?? null,
    },
    week: {
      used_pct: usage.week.percent,
      resets_at: usage.week.resetAt,
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
  return { body: { error: (err as Error).message }, status: 500 as const };
}

const app = new Hono();

app.get("/status", async (c) => {
  try {
    const { now, session, week } = await getUsage();
    const status: Status = {
      session: session.percent,
      week: week.percent,
      time: now,
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

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
