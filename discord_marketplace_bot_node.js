// Project: discord-marketplace-bot
// Files included below. Copy each section into its own file in a project folder.

// --------------------------
// FILE: package.json 
// --------------------------
{
  "name": "discord-marketplace-bot",
  "version": "1.0.0",
  "description": "Marketplace bot that creates forum listings from a single create-button channel. Designed for deployment on Railway/Render.",
  "main": "index.js",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "start": "node index.js",
    "register": "node deploy-commands.js"
  },
  "dependencies": {
    "discord.js": "^14.11.0",
    "better-sqlite3": "^8.2.0",
    "dotenv": "^16.3.1"
  }
}

// --------------------------
// FILE: .env.example
// --------------------------
# Copy to .env and fill in
BOT_TOKEN=your_bot_token_here
CLIENT_ID=your_bot_application_client_id
GUILD_ID=your_guild_id
CREATE_CHANNEL_ID=channel_id_where_button_lives
FORUM_CHANNEL_ID=forum_channel_id_for_listings
STAFF_LOG_CHANNEL_ID=optional_staff_log_channel_id_or_blank
ARCHIVE_AFTER_DAYS=7
DELETE_AFTER_DAYS=30
BUMP_COOLDOWN_HOURS=24

// --------------------------
// FILE: config.json (optional runtime overrides)
// --------------------------
{
  "archiveAfterDays": 7,
  "deleteAfterDays": 30,
  "bumpCooldownHours": 24
}

// --------------------------
// FILE: db.js
// --------------------------
// Simple sqlite wrapper using better-sqlite3
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data.sqlite'));

// Create tables if missing
db.prepare(`CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId TEXT,
  messageId TEXT,
  authorId TEXT,
  title TEXT,
  type TEXT,
  description TEXT,
  imageUrl TEXT,
  status TEXT,
  createdAt INTEGER,
  archivedAt INTEGER,
  lastBump INTEGER
)`).run();

module.exports = db;

// --------------------------
// FILE: deploy-commands.js
// --------------------------
// Registers the /create-listing slash command on your guild (optional - we use a button message by default)
const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');
require('dotenv').config();

const commands = [
  {
    name: 'health',
    description: 'Check bot health'
  }
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('Commands registered');
  } catch (err) {
    console.error(err);
  }
})();

// --------------------------
// FILE: index.js
// --------------------------
// Main bot file. Handles the create-listing message, modals, thread creation, buttons, and auto-archive loop.
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Events, ModalSubmitInteraction, PermissionsBitField } = require('discord.js');
require('dotenv').config();

const db = require('./db');

const ARCHIVE_AFTER = parseInt(process.env.ARCHIVE_AFTER_DAYS || '7', 10);
const DELETE_AFTER = parseInt(process.env.DELETE_AFTER_DAYS || '30', 10);
const BUMP_COOLDOWN_HOURS = parseInt(process.env.BUMP_COOLDOWN_HOURS || '24', 10);

const CREATE_CHANNEL_ID = process.env.CREATE_CHANNEL_ID;
const FORUM_CHANNEL_ID = process.env.FORUM_CHANNEL_ID;
const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

function logStaff(guild, text) {
  if (!STAFF_LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID);
  if (ch) ch.send({ content: text }).catch(()=>{});
}

