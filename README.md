# Pit Event Notifier

A lightweight Discord bot for Hypixel Pit event reminders.

The bot uses the same public event schedule consumed by [brookeafk.com](https://brookeafk.com/) and lets a server administrator choose which events to receive reminders for using emoji reactions.

## Features

- Slash-command configuration
- Major and Minor Pit event support
- Emoji-based event selection
- Mentions the user who ran `/pit setup`
- Configurable reminder time from 1 to 30 minutes before an event
- Discord relative timestamps for upcoming events
- Persistent configuration and duplicate-notification protection
- Direct schedule fetching with no HTML scraping
- No Message Content privileged intent required

## How event selection works

Run:

```text
/pit setup channel:#pit-events minutes:5
```

The bot posts a configuration embed containing every supported event and automatically adds the corresponding emoji reactions.

The user who runs `/pit setup` becomes the notification owner for that server configuration.

- React to an event emoji to enable notifications for that event.
- Remove the reaction to disable notifications for that event.
- Only the setup user's reactions are used for event selection.
- When a selected event is approaching, the bot mentions the setup user in the configured channel.

Running `/pit setup` again replaces the previous setup and changes the notification owner to the user who ran the new command.

## Supported events

### Minor events

| Emoji | Event |
| --- | --- |
| 🧮 | Quick Maths |
| 🐲 | Dragon Egg |
| 2️⃣ | 2x Rewards |
| 📦 | Care Package |
| 🪜 | KOTL |
| 👑 | KOTH |
| 💵 | Auction |
| 🍰 | Giant Cake |
| 🪙 | All bounty |

### Major events

| Emoji | Event |
| --- | --- |
| 🏳️ | Squads |
| 🐻 | Beast |
| 🍕 | Pizza |
| 🥔 | Rage Pit |
| 🏯 | Spire |
| 💸 | Robbery |
| 🧱 | Blockhead |
| 🎟️ | Raffle |
| 🆚 | Team Deathmatch |

## Requirements

- Node.js 20 or newer
- A Discord application with a bot user
- Permission to manage the Discord server where the bot is configured

## Installation

Clone the repository and install dependencies:

```bash
git clone <your-repository-url>
cd pit-event-notifier
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure `.env`:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
DEV_GUILD_ID=your_test_server_id
```

`DEV_GUILD_ID` is optional. During development, setting it registers slash commands only in that server so command updates appear quickly. Leave it empty for global command registration.

Never commit your `.env` file or Discord bot token. The included `.gitignore` already excludes `.env`.

## Discord application setup

In the Discord Developer Portal, create an application and bot, then invite it with these OAuth2 scopes:

- `bot`
- `applications.commands`

The bot needs the following permissions in the channel used by `/pit setup`:

- View Channel
- Send Messages
- Embed Links
- Add Reactions
- Read Message History

The bot does not require the Message Content privileged intent.

## Running the bot

```bash
npm start
```

To perform a syntax check without starting the bot:

```bash
npm run check
```

## Commands

| Command | Description |
| --- | --- |
| `/pit setup channel:#pit-events minutes:5` | Create or replace the event selection panel |
| `/pit minutes value:3` | Change the reminder lead time |
| `/pit status` | Show the current configuration |
| `/pit upcoming count:10` | Show upcoming Pit events |
| `/pit reset` | Remove the server configuration and stop notifications |

The `/pit` command requires the **Manage Server** permission by default.

## Notification example

When a selected event is approaching, the configured user is mentioned and an embed is sent with the event type and Discord timestamps.

```text
@User
🍕 Pizza
A MAJOR event is starting soon.
Starts: in 5 minutes
```

## Event data source

The bot fetches the public event schedule from:

```text
https://raw.githubusercontent.com/BrookeAFK/brookeafk-api/main/events.js
```

The source currently returns a JSON array in this format:

```json
[
  {
    "event": "Pizza",
    "timestamp": 1792920060000,
    "type": "major"
  }
]
```

The bot refreshes this schedule periodically and keeps the last successfully fetched schedule in memory if a refresh fails.

## Runtime data

Server configuration and sent-notification IDs are stored locally in:

```text
data/state.json
```

This file is generated automatically and is excluded from Git.

## Project structure

```text
pit-event-notifier/
├─ src/
│  └─ index.js
├─ data/
│  └─ .gitkeep
├─ .env.example
├─ .gitignore
├─ LICENSE
├─ package.json
└─ README.md
```

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Hypixel or BrookeAFK.

Event availability and timing depend on the external schedule source and may change if that source changes or becomes unavailable.

## License

MIT License. See [LICENSE](LICENSE).
