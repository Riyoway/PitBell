<div align="center">

<img src="assets/banner.webp" alt="Hypixel Pit Event Bot banner" width="100%">

<br>

<img src="assets/icon.webp" alt="Pit Event Notifier icon" width="128">

# Pit Event Notifier

**Discord reminders for selected Hypixel Pit events.**

Choose the events you care about from a multi-select menu and get mentioned before they start, in a server or directly in the bot's DMs.

</div>

---

## Features

- 🔔 Notifications for selected **Major** and **Minor** Pit events
- 🎛️ Multi-select event menu with native Discord components
- ⚡ Quick buttons for **Minor**, **Major**, **All**, **Clear**, and **Pause / Resume**
- ⌛ Setup panels automatically expire and are replaced with an expired-state message
- 💬 Works in Discord servers and bot DMs
- ⏱️ Configurable reminders from 1 to 30 minutes before an event
- 🕒 Discord relative timestamps for upcoming events
- 📺 Streaming presence showing the current or next Pit event
- 💾 Persistent configuration with duplicate-notification protection
- 🔄 Automatic migration from the old reaction-based setup
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

The user who runs `/pit setup` becomes the notification owner for that server configuration. Use the dropdown to select events, or use the quick-selection buttons below it. Reminders mention that user.

### DM

Open a DM with the bot and run:

```text
/pit setup minutes:5
```

The setup panel is posted directly in the DM. Choose events from the dropdown and selected event reminders are sent back to the same DM.

## Setup panel

The panel uses Discord's native message components instead of reactions:

- **Event dropdown** — select one or multiple events at once
- **Minor** — select every Minor event
- **Major** — select every Major event
- **All** — select all supported events
- **Clear** — remove all event selections
- **Pause / Resume** — stop or restart reminders without losing the selection

By default, a setup panel expires after **15 minutes**. When it expires, the original message is updated to show that the panel is no longer interactive and its components are removed. Your selected events, reminder time, pause state, and notification target remain saved. Run `/pit setup` again to open a fresh panel.

Existing reaction-based configurations are migrated automatically on startup when possible.

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
# Optional: URL used by the Discord Streaming presence
STREAM_URL=https://www.twitch.tv/hypixel
# Optional: setup panel lifetime in minutes
PANEL_TIMEOUT_MINUTES=15
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
- Read Message History

No privileged gateway intents are required. Select menus and buttons do not require additional bot permissions.

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

Use the **Pause** button on the setup panel or run:

```text
/pit pause
```

This pauses reminders while keeping:

- selected events
- reminder lead time
- server channel or DM delivery target
- notification owner

Resume from the panel or with:

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
