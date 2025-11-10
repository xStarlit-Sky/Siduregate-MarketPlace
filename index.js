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
  if (!STAFF_LOG_CHANNEL_ID) return;
  try {
    if (!guild) return;
    const ch = await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(()=>null);
    if (ch && ch.isTextBased()) await ch.send({ content: text });
  } catch (err) {
    console.error('Failed to log to staff channel:', err);
  }
}

// ===== READY EVENT =====
client.once('clientReady', async () => {
  console.log('Ready as', client.user.tag);

  // Ensure create message exists in CREATE_CHANNEL_ID
  const createCh = await client.channels.fetch(CREATE_CHANNEL_ID).catch(()=>null);
  if (!createCh) {
    console.warn('Create channel not found - set CREATE_CHANNEL_ID in .env');
    return;
  }

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
        .setDescription('Click the button below to create a new listing in the marketplace forum.\nOnly the bot can create new threads; after creation the author (or admins) can manage their listing.');
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
    // ===== BUTTONS =====
    if (interaction.isButton()) {
      if (interaction.customId === 'create_listing') {
        // Open modal immediately
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
      } 
      // MARK SOLD
      else if (interaction.customId.startsWith('mark_sold:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleMarkSold(interaction, listingId);
      } 
      // BUMP
      else if (interaction.customId.startsWith('bump:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleBump(interaction, listingId);
      } 
      // DELETE CONFIRM
      else if (interaction.customId.startsWith('delete:')) {
        const listingId = interaction.customId.split(':')[1];
        const confirm = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`delete_confirm_yes:${listingId}`).setLabel('Confirm Delete').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`delete_confirm_no:${listingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ content: 'Are you sure? This will permanently delete the thread.', components: [confirm], flags: 64 });
      } else if (interaction.customId.startsWith('delete_confirm_yes:')) {
        const listingId = interaction.customId.split(':')[1];
        await handleDelete(interaction, listingId);
      } else if (interaction.customId.startsWith('delete_confirm_no:')) {
        await interaction.update({ content: 'Delete canceled', components: [] }).catch(()=>{});
      }
    } 
    // ===== MODAL SUBMISSION =====
    else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_create_listing') {
        const title = interaction.fields.getTextInputValue('title').slice(0, 90);
        let type = interaction.fields.getTextInputValue('type') || 'Selling';
        type = type.split(/[,/]/)[0].trim();
        const description = interaction.fields.getTextInputValue('description') || '';
        const image = interaction.fields.getTextInputValue('image') || '';

        // Defer ephemeral reply immediately
        await interaction.deferReply({ ephemeral: true });

        const forum = await client.channels.fetch(FORUM_CHANNEL_ID).catch(()=>null);
        if (!forum) return interaction.editReply('Forum channel not found.');

        const author = interaction.user;
        const threadName = `${title} — ${author.username}`.slice(0, 100);

        // Embed for thread starter message
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description || 'No description provided.')
          .addFields(
            { name: 'Type', value: type, inline: true },
            { name: 'Posted by', value: `${author}`, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Listing created by ${author.tag}` });
        if (image) embed.setImage(image);

        // Insert listing in DB first
        const now = Date.now();
        const insert = db.prepare(`INSERT INTO listings (threadId, messageId, authorId, title, type, description, imageUrl, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?)`);

        // Create forum thread with starter message
        const createdThread = await forum.threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
          reason: 'Marketplace listing created by bot',
          message: {
            content: `🛒 New listing created by <@${author.id}>`,
            embeds: [embed]
          }
        });

        // Fetch starter message (first message in thread)
        const starterMessage = await createdThread.messages.fetch({ limit: 1 }).then(col => col.first());

        // Store listing in DB
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

        // Send buttons after knowing listingId
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mark_sold:${listingId}`).setLabel('Mark as Sold').setStyle(ButtonStyle.Success),
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
    try { 
      if (interaction.deferred || interaction.replied) 
        await interaction.editReply('An error occurred.');
      else 
        await interaction.reply({ content: 'An error occurred.', flags: 64 }); 
    } catch(e){}
  }
});

// ===== HANDLER FUNCTIONS =====
async function handleMarkSold(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', flags: 64 });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can mark this listing.', flags: 64 });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found.', flags: 64 });

  await thread.setArchived(true, 'Marked sold');
  const now = Date.now();
  db.prepare('UPDATE listings SET status = ?, archivedAt = ? WHERE id = ?').run('sold', now, listingId);

  try {
    const msg = await thread.messages.fetch(row.messageId).catch(()=>null);
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0] || {}).setFooter({ text: `Marked SOLD by ${interaction.user.tag}` });
      await msg.edit({ embeds: [embed], components: [] }).catch(()=>{});
    }
  } catch(e){}

  await interaction.reply({ content: 'Marked as sold and archived.', flags: 64 });
  logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} marked sold by ${interaction.user.tag}`);
}

async function handleBump(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', flags: 64 });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can bump this listing.', flags: 64 });
  }

  const now = Date.now();
  const lastBump = row.lastBump || 0;
  const cooldownMs = BUMP_COOLDOWN_HOURS * 3600 * 1000;
  if (now - lastBump < cooldownMs && interaction.user.id !== row.authorId) {
    const remain = Math.ceil((cooldownMs - (now - lastBump)) / 3600000);
    return interaction.reply({ content: `Bump is on cooldown. Try again in ~${remain} hour(s).`, flags: 64 });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (!thread) return interaction.reply({ content: 'Thread not found.', flags: 64 });
  try { await thread.setArchived(false, 'Bumped by user'); } catch(e){}
  try { await thread.send({ content: `Listing bumped by ${interaction.user}` }).catch(()=>{}); } catch(e){}

  db.prepare('UPDATE listings SET lastBump = ?, archivedAt = NULL WHERE id = ?').run(now, listingId);
  await interaction.reply({ content: 'Bumped listing!', flags: 64 });
  logStaff(interaction.guild || interaction.channel?.guild, `Listing #${listingId} bumped by ${interaction.user.tag}`);
}

async function handleDelete(interaction, listingId) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!row) return interaction.reply({ content: 'Listing not found.', flags: 64 });
  if (interaction.user.id !== row.authorId && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageThreads)) {
    return interaction.reply({ content: 'Only the author or staff can delete this listing.', flags: 64 });
  }

  const thread = await client.channels.fetch(row.threadId).catch(()=>null);
  if (thread) {
    try { await thread.delete('Deleted via bot'); } catch(e){}
  }
  db.pr
