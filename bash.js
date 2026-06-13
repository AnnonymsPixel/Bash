require("dotenv").config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require("discord.js");
const { startWebhookServer } = require("./Functions/fetcher");
const { registerTicketCommand, handleTicketInteraction } = require("./Functions/tickter");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

client.commands = new Collection();

client.once("ready", async () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  BASH online as ${client.user.tag.padEnd(13)}║`);
  console.log(`╚══════════════════════════════╝\n`);

  client.user.setPresence({
    activities: [{ name: "git push origin main", type: 3 }],
    status: "online",
  });

  await registerSlashCommands();
  startWebhookServer(client);
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

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("[BASH] Login failed:", err.message);
  process.exit(1);
});