// Main bot file. Handles the create-listing message, modals, thread creation, buttons, and auto-archive loop.
const fs = require('fs');
const path = require('path');
const { 
  Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, 
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Events, PermissionsBitField 
} = require('discord.js');
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

// ===== STAFF LOGGING =====
async function logStaff(guild, text) {
  if (!STAFF_LOG_CHANNEL_ID || !guild) return;
  try {
    const ch = await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(()=>null);
    if (ch?.isTextBased()) await ch.send({ content: text });
  } catch (err) {
    console.error('Failed to log to staff channel:', err);
  }
}

// ===== READY EVENT =====
client.once('ready', async () => {
  console.log('Ready as', client.user.tag);

  const createCh = await client.channels.fetch(CREATE_CHANNEL_ID).catch(()=>null);
  if (!createCh) return console.warn('Create channel not found - set CREATE_CHANNEL_ID in .env');

  try {
    const messages = await createCh.messages.fetch({ limit: 50 });
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length && m.components.length);

    const createButton = new ButtonBuilder()
      .setCustomId('create_listing')
      .setLabel('Create Listing')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(createButton);

    if (!botMsg) {
      const embed = new EmbedBuilder()
        .setTitle('Create a New Marketplace Listing')
        .setDescription('Click the button below to create a new listing.\nOnly the bot can create threads; the author or admins can manage their listing.')
        .setColor(0x00AE86);
      const sent = await createCh.send({ embeds: [embed], components: [row] });
      try { await sent.pin().catch(()=>{}); } catch(e){}
      console.log('Posted create-message');
    } else {
      await botMsg.edit({ components: [row] }).catch(()=>{});
      console.log('Ensured create-message');
    }
  } catch (err) {
    console.error('Failed to ensure create message', err);
  }

  setInterval(cleanupLoop, 1000 * 60 * 60); // hourly
  cleanupLoop();
});

