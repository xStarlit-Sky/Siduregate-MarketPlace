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
