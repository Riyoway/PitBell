<div align="center">

<img src="assets/banner.webp" alt="Hypixel Pit Event Bot banner" width="100%">

<br>

<img src="assets/icon.webp" alt="Pit Event Notifier icon" width="128">

# Pit Event Notifier

**Discord reminders for selected Hypixel Pit events.**

Choose the events you care about with emoji reactions and get mentioned before they start, in a server or directly in the bot's DMs.

</div>

---

## Features

- 🔔 Notifications for selected **Major** and **Minor** Pit events
- 🎯 Emoji-based event selection
- 💬 Works in Discord servers and bot DMs
- ⏱️ Configurable reminders from 1 to 30 minutes before an event
- ⏸️ Pause and resume notifications without losing your setup
- 🕒 Discord relative timestamps for upcoming events
- 💾 Persistent configuration with duplicate-notification protection
- ⚡ Direct event-schedule fetching with no HTML scraping
- 🛡️ No Message Content privileged intent required

The bot uses the same public event schedule consumed by [brookeafk.com](https://brookeafk.com/).

## Quick start

### Server

Run:

```text
/pit setup channel:#pit-events minutes:5
```

`channel` is optional. If omitted, the bot uses the channel where the command was run.

The user who runs `/pit setup` becomes the notification owner for that server configuration. Only that user's reactions on the setup panel are used, and reminders mention that user.

### DM

Open a DM with the bot and run:

```text
/pit setup minutes:5
```

The setup panel is posted directly in the DM. Selected event reminders are sent back to the same DM and mention the user who configured them.

## Commands

| Command | Description |
| --- | --- |
| `/pit setup [channel] [minutes]` | Create or replace the event selection panel |
| `/pit minutes value:3` | Change the reminder lead time |
| `/pit pause` | Pause notifications while keeping all settings |
| `/pit resume` | Resume notifications with the existing settings |
| `/pit status` | Show the current configuration and pause state |
| `/pit upcoming count:10` | Show upcoming Pit events |
| `/pit reset` | Remove the current configuration and stop notifications |

In servers, changing notification settings requires **Manage Server**. `/pit upcoming` can be used without changing the configuration.

## Supported events

<table>
<tr>
<td valign="top">

### Minor

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

</td>
<td valign="top">

### Major

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

</td>
</tr>
</table>

## Installation

### Requirements

- Node.js 20 or newer
- A Discord application with a bot user

Clone the repository and install dependencies:

```bash
git clone https://github.com/Riyoway/pit-event-bot.git
cd pit-event-bot
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure `.env`:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id
```

> [!IMPORTANT]
> Never commit `.env` or your bot token.

## Discord application setup

In the Discord Developer Portal, use **Guild Install** with these scopes:

- `bot`
- `applications.commands`

Recommended bot permissions:

- View Channels
- Send Messages
- Embed Links
- Add Reactions
- Read Message History

No privileged gateway intents are required.

The `/pit` command is registered globally with both **Guild** and **Bot DM** command contexts. Global registration is required for DM command support.

This project uses a normal bot installation for proactive scheduled DM reminders. It does not rely on a User Install-only app.

## Running

```bash
npm start
```

Syntax check:

```bash
npm run check
```

## Pausing notifications

Run:

```text
/pit pause
```

This pauses reminders while keeping:

- selected event reactions
- reminder lead time
- server channel or DM delivery target
- notification owner

Resume with:

```text
/pit resume
```

Events whose normal reminder time passed while notifications were paused are not sent later as catch-up notifications.

## Notification example

```text
@User
🍕 Pizza
A MAJOR event is starting soon.
Starts: in 5 minutes
```

## Event data source

The bot fetches the public schedule from:

```text
https://raw.githubusercontent.com/BrookeAFK/brookeafk-api/main/events.js
```

Entries contain an event name, timestamp, and Major/Minor type. The schedule is refreshed periodically. If a refresh fails, the last successfully fetched schedule is kept in memory.

## Runtime data

Configuration and duplicate-notification state are stored locally in:

```text
data/state.json
```

The file is ignored by Git and is created automatically at runtime.

## License

MIT