// ===== INTERACTIONS =====
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      const [action, listingId] = interaction.customId.split(':');

      switch(action) {
        case 'create_listing':
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
          break;

        case 'archive':
        case 'unarchive':
          await handleArchiveToggle(interaction, listingId);
          break;

        case 'bump':
          await handleBump(interaction, listingId);
          break;

        case 'delete':
          const confirm = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`delete_confirm_yes:${listingId}`).setLabel('Confirm Delete').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`delete_confirm_no:${listingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
          );
          if (!interaction.replied) {
            await interaction.reply({ content: 'Are you sure? This will permanently delete the thread.', components: [confirm], ephemeral: true });
          }
          break;

        case 'delete_confirm_yes':
          await handleDelete(interaction, listingId);
          break;

        case 'delete_confirm_no':
          if (!interaction.replied) {
            await interaction.update({ content: 'Delete canceled', components: [] }).catch(()=>{});
          }
          break;
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_create_listing') {
        const title = interaction.fields.getTextInputValue('title').slice(0, 90);
        let type = interaction.fields.getTextInputValue('type') || 'Selling';
        type = type.split(/[,/]/)[0].trim();
        const description = interaction.fields.getTextInputValue('description') || '';
        const image = interaction.fields.getTextInputValue('image') || '';

        await interaction.deferReply({ ephemeral: true });

        const forum = await client.channels.fetch(FORUM_CHANNEL_ID).catch(()=>null);
        if (!forum) return interaction.editReply('Forum channel not found.');

        const author = interaction.user;
        const threadName = `${title} — ${author.username}`.slice(0, 100);

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description || 'No description provided.')
          .addFields(
            { name: 'Type', value: type, inline: true },
            { name: 'Posted by', value: `${author}`, inline: true }
          )
          .setTimestamp()
          .setColor(0x00AE86)
          .setFooter({ text: `Created by ${author.tag}` });
        if (image) embed.setImage(image);

        const now = Date.now();
        const insert = db.prepare(`INSERT INTO listings (threadId, messageId, authorId, title, type, description, imageUrl, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?)`);

        const createdThread = await forum.threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
          reason: 'Marketplace listing created by bot',
          message: {
            content: `🛒 New listing created by <@${author.id}>`,
            embeds: [embed]
          }
        });

        const starterMessage = await createdThread.messages.fetch({ limit: 1 }).then(col => col.first());

        const info = insert.run(
          createdThread.id,
          starterMessage.id,
          author.id,
          title,
          type,
          description,
          image || '',
          'active',
          now
        );
        const listingId = info.lastInsertRowid;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`archive:${listingId}`).setLabel('Archive').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`bump:${listingId}`).setLabel('Bump').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`delete:${listingId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
        );
        await createdThread.send({ content: 'Manage your listing:', components: [row] }).catch(()=>{});

        await interaction.editReply({ content: 'Listing created!' });
        logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} created by ${author.tag} (${author.id}) in thread ${createdThread.id}`);
      }
    }
  } catch (err) {
    console.error('Interaction handler error', err);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch(e){}
    }
  }
});

// ===== HANDLER FUNCTIONS =====
async function handleArchiveToggle(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', ephemeral: true });

  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can toggle archive.', ephemeral: true });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found.', ephemeral: true });

  const isArchived = thread.archived;
  try {
    await thread.setArchived(!isArchived, isArchived ? 'Reopened by user' : 'Archived by user');
  } catch(e) {
    return interaction.reply({ content: `Could not ${isArchived ? 'unarchive' : 'archive'} thread.`, ephemeral: true });
  }

  db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(isArchived ? 'active' : 'archived', listingId);

  const newLabel = isArchived ? 'Archive' : 'Unarchive';
  const rowComponents = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`archive:${listingId}`).setLabel(newLabel).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`bump:${listingId}`).setLabel('Bump').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`delete:${listingId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
  );

  if (!interaction.replied) await interaction.update({ components: [rowComponents] }).catch(()=>{});
  logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} ${isArchived ? 'reopened' : 'archived'} by ${interaction.user.tag}`);
}

async function handleBump(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', ephemeral: true });

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

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found.', ephemeral: true });

  try {
    if (thread.archived) await thread.setArchived(false, 'Bumped by user');
    const bumpMsg = await thread.send({ content: `Listing bumped by ${interaction.user}` });
    setTimeout(() => bumpMsg.delete().catch(()=>{}), 2000);
  } catch(e){ console.error('Bump error:', e); }

  db.prepare('UPDATE listings SET lastBump = ?, archivedAt = NULL WHERE id = ?').run(now, listingId);

  if (!interaction.replied) await interaction.reply({ content: 'Bumped listing!', ephemeral: true });
  logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} bumped by ${interaction.user.tag}`);
}

async function handleDelete(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', ephemeral: true });

  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can delete this listing.', ephemeral: true });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (thread) try { await thread.delete('Deleted via bot'); } catch(e){}

  db.prepare('DELETE FROM listings WHERE id = ?').run(listingId);
  if (!interaction.replied) await interaction.update({ content: 'Listing deleted.', components: [] }).catch(()=>{});
  logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} deleted by ${interaction.user.tag}`);
}

// ===== CLEANUP LOOP =====
async function cleanupLoop() {
  try {
    const now = Date.now();
    const archiveMs = ARCHIVE_AFTER * 24 * 3600 * 1000;
    const deleteMs = DELETE_AFTER * 24 * 3600 * 1000;

    const listings = db.prepare('SELECT * FROM listings').all();
    for (const l of listings) {
      const thread = await client.channels.fetch(l.threadId).catch(()=>null);
      if (!thread) {
        db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
        continue;
      }

      if (l.status === 'active') {
        const created = l.createdAt || now;
        const lastActivity = l.lastBump || created;
        if (now - lastActivity > archiveMs) {
          try { await thread.setArchived(true, 'Auto-archived due to inactivity'); } catch(e){}
          db.prepare('UPDATE listings SET archivedAt = ? WHERE id = ?').run(now, l.id);
          logStaff(thread.guild, `Listing #${l.id} auto-archived`);
        }
      }

      if (l.archivedAt && now - l.archivedAt > deleteMs) {
        try { await thread.delete('Auto-deleted after archived time'); } catch(e){}
        db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
        logStaff(thread.guild, `Listing #${l.id} auto-deleted`);
      }
    }
  } catch (err) {
    console.error('Cleanup loop error', err);
  }
}

client.login(process.env.BOT_TOKEN);