client.once('ready', async () => {
  console.log('Ready as', client.user.tag);

  // Ensure create message exists in CREATE_CHANNEL_ID
  const createCh = await client.channels.fetch(CREATE_CHANNEL_ID).catch(()=>null);
  if (!createCh) {
    console.warn('Create channel not found - set CREATE_CHANNEL_ID in .env');
    return;
  }

  // Post or ensure a single create message with button
  try {
    const messages = await createCh.messages.fetch({ limit: 50 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length && m.components.length);

    const createButton = new ButtonBuilder().setCustomId('create_listing').setLabel('Create Listing').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(createButton);

    if (!botMsg) {
      const embed = new EmbedBuilder().setTitle('Create a New Marketplace Listing').setDescription('Click the button below to create a new listing in the marketplace forum.\nOnly the bot can create new threads; after creation the author (or admins) can manage their listing.');
      const sent = await createCh.send({ embeds: [embed], components: [row] });
      try { await sent.pin().catch(()=>{}); } catch(e){}
      console.log('Posted create-message');
    } else {
      // Update to ensure button exists
      await botMsg.edit({ components: [row] }).catch(()=>{});
      console.log('Ensured create-message');
    }
  } catch (err) {
    console.error('Failed to ensure create message', err);
  }

  // Start cleanup loop
  setInterval(cleanupLoop, 1000 * 60 * 60); // hourly
  // also run once at startup
  cleanupLoop();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'create_listing') {
        // Open modal
        const modal = new ModalBuilder().setCustomId('modal_create_listing').setTitle('Create Listing');
        const titleInput = new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90);
        const typeInput = new TextInputBuilder().setCustomId('type').setLabel('Type (Selling / Buying / Both)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Selling');
        const descInput = new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(2000);
        const imageInput = new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(titleInput));
        modal.addComponents(new ActionRowBuilder().addComponents(typeInput));
        modal.addComponents(new ActionRowBuilder().addComponents(descInput));
        modal.addComponents(new ActionRowBuilder().addComponents(imageInput));

        await interaction.showModal(modal);
      } else if (interaction.customId.startsWith('mark_sold:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleMarkSold(interaction, listingId);
      } else if (interaction.customId.startsWith('bump:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleBump(interaction, listingId);
      } else if (interaction.customId.startsWith('delete:')) {
        const listingId = interaction.customId.split(':')[1];
        // show confirm
        const confirm = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`delete_confirm_yes:${listingId}`).setLabel('Confirm Delete').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`delete_confirm_no:${listingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ content: 'Are you sure? This will permanently delete the thread.', components: [confirm], ephemeral: true });
      } else if (interaction.customId.startsWith('delete_confirm_yes:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleDelete(interaction, listingId);
      } else if (interaction.customId.startsWith('delete_confirm_no:')) {
        await interaction.update({ content: 'Delete canceled', components: [], ephemeral: true }).catch(()=>{});
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_create_listing') {
        const title = interaction.fields.getTextInputValue('title').slice(0, 90);
        let type = interaction.fields.getTextInputValue('type') || 'Selling';
        type = type.split(/[,/]/)[0].trim();
        const description = interaction.fields.getTextInputValue('description') || '';
        const image = interaction.fields.getTextInputValue('image') || '';

        await interaction.deferReply({ ephemeral: true });

        // Create a thread in the forum
        const forum = await client.channels.fetch(FORUM_CHANNEL_ID).catch(()=>null);
        if (!forum) return interaction.editReply('Forum channel not found.');

        const author = interaction.user;
        const threadName = `${title} — ${author.username}`.slice(0, 100);

        // Create the thread with a starter message (the bot will post the embed)
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description || 'No description provided.')
          .addFields({ name: 'Type', value: type, inline: true }, { name: 'Posted by', value: `${author}`, inline: true })
          .setTimestamp()
          .setFooter({ text: `Listing created by ${author.tag}` });
        if (image) embed.setImage(image);

        // Create thread in forum
        const createdThread = await forum.threads.create({ name: threadName, autoArchiveDuration: 1440, reason: 'Marketplace listing created by bot' });

        // Send embed message with buttons
        const msg = await createdThread.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mark_sold:${null}`).setLabel('Mark as Sold').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`bump:${null}`).setLabel('Bump').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`delete:${null}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
        )] });

        // store listing and update buttons with proper ids
        const now = Date.now();
        const insert = db.prepare(`INSERT INTO listings (threadId, messageId, authorId, title, type, description, imageUrl, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?)`);
        const info = insert.run(createdThread.id, msg.id, author.id, title, type, description, image || '', 'active', now);
        const listingId = info.lastInsertRowid;

        // Update button IDs to include listing id
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mark_sold:${listingId}`).setLabel('Mark as Sold').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`bump:${listingId}`).setLabel('Bump').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`delete:${listingId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
        );
        await msg.edit({ components: [updatedRow] }).catch(()=>{});

        await interaction.editReply({ content: 'Listing created!', ephemeral: true });
        logStaff(interaction.guild, `Listing #${listingId} created by ${author.tag} (${author.id}) in thread ${createdThread.id}`);
      }
    }
  } catch (err) {
    console.error('Interaction handler error', err);
    try { if (interaction.deferred || interaction.replied) await interaction.editReply('An error occurred.'); else await interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch(e){}
  }
});

async function handleMarkSold(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found', ephemeral: true });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can mark this listing.', ephemeral: true });
  }

  // Archive the thread and mark status
  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found', ephemeral: true });

  await thread.setArchived(true, 'Marked sold');
  const now = Date.now();
  db.prepare('UPDATE listings SET status = ?, archivedAt = ? WHERE id = ?').run('sold', now, listingId);

  // Edit message to reflect sold
  try {
    const msg = await thread.messages.fetch(row.messageId).catch(()=>null);
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0] || {}).setFooter({ text: `Marked SOLD by ${interaction.user.tag}` });
      await msg.edit({ embeds: [embed], components: [] }).catch(()=>{});
    }
  } catch(e){}

  await interaction.reply({ content: 'Marked as sold and archived.', ephemeral: true });
  logStaff(interaction.guild, `Listing #${listingId} marked sold by ${interaction.user.tag}`);
}

