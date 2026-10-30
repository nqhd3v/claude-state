Reads Claude plan usage and pushes it to Workdesk. Calls the endpoint behind
Claude Code's `/usage` screen directly, so no tokens are spent.

```
npm install
npm run dev
```

```
open http://localhost:3001/status
```

- `GET /status`: current usage
- `POST /sync`: push usage to Workdesk (`scripts/setup-cron.sh` schedules this)

Needs `API_URL`, `API_KEY` and optional `PORT` in `.env`.

Needs `~/.claude/.credentials.json`, so run `claude` and `/login` once on the
host. The token is refreshed and saved back to that file when it expires. Linux
only: macOS keeps it in the Keychain. Log in separately per device, because
refresh tokens rotate and one device's refresh cancels the other's.
