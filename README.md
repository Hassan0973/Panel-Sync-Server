# Panel Sync – Render test server

This is a temporary, memory-only HTTP API for sharing solar panel coordinates and timer end timestamps between test clients. It does **not** change the supplied Lua game script by itself. A separate supported HTTP client integration is required.

## Render deployment
Upload the files to a private GitHub repository. On Render choose **New > Blueprint** and select the repository containing `render.yaml`. The Render Blueprint creates a free web service and generates a shared secret in the `TEAM_KEY` environment variable. Your Lua client(s) must include the same secret in the `x-team-key` header. Do not publish your key or put the Lua cheat script in a public repository.

## Routes
- `GET /health` — public health check.
- `GET /panels` — authenticated list of known panels.
- `POST /panels` — authenticated JSON body `{"panel":{"x":1,"y":2,"z":3,"finishAt":1790000000000,"repairs":0}}`.
- `POST /panels/remove` — authenticated JSON body `{"id":"1:2:3"}`.
- `DELETE /panels` — authenticated reset at the start of a new Grand RP server cycle.

Protected endpoints require the header `x-team-key: <TEAM_KEY>`.

Panel keys are deduplicated by approximate 0.5 m position. `finishAt` is optional Unix time in milliseconds. Records are held **only in RAM**, so restarting / sleeping the Render instance can erase all records. This package is a test backend, not a ready-to-use game integration. Requires client HTTP access for automatic syncing.