async function handleBump(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found', ephemeral: true });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can bump this listing.', ephemeral: true });
  }

  const now = Date.now();
  const lastBump = row.lastBump || 0;
  const cooldownMs = BUMP_COOLDOWN_HOURS * 3600 * 1000;
  if (now - lastBump < cooldownMs && interaction.user.id !== row.authorId) {
    const remain = Math.ceil((cooldownMs - (now - lastBump)) / 3600000);
    return interaction.reply({ content: `Bump is on cooldown. Try again in ~${remain} hour(s).`, ephemeral: true });
  }

  // Unarchive thread if archived
  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found', ephemeral: true });
  try { await thread.setArchived(false, 'Bumped by user'); } catch(e){}

  // Post a small bump message in thread
  try { await thread.send({ content: `Listing bumped by ${interaction.user}` }).catch(()=>{}); } catch(e){}

  db.prepare('UPDATE listings SET lastBump = ?, archivedAt = NULL WHERE id = ?').run(now, listingId);
  await interaction.reply({ content: 'Bumped listing!', ephemeral: true });
  logStaff(interaction.guild, `Listing #${listingId} bumped by ${interaction.user.tag}`);
}

async function handleDelete(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found', ephemeral: true });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can delete this listing.', ephemeral: true });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (thread) {
    try { await thread.delete('Deleted via bot'); } catch(e){}
  }
  db.prepare('DELETE FROM listings WHERE id = ?').run(listingId);
  await interaction.update({ content: 'Listing deleted.', components: [] }).catch(()=>{});
  logStaff(interaction.guild, `Listing #${listingId} deleted by ${interaction.user.tag}`);
}

async function cleanupLoop() {
  try {
    const now = Date.now();
    const archiveMs = ARCHIVE_AFTER * 24 * 3600 * 1000;
    const deleteMs = DELETE_AFTER * 24 * 3600 * 1000;

    const listings = db.prepare('SELECT * FROM listings').all();
    for (const l of listings) {
      // fetch thread to check last activity
      const thread = await client.channels.fetch(l.threadId).catch(()=>null);
      if (!thread) {
        // if thread missing, remove record
        db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
        continue;
      }

      // If active and older than archive threshold, archive
      if (l.status === 'active') {
        const created = l.createdAt || now;
        const lastActivity = l.lastBump || created;
        if (now - lastActivity > archiveMs) {
          try {
            await thread.setArchived(true, 'Auto-archived due to inactivity');
          } catch(e){}
          db.prepare('UPDATE listings SET archivedAt = ? WHERE id = ?').run(now, l.id);
          logStaff(thread.guild, `Listing #${l.id} auto-archived`);
        }
      }

      // If archived and archivedAt older than delete threshold -> delete
      if (l.archivedAt) {
        if (now - l.archivedAt > deleteMs) {
          try { await thread.delete('Auto-deleted after archived time'); } catch(e){}
          db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
          logStaff(thread.guild, `Listing #${l.id} auto-deleted`);
        }
      }
    }
  } catch (err) {
    console.error('Cleanup loop error', err);
  }
}

client.login(process.env.BOT_TOKEN);


// --------------------------
// FILE: README.md
// --------------------------
# Discord Marketplace Bot

This project creates a bot that posts a single "Create Listing" message in a channel. Users click the button to open a modal; the bot creates a forum thread in your forum channel with management buttons.

## Setup
1. Copy `.env.example` to `.env` and fill in values.
2. Install dependencies: `npm install`.
3. (Optional) run `node deploy-commands.js` to register slash commands.
4. Start locally: `npm start`.

## Deployment (Railway)
1. Create a GitHub repo and commit this project.
2. Create a Railway account and connect the GitHub repo.
3. Add environment variables from `.env` in Railway.
4. Deploy. On the free plan the bot may sleep when idle; upgrade to keep always-on.

## Notes
- The initial create message is posted automatically in CREATE_CHANNEL_ID (and pinned if necessary).
- The forum channel must be a ForumChannel and the bot must have ManageThreads permission.
- Only the author or staff (ManageThreads) can bump, mark sold, or delete.


// End of project
