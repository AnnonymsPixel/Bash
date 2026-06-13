# BASH — Discord Bot

GitHub push feed + ticket system.

```
bash-bot/
├── bash.js                  ← Entry point, client + slash command registration
├── Functions/
│   ├── fetcher.js           ← GitHub webhook server, multi-repo push embeds
│   └── tickter.js           ← /ticket command, Staff-gated ticket threads
├── .env.example             ← Copy to .env and fill in your secrets
├── package.json
└── README.md
```

---

## Quick Start

```bash
npm install
cp .env.example .env
# Fill in .env — see below
node bash.js
```

---

## .env Reference

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Application (client) ID |
| `STAFF_ROLE_ID` | Role ID that can open/close tickets |
| `WEBHOOK_PORT` | Port the GitHub webhook server listens on (default `3000`) |
| `REPO_N_PATH` | URL path for repo N's webhook e.g. `/hooks/my-repo` |
| `REPO_N_CHANNEL_ID` | Discord channel to post push embeds for repo N |
| `REPO_N_SECRET` | GitHub webhook secret for repo N |

Add as many `REPO_N_*` groups as you need. Increment N each time.

---

## GitHub Webhook Setup

For each repo:

1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL**: `http://your-server-ip:3000/hooks/your-repo-path`
3. **Content type**: `application/json`
4. **Secret**: paste the matching `REPO_N_SECRET` value
5. **Events**: select **Just the push event**

Expose port 3000 (or your `WEBHOOK_PORT`) to the internet. Use a reverse proxy
(nginx / Caddy) + HTTPS in production.

---

## Push Embed Colors

| Event | Color |
|---|---|
| Normal push | 🔵 Blue `#4A90E2` |
| Force push (`--force`) | 🟡 Yellow `#F0B429` |
| Merge commit | 🟢 Green `#2ECC71` |

Author avatar appears as a circle top-left.  
Commit messages are trimmed to ≤ 4 words.  
File list is capped at 3 paths + overflow count.

---

## Ticket System

- Run `/ticket` in a channel → posts a permanent **Open Ticket** panel
- Only members with the `STAFF_ROLE_ID` role can click the button
- Each click creates a **private thread** named `ticket-#0001`, `ticket-#0002`, …
- Ticket IDs are persistent (stored in `Functions/tickets.json`)
- Staff ping is sent automatically inside the thread
- The **Close Ticket** button archives + locks the thread (Staff only)