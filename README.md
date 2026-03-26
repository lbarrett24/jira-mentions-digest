# Jira Mentions Digest

Runs daily at 4:00 PM PST. Fetches all Jira comments where you've been mentioned in the last 24 hours, generates an AI-suggested reply for each using Claude, and sends you a formatted Slack DM.

---

## Prerequisites

- Node.js 18+ (zero npm dependencies — uses built-in `https` module only)
- A Jira API token
- An Anthropic API key
- A Slack bot token

---

## Setup

### 1. Clone / copy this folder

Place the `jira-mentions-digest/` folder somewhere stable on your Mac, e.g.:

```
~/scripts/jira-mentions-digest/
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the four values:

| Variable | Where to get it |
|---|---|
| `JIRA_API_TOKEN` | https://id.atlassian.com/manage-profile/security/api-tokens |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| `SLACK_BOT_TOKEN` | Create a Slack app (see below) |
| `SLACK_USER_ID` | Slack > your profile > ··· menu > Copy member ID |

### 3. Create a Slack App (one-time setup)

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it `Jira Digest Bot`, select your Authorium workspace
3. Go to **OAuth & Permissions** → **Scopes** → add these **Bot Token Scopes**:
   - `chat:write`
   - `im:write`
   - `users:read`
4. Click **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Paste it as `SLACK_BOT_TOKEN` in your `.env`
6. **Important:** Open Slack, find your new bot, and send it a message first (this opens the DM channel)

### 4. Test it manually

```bash
cd ~/scripts/jira-mentions-digest
node -r dotenv/config jira-digest.js
```

> **Note:** The script uses zero npm dependencies for core functionality. However, to load `.env` automatically you can either:
> - Install `dotenv`: `npm init -y && npm install dotenv` — then use `node -r dotenv/config jira-digest.js`
> - Or export the variables manually before running: `export $(cat .env | xargs) && node jira-digest.js`

### 5. Schedule with cron (4:00 PM PST daily)

Open your crontab:

```bash
crontab -e
```

Add this line (PST = UTC-8, so 4 PM PST = midnight UTC):

```cron
0 0 * * * cd /Users/YOUR_USERNAME/scripts/jira-mentions-digest && /usr/local/bin/node -r dotenv/config jira-digest.js >> ~/logs/jira-digest.log 2>&1
```

> **Find your Node path:** Run `which node` in Terminal and use that path.

> **Daylight saving time note:** PST is UTC-8 (Nov–Mar) and PDT is UTC-7 (Mar–Nov). To always hit exactly 4 PM Pacific, use this cron instead which handles both:

```cron
# Runs at 23:00 UTC Nov-Mar (4 PM PST) and 00:00 UTC Mar-Nov (5 PM PDT)
# For strict 4 PM Pacific year-round, consider using a launchd agent (see below)
```

#### Alternative: macOS launchd (more reliable than cron on Mac)

Create `~/Library/LaunchAgents/com.lukebarrett.jiradigest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lukebarrett.jiradigest</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>-r</string>
        <string>dotenv/config</string>
        <string>/Users/YOUR_USERNAME/scripts/jira-mentions-digest/jira-digest.js</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>16</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DOTENV_CONFIG_PATH</key>
        <string>/Users/YOUR_USERNAME/scripts/jira-mentions-digest/.env</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/logs/jira-digest.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/logs/jira-digest-error.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.lukebarrett.jiradigest.plist
```

**launchd uses your Mac's local time zone automatically** — so `Hour: 16` means 4:00 PM in whatever time zone your Mac is set to. ✅

---

## What you'll receive

Each day at 4 PM, you'll get a Slack DM that looks like:

```
🔔 Jira Mentions Digest
Monday, March 16, 2026 · 3 mentions in the last 24 hours
──────────────────────────────────────────────────────
AA-1234 · Add export to CSV on supplier list
In Progress · Priority: High

Garrett said (3/16/26, 2:14 PM):
> @Luke Barrett can you confirm the column order
> for the export spec?

💡 Suggested reply:
The column order should follow the existing table
view: supplier name, category, status, last updated.
I'll add this to the acceptance criteria in the ticket.

[Open in Jira]
──────────────────────────────────────────────────────
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing environment variables` | Double-check your `.env` file values |
| `Jira search failed: 401` | Regenerate your Jira API token |
| `Failed to open Slack DM` | Make sure you've sent a message to the bot in Slack first |
| No mentions showing up | The JQL looks back 24 hours — test by running after being mentioned in a comment |
| Cron not running | Check `~/logs/jira-digest.log`; make sure Node path is correct via `which node` |
