# Agent guide

## Working rules

- Read `README.md` and inspect `git status` before changes. Preserve existing work.
- Do only the requested work. Ask when missing requirements affect the result.
- Do not add code comments, tests, or documentation unless the user asks.
- Follow the existing style. Prefer simple code and avoid unnecessary abstractions.
- Do not modify files in `node_modules/` or other dependency directories.
- Use `rg` for local searches. Use Exa for web and code context searches when available.
- Keep replies brief. Use ASD-STE100 Simplified Technical English for technical prose.
- Do not use emojis or em dashes.

## Project structure

| Path | Purpose |
| --- | --- |
| `frontend/` | Vue 3 and Vite application, written in JavaScript |
| `backend/` | Go HTTP API, SQLite storage, and sample data |
| `integrations/pi/` | TypeScript Pi extension and persistent trace queue |
| `docs/screenshots/` | README images with sample data |
| `work/` | Ignored temporary files and integration fixtures |

Use the project name `elune`. Keep the default dark theme and custom lunar symbol.

## Commands

Requirements: Go 1.25+, Node.js 22.19+, npm, and Make. Run these commands from the repository root.

| Task | Command |
| --- | --- |
| Build both applications | `make build` |
| Build and start the app | `make run` |
| Start frontend development | `npm --prefix frontend run dev` |
| Check the frontend | `npm --prefix frontend test` |
| Build the frontend | `npm --prefix frontend run build` |
| Check the backend | `(cd backend && go test -race ./... && go vet ./...)` |
| Check the Pi extension | `npm --prefix integrations/pi test` |

`make run` installs frontend dependencies, builds both applications, and starts the backend from `backend/`.
The app uses `http://127.0.0.1:8080`. Frontend development uses port 5173 and requires the backend.

Run existing checks that cover the changed code. Format changed Go files with `gofmt`.
Report failed or skipped checks. Do not run application tests for prose-only changes.

Run the real Pi integration check when the user requests it:

```sh
PI_TRACE_URL='http://127.0.0.1:<test-port>' npm --prefix integrations/pi run test:integration
```

Replace `<test-port>` with a separate backend port. Store its database under `work/` and set `DATA_PATH` explicitly.
This check makes model requests, can incur charges, and adds traces. Do not use the user's active database.

## Data and privacy

- Keep the loopback binding and local Host/Origin checks. The app has no authentication or built-in encryption.
- Keep SQLite WAL mode, transactions, and private file permissions.
- Preserve existing traces during migration. Keep the original JSON file after its one-time import.
- Preserve trace revisions, scores, and bookmarks during Pi updates. Publish live events only after a successful commit.
- Keep filtering and pagination in the backend. Preserve Unicode search, decoded tag search, and complete trace names.
- Use sample data for tests, screenshots, and examples. Trace content can include secrets and private file paths.
- Never commit databases, trace queues, credentials, exports, or real Pi sessions.
- `backend/data/` and `work/` are ignored. Check exclusions for custom database and queue paths before staging files.

## Version control

- The default branch is `master`.
- Keep commits atomic. Use brief, single-line Conventional Commit messages.
- Commit and push only when requested. Do not rewrite published history unless requested.
- Keep both Apache 2.0 license files and package license metadata consistent.
