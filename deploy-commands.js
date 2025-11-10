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
