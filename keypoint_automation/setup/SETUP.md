# Hackathon BigQuery Setup — Claude Code + MCP

This guide gets your team access to the `datamart-hackathon` BigQuery project from within Claude Code using the BigQuery MCP server.

## Prerequisites

- **Claude Code** installed ([install guide](https://docs.anthropic.com/en/docs/claude-code/overview))
- **Node.js ≥ 18** with `npx` on your PATH ([install via nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org))
- **Your team's service account key** (a `.json` file — ask the hackathon organizer if you don't have it)

> **No `gcloud` CLI required.** The MCP server authenticates directly with the service account key file.

## Team → Service Account Mapping

Each team has a dedicated service account. Use **only your team's key**.

| Team                  | Key Filename                       |
|-----------------------|------------------------------------|
| Provider CRM          | `hackathon-provider-crm.json`      |
| SMS Module            | `hackathon-sms-module.json`        |
| Logic Engine / Maestro| `hackathon-logic-maestro.json`     |
| Call Doc Five9        | `hackathon-call-doc-five9.json`    |
| Smart Call Queue      | `hackathon-smart-call-queue.json`  |
| Escalation Handling   | `hackathon-escalation.json`        |
| Template Automation   | `hackathon-template-auto.json`     |

All accounts have `BigQuery Data Viewer` access to the `datamart-hackathon` project.

---

## Step 1: Save your key file

Place your team's `.json` key file somewhere stable on your machine. We recommend:

```
~/.config/gcp/hackathon-key.json
```

```bash
mkdir -p ~/.config/gcp
cp /path/to/your-team-key.json ~/.config/gcp/hackathon-key.json
```

> **Keep this file secure.** Do not commit it to any repo or share it outside your team.

## Step 2: Add the MCP server to Claude Code

Open your Claude Code config file at `~/.claude.json` in a text editor.

Find (or create) the `"projects"` section with a key matching your working directory. Inside it, add or update `"mcpServers"` as follows:

```json
{
  "projects": {
    "/Users/YOUR_USERNAME": {
      "mcpServers": {
        "bigquery": {
          "command": "npx",
          "args": [
            "-y",
            "@channel.io/bigquery-mcp"
          ],
          "env": {
            "BIGQUERY_PROJECT_ID": "datamart-hackathon",
            "GOOGLE_APPLICATION_CREDENTIALS": "/Users/YOUR_USERNAME/.config/gcp/hackathon-key.json"
          }
        }
      }
    }
  }
}
```

**Important:** Replace both instances of `YOUR_USERNAME` with your actual macOS username. The `GOOGLE_APPLICATION_CREDENTIALS` path must be **absolute** (no `~`).

> **Tip:** If you already have other entries under `"projects"` or `"mcpServers"`, merge this in — don't overwrite the whole file. If you're unsure, ask Claude Code to help: just say _"add the bigquery MCP server to my config"_ and paste the block above.

### Linux users

Same steps — just adjust the path prefix (e.g., `/home/YOUR_USERNAME/.config/gcp/hackathon-key.json`).

### Windows users

Use forward slashes or escaped backslashes in the path:
```
"GOOGLE_APPLICATION_CREDENTIALS": "C:/Users/YOUR_USERNAME/.config/gcp/hackathon-key.json"
```

## Step 3: Restart Claude Code

MCP servers are loaded at startup. After editing `~/.claude.json`, fully quit and relaunch Claude Code.

## Step 4: Verify the connection

Once Claude Code is running, check that the MCP server connected:

```
/mcp
```

You should see `bigquery` listed with a green status. If it shows an error, double-check:
1. The key file path is correct and absolute
2. Node.js / `npx` is installed and on your PATH
3. You restarted Claude Code after editing the config

Then test with a query:

```
List the tables in the patient_demographics dataset
```

Claude should return:
- `patient_contact_di`
- `patient_info_di`
- `patient_providers_di`

---

## Available Datasets & Tables

**Project:** `datamart-hackathon`

### `patient_demographics`
| Table | Description |
|---|---|
| `patient_info_di` | Patient details: customer, onboarding date, LOB, scanner type, etc. |
| `patient_contact_di` | Patient contact information |
| `patient_providers_di` | Patient-provider relationships |

You can explore schemas by asking Claude: _"Show me the schema for patient_info_di"_

---

## Querying Tips

Once connected, you can ask Claude to query BigQuery conversationally:

- _"How many patients are in patient_info_di?"_
- _"Show me the distribution of customers in patient_info_di"_
- _"Join patient_info_di with patient_providers_di on patient_id and show me the first 10 rows"_

Claude will write and execute the SQL for you. You can also provide raw SQL:

- _"Run this query: SELECT customer, COUNT(*) FROM \`datamart-hackathon.patient_demographics.patient_info_di\` GROUP BY customer"_

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `bigquery` not showing in `/mcp` | Restart Claude Code after editing `~/.claude.json` |
| MCP shows red/error status | Run `npx -y @channel.io/bigquery-mcp` in your terminal to see the actual error |
| "Permission denied" on queries | Confirm you're using the correct key file for your team |
| `npx: command not found` | Install Node.js (v18+): `brew install node` or use [nvm](https://github.com/nvm-sh/nvm) |
| Key file path errors | Make sure the path is absolute — no `~` or `$HOME`, use the full `/Users/...` path |
| Queries return empty results | Check that you're querying `datamart-hackathon` (this is set by `BIGQUERY_PROJECT_ID`) |

---

## Security Reminders

- **Do not** commit your key file to git
- **Do not** share keys across teams — each team has its own for audit purposes
- Keys will be **revoked** after the hackathon
- Add `*.json` to your `.gitignore` if your key is anywhere near a repo
