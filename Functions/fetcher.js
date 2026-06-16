const express  = require("express");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const { EmbedBuilder } = require("discord.js");

// ─── Constants ───────────────────────────────────────────────────────────────

const COLORS = {
  force:  0xF0B429,
  normal: 0x4A90E2,
  merge:  0x2ECC71,
};

const SEEN_FILE = path.join(__dirname, ".seen_commits.json");

// ─── Seen-commit tracking (prevents duplicate embeds on restart) ──────────────

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveSeen(seen) {
  try {
    // Keep only the last 500 SHAs so the file doesn't grow forever
    const trimmed = [...seen].slice(-500);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed), "utf8");
  } catch { /* ignore */ }
}

function markSeen(seen, sha) {
  seen.add(sha);
  saveSeen(seen);
}

// ─── Repo config ─────────────────────────────────────────────────────────────

function loadRepoConfigs() {
  const repos = [];
  let n = 1;
  while (process.env[`REPO_${n}_PATH`]) {
    repos.push({
      path:       process.env[`REPO_${n}_PATH`],
      channelId:  process.env[`REPO_${n}_CHANNEL_ID`],
      secret:     process.env[`REPO_${n}_SECRET`]  || null,
      githubRepo: process.env[`REPO_${n}_GITHUB`]  || null, // e.g. "AnnonymsPixel/TR-web"
    });
    n++;
  }

  if (repos.length === 0) {
    console.warn("[FETCHER] No REPO_N_* env vars found.");
  } else {
    console.log(`[FETCHER] Loaded ${repos.length} repo(s):`);
    repos.forEach((r, i) =>
      console.log(`  [${i + 1}] ${r.path} → channel ${r.channelId} (github: ${r.githubRepo || "none"})`)
    );
  }
  return repos;
}

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(secret, rawBody, sigHeader) {
  if (!secret) return true;
  if (!sigHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

// ─── Embed helpers ────────────────────────────────────────────────────────────

function shortMessage(msg) {
  if (!msg) return "*(no message)*";
  const clean = msg.split("\n")[0].trim();
  const words = clean.split(/\s+/);
  if (words.length <= 4) return clean;
  return words.slice(0, 4).join(" ") + "…";
}

function formatFiles(files) {
  if (!files || files.length === 0) return null;
  const shown = files.slice(0, 3);
  const extra = files.length - shown.length;
  let out = shown.map((f) => `📁 \`${f}\``).join("\n");
  if (extra > 0) out += `\n*+${extra} more*`;
  return out;
}

function collectFiles(commits) {
  const seen = new Set();
  for (const c of commits) {
    for (const f of [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]) {
      seen.add(f);
    }
  }
  return [...seen];
}

function pushType(payload) {
  if (payload.forced) return "force";
  const msg = payload.head_commit?.message?.toLowerCase() || "";
  if (
    msg.startsWith("merge pull request") ||
    msg.startsWith("merge branch") ||
    msg.startsWith("merged") ||
    msg.includes("merged into")
  ) return "merge";
  return "normal";
}

function buildPushEmbed(payload, repoPath) {
  const type     = pushType(payload);
  const color    = COLORS[type];
  const pusher   = payload.pusher?.name || "unknown";
  const repo     = payload.repository;
  const repoUrl  = repo?.html_url || "";
  const repoName = repo?.full_name || repoPath;
  const branch   = (payload.ref || "refs/heads/unknown").replace("refs/heads/", "");

  const commits = (payload.commits && payload.commits.length > 0)
    ? payload.commits
    : (payload.head_commit ? [payload.head_commit] : []);

  const head      = payload.head_commit;
  const avatarUrl = payload.sender?.avatar_url ? `${payload.sender.avatar_url}&size=64` : null;
  const pusherUrl = payload.sender?.html_url || null;

  const badge = type === "force" ? "💥 Force Push"
              : type === "merge" ? "🧬 Merged"
              :                    "🌟 Push";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name:    pusher,
      iconURL: avatarUrl || undefined,
      url:     pusherUrl || undefined,
    })
    .setTitle(`${badge} → ${branch}`)
    .setURL(head?.url || repoUrl)
    .setFooter({ text: repoName });

  if (commits.length > 0) {
    const shown    = commits.slice(0, 3);
    const extra    = commits.length - shown.length;
    const lines    = shown.map((c) => `🔗 ${shortMessage(c.message)}`).join("\n");
    const overflow = extra > 0 ? `\n*+${extra} more*` : "";
    embed.addFields({ name: "Commits", value: lines + overflow });
  }

  const fileBlock = formatFiles(collectFiles(commits));
  if (fileBlock) embed.addFields({ name: "Files", value: fileBlock });

  embed.setTimestamp(head?.timestamp ? new Date(head.timestamp) : new Date());
  return embed;
}

// ─── Discord client ready poller ──────────────────────────────────────────────

