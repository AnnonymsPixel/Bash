require("dotenv").config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require("discord.js");
const { startWebhookServer } = require("./Functions/fetcher");
const { registerTicketCommand, handleTicketInteraction } = require("./Functions/tickter");

process.on("unhandledRejection", (err) => {
  console.error("[BASH] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[BASH] Uncaught exception:", err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

client.commands = new Collection();

// Start Express immediately so Render detects the port
startWebhookServer(client);

client.once("clientReady", async (c) => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  BASH online as ${c.user.tag.padEnd(13)}║`);
  console.log(`╚══════════════════════════════╝\n`);

  c.user.setPresence({
    activities: [{ name: "git push origin main", type: 3 }],
    status: "online",
  });

  await registerSlashCommands();
});

client.on("interactionCreate", async (interaction) => {
  await handleTicketInteraction(interaction, client);
});

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commands = [registerTicketCommand()];
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("[BASH] Slash commands registered globally.");
  } catch (err) {
    console.error("[BASH] Failed to register slash commands:", err.message);
  }
}

console.log("[BASH] Attempting Discord login...");
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("[BASH] Login failed:", err.message);
});