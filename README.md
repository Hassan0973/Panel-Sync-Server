# ITEM GHOST — Panel Sync Server v2 (PostgreSQL)

## IMPORTANT: back up existing data first

Old Render disk storage may be wiped when the service restarts or redeploys. **Before deploying this v2 server**, pull a full snapshot from the RUNNING old service with the existing secret team key, and save the JSON file to your PC. Do not send the key to anyone or commit it into Git. Do not delete or overwrite the old service/data. A missing old panel cannot be restored if the old service already lost it and no backup exists.

Old service export (from your own computer; replace URL with your existing app URL):

```bash
# Windows PowerShell example: replace placeholders with your actual existing settings.
$headers = @{ 'X-Team-Key' = $env:TEAM_KEY }
Invoke-RestMethod -Uri 'https://YOUR-EXISTING-RENDER-HOST/panels' -Headers $headers | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 old-panels-backup.json
```

Inspect the saved file and check that `panels` contains the expected set before continuing. Do not share the file publicly (it contains positions and bindings). Also back up any existing `panels-data.json` from an attached persistent disk if available.

## Configuration

Keep your EXISTING Render service URL and EXISTING `TEAM_KEY` shared by both Lua clients. Create/attach a persistent PostgreSQL database, set `DATABASE_URL` to its connection string (with SSL settings as appropriate for your provider), and deploy the v2 Node service with `npm install && npm start`. Do not rotate `TEAM_KEY` without updating *both* clients. The service refuses to start without `DATABASE_URL` so it will not silently run on temporary storage. `ALLOW_EPHEMERAL=true` exists only for local tests. `render.yaml` does not provision a paid database automatically; you must connect one and set its URL.

`GET /health` should report `"storage":"POSTGRES / DURABLE","durable":true` after deploying. Your database remains available through app redeploys as long as the provider/plan remains active; take periodic DB backups and ensure the plan's retention/expiry policies suit your needs.

## Old-data migration

Before launching the updated Lua script, restore the saved list into the new server, using the legacy-compatible authenticated `/sync` endpoint with action `restore`. This is **add-only**: panels at positions already stored will NOT be overwritten. Validate the response's `imported` count, then action `pull`, and compare the inventory with your old backup.

Example Python restore snippet (run from your own PC where the backup exists):

```python
import json, os, urllib.request
base = os.environ['PANEL_SYNC_URL'].rstrip('/')
team_key = os.environ['TEAM_KEY']
snapshot = json.load(open('old-panels-backup.json', encoding='utf-8-sig'))
panels = snapshot['panels'] if isinstance(snapshot, dict) else snapshot
assert isinstance(panels, list) and panels, 'Backup is empty: abort!'
body = json.dumps({'key': team_key, 'action': 'restore', 'panels': panels}).encode()
req = urllib.request.Request(base+'/sync', body, {'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(req, timeout=30) as r: print(r.read().decode())
```

Never import an empty snapshot merely because the original server is unreachable; recovery requires the backup. Do not turn on the new clients before checking restored panel count and details.

## Client

Give both players the *same* V35.38 Lua script with the existing team key and URL pointing to your v2 service. Client sync polling checks server revision every 15 seconds and downloads when changed. The local-panel verification check is separate: its default distance is 150m, its default timer 30 minutes (clock minute 00/30), and it only treats absence as verified with positive local streaming evidence. Absence outside streaming visibility is UNKNOWN, not a deletion.

The previous V35.36 optimistic Auto Repair marking remains an assumption on event dispatch, not a verified server repair acknowledgment. Lua syntax validation and local Node HTTP tests do not prove FiveM compatibility; use a test panel with a backup before replacing your active client.