function waitForClient(client) {
  return new Promise((resolve) => {
    if (client.isReady()) return resolve();
    const interval = setInterval(() => {
      if (client.isReady()) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

// ─── Catch-up: replay missed pushes from GitHub Events API ───────────────────

async function catchUpMissedPushes(client, repos, seen) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("[FETCHER] GITHUB_TOKEN not set — skipping catch-up.");
    return;
  }

  console.log("[FETCHER] Running catch-up check for missed pushes...");

  for (const repo of repos) {
    if (!repo.githubRepo) continue;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo.githubRepo}/events?per_page=30`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Bash-Bot" } }
      );

      if (!res.ok) {
        console.warn(`[FETCHER] GitHub API returned ${res.status} for ${repo.githubRepo}`);
        continue;
      }

      const events = await res.json();
      const pushes = events
        .filter((e) => e.type === "PushEvent")
        .reverse(); // oldest first so Discord order is chronological

      let sent = 0;
      for (const event of pushes) {
        const commits = event.payload.commits || [];
        const headCommit = commits.at(-1) || null;
        const sha = headCommit?.sha || event.id;

        // Skip if we've already sent this commit
        if (seen.has(sha)) continue;

        // Build a webhook-like payload from the Events API shape
        const payload = {
          ref:     event.payload.ref,
          forced:  false,
          commits: commits.map((c) => ({
            id:       c.sha,
            message:  c.message,
            url:      `https://github.com/${repo.githubRepo}/commit/${c.sha}`,
            added:    [],
            modified: [],
            removed:  [],
          })),
          head_commit: headCommit ? {
            id:        headCommit.sha,
            message:   headCommit.message,
            url:       `https://github.com/${repo.githubRepo}/commit/${headCommit.sha}`,
            timestamp: event.created_at,
          } : null,
          pusher:     { name: event.actor.login },
          sender:     {
            avatar_url: event.actor.avatar_url,
            html_url:   `https://github.com/${event.actor.login}`,
          },
          repository: {
            full_name: repo.githubRepo,
            html_url:  `https://github.com/${repo.githubRepo}`,
          },
        };

        try {
          const channel = await client.channels.fetch(repo.channelId);
          if (!channel?.isTextBased()) continue;
          await channel.send({ embeds: [buildPushEmbed(payload, repo.path)] });
          markSeen(seen, sha);
          sent++;
          console.log(`[FETCHER] Catch-up embed sent: ${sha} → ${repo.githubRepo}`);
        } catch (err) {
          console.error(`[FETCHER] Failed to send catch-up embed:`, err.message);
        }
      }

      if (sent === 0) {
        console.log(`[FETCHER] No missed pushes for ${repo.githubRepo}`);
      }
    } catch (err) {
      console.error(`[FETCHER] Catch-up error for ${repo.githubRepo}:`, err.message);
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

function startWebhookServer(client) {
  const app   = express();
  const PORT  = process.env.PORT || process.env.WEBHOOK_PORT || 10000;
  const repos = loadRepoConfigs();
  const seen  = loadSeen();

  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // ── Webhook routes ──────────────────────────────────────────────────────────
  for (const repo of repos) {
    app.post(repo.path, async (req, res) => {
      const sig = req.headers["x-hub-signature-256"];
      if (!verifySignature(repo.secret, req.rawBody, sig)) {
        console.warn(`[FETCHER] Bad signature on ${repo.path}`);
        return res.status(401).json({ error: "invalid signature" });
      }

      const event   = req.headers["x-github-event"];
      const payload = req.body;

      // Always respond 200 immediately so GitHub doesn't retry
      res.sendStatus(200);

      if (event !== "push") return;
      if (payload.deleted) return;

      const sha = payload.head_commit?.id || payload.after;

      // Deduplicate (e.g. GitHub retry landing after a catch-up already sent it)
      if (sha && seen.has(sha)) {
        console.log(`[FETCHER] Duplicate webhook ignored: ${sha}`);
        return;
      }

      try {
        await waitForClient(client);
        const channel = await client.channels.fetch(repo.channelId);
        if (!channel?.isTextBased()) {
          return console.error(`[FETCHER] Channel ${repo.channelId} is not a text channel.`);
        }
        await channel.send({ embeds: [buildPushEmbed(payload, repo.path)] });
        if (sha) markSeen(seen, sha);
        console.log(`[FETCHER] Push embed sent → ${repo.path}`);
      } catch (err) {
        console.error(`[FETCHER] Failed to send embed:`, err.message);
      }
    });
  }

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => res.json({ status: "ok", repos: repos.length }));

  // ── Start listening, then catch up once Discord is ready ────────────────────
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[FETCHER] Webhook server on port ${PORT}`);
    waitForClient(client).then(() => catchUpMissedPushes(client, repos, seen));
  });
}

module.exports = { startWebhookServer };