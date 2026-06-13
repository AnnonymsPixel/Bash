const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// ── Persistent Ticket Counter ─────────────────────────────────────────────────
// Stored in tickets.json next to this file so IDs survive restarts.
const COUNTER_FILE = path.join(__dirname, "tickets.json");

function loadCounter() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const data = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
      return typeof data.next === "number" ? data.next : 1;
    }
  } catch { /* fall through */ }
  return 1;
}

function saveCounter(next) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ next }, null, 2));
}

function nextTicketId() {
  const id = loadCounter();
  saveCounter(id + 1);
  return id;
}

// Pad ticket ID: 1 → #0001
function formatId(n) {
  return `#${String(n).padStart(4, "0")}`;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BUTTON_OPEN_ID   = "ticket_open";
const BUTTON_CLOSE_ID  = "ticket_close";

// ── Slash Command Definition ──────────────────────────────────────────────────
function registerTicketCommand() {
  return new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Post the ticket panel in this channel (Staff only).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) // base guard
    .toJSON();
}

// ── Guard: check if member has the Staff role ─────────────────────────────────
function isStaff(member) {
  const staffRoleId = process.env.STAFF_ROLE_ID;
  if (!staffRoleId) {
    console.warn("[TICKTER] STAFF_ROLE_ID not set in .env — no one can open tickets!");
    return false;
  }
  return member.roles.cache.has(staffRoleId);
}

// ── Build the Ticket Panel Embed + Button ─────────────────────────────────────
function buildTicketPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🎫  Support Tickets")
    .setDescription(
      "Need help? Click the button below to open a private ticket.\n" +
      "A staff member will be with you shortly."
    )
    .setFooter({ text: "Only Staff may respond to tickets." })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_OPEN_ID)
      .setLabel("Open Ticket")
      .setEmoji("🎫")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

// ── Build the Ticket Thread Welcome Embed ─────────────────────────────────────
function buildTicketEmbed(ticketId, member) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`Ticket ${formatId(ticketId)}`)
    .setDescription(
      `Hello ${member}, a staff member will assist you shortly.\n\n` +
      `> Describe your issue in as much detail as possible.\n\n` +
      `Click **Close Ticket** when your issue is resolved.`
    )
    .setThumbnail(member.displayAvatarURL({ size: 64, extension: "png" }))
    .setFooter({ text: `Opened by ${member.user.tag}` })
    .setTimestamp();
}

function buildCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_CLOSE_ID)
      .setLabel("Close Ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// ── Interaction Handler ───────────────────────────────────────────────────────
async function handleTicketInteraction(interaction, _client) {
  // ── /ticket command ───────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "ticket") {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: "You need the **Staff** role to post the ticket panel.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: "Ticket panel posted.", ephemeral: true });
    await interaction.channel.send(buildTicketPanel());
    return;
  }

  // ── Button: Open Ticket ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === BUTTON_OPEN_ID) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: "Only **Staff** members can open tickets.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const ticketId   = nextTicketId();
    const paddedId   = formatId(ticketId);
    const staffRole  = process.env.STAFF_ROLE_ID;
    const guild      = interaction.guild;
    const member     = interaction.member;

    try {
      // Create a private thread
      const thread = await interaction.channel.threads.create({
        name:                 `ticket-${paddedId}`,
        type:                 ChannelType.PrivateThread,
        invitable:            false,           // staff adds people manually
        autoArchiveDuration:  10080,           // 7 days
        reason:               `Ticket ${paddedId} opened by ${member.user.tag}`,
      });

      // Add the opener
      await thread.members.add(member.id);

      // Ping staff role inside thread
      const staffPing = staffRole ? `<@&${staffRole}>` : "*No staff role configured.*";

      await thread.send({
        content:    `${staffPing} — new ticket from ${member}`,
        embeds:     [buildTicketEmbed(ticketId, member)],
        components: [buildCloseRow()],
      });

      await interaction.editReply({
        content: `Your ticket ${paddedId} has been opened: ${thread}`,
      });

      console.log(`[TICKTER] Ticket ${paddedId} opened by ${member.user.tag} in ${guild.name}`);
    } catch (err) {
      console.error("[TICKTER] Failed to create ticket thread:", err.message);
      await interaction.editReply({
        content: "❌ Something went wrong creating your ticket. Please try again.",
      });
    }

    return;
  }

  // Close Button
  if (interaction.isButton() && interaction.customId === BUTTON_CLOSE_ID) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: "Only **Staff** may close tickets.",
        ephemeral: true,
      });
    }

    const thread = interaction.channel;

    const closeEmbed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle("🔒 Ticket Closed")
      .setDescription(`Closed by ${interaction.member} at <t:${Math.floor(Date.now() / 1000)}:F>`)
      .setTimestamp();

    await interaction.reply({ embeds: [closeEmbed] });

    // Archive + lock 
    setTimeout(async () => {
      try {
        await thread.setLocked(true);
        await thread.setArchived(true);
        console.log(`[TICKTER] Thread ${thread.name} archived and locked.`);
      } catch (err) {
        console.error("[TICKTER] Failed to archive thread:", err.message);
      }
    }, 3000);

    return;
  }
}

module.exports = { registerTicketCommand, handleTicketInteraction };