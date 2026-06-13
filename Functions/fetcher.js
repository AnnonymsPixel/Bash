const express = require("express");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");

const COLORS = {
  force:  0xF0B429,
  normal: 0x4A90E2,
  merge:  0x2ECC71,
};

function loadRepoConfigs() {
  const repos = [];
  let n = 1;
  while (process.env[`REPO_${n}_PATH`]) {
    repos.push({
      path:      process.env[`REPO_${n}_PATH`],
      channelId: process.env[`REPO_${n}_CHANNEL_ID`],
      secret:    process.env[`REPO_${n}_SECRET`] || null,
    });
    n++;
  }
  if (repos.length === 0) {
    console.warn("[FETCHER] No REPO_N_* env vars found.");
  } else {
    console.log(`[FETCHER] Loaded ${repos.length} repo(s):`);
    repos.forEach((r, i) => console.log(`  [${i + 1}] ${r.path} → channel ${r.channelId}`));
  }
  return repos;
}

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
  let out = shown.map((f) => `${f}`).join("\n");
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
  if (msg.startsWith("merge") || msg.includes("merged")) return "merge";
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
  const commits  = payload.commits || [];
  const head     = payload.head_commit;

  const avatarUrl = payload.sender?.avatar_url ? `${payload.sender.avatar_url}&size=64` : null;
  const pusherUrl = payload.sender?.html_url || null;

  const badge = type === "force" ? "☢️ Force Push"
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
    embed.addFields({ name: `${commits.length} Commit${commits.length !== 1 ? "s" : ""}`, value: lines + overflow });
  }

  const fileBlock = formatFiles(collectFiles(commits));
  if (fileBlock) {
    embed.addFields({ name: "📁 Files", value: fileBlock });
  }

  embed.setTimestamp(head?.timestamp ? new Date(head.timestamp) : new Date());
  return embed;
}

// Wait for Discord client to be ready, up to 30 seconds
function waitForClient(client, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (client.isReady()) return resolve();
    const timer = setTimeout(() => reject(new Error("Discord client not ready after 30s")), timeout);
    client.once("clientReady", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function startWebhookServer(client) {
  const app   = express();
  const PORT  = process.env.PORT || process.env.WEBHOOK_PORT || 10000;
  const repos = loadRepoConfigs();

  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  for (const repo of repos) {
    app.post(repo.path, async (req, res) => {
      const sig = req.headers["x-hub-signature-256"];
      if (!verifySignature(repo.secret, req.rawBody, sig)) {
        console.warn(`[FETCHER] Bad signature on ${repo.path}`);
        return res.status(401).json({ error: "invalid signature" });
      }

      const event   = req.headers["x-github-event"];
      const payload = req.body;

      res.sendStatus(200);

      if (event !== "push") return;
      if (payload.deleted && (!payload.commits || payload.commits.length === 0)) return;

      try {
        // Wait for Discord to be ready before sending
        await waitForClient(client);

        const channel = await client.channels.fetch(repo.channelId);
        if (!channel?.isTextBased()) {
          return console.error(`[FETCHER] Channel ${repo.channelId} is not a text channel.`);
        }
        await channel.send({ embeds: [buildPushEmbed(payload, repo.path)] });
        console.log(`[FETCHER] Push embed sent → ${repo.path}`);
      } catch (err) {
        console.error(`[FETCHER] Failed to send embed:`, err.message);
      }
    });
  }

  app.get("/health", (_req, res) => res.json({ status: "ok", repos: repos.length }));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[FETCHER] Webhook server on port ${PORT}`);
  });
}

module.exports = { startWebhookServer };