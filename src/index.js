import 'dotenv/config';
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

const SOURCE_URL = 'https://raw.githubusercontent.com/BrookeAFK/brookeafk-api/main/events.js';
const POLL_MS = 20_000;
const SOURCE_REFRESH_MS = 60_000;
const DEFAULT_LEAD_MINUTES = 5;

const EVENTS = Object.freeze([
  { name: 'Quick Maths', emoji: '🧮', type: 'minor' },
  { name: 'Dragon Egg', emoji: '🐲', type: 'minor' },
  { name: '2x Rewards', emoji: '2️⃣', type: 'minor' },
  { name: 'Care Package', emoji: '📦', type: 'minor' },
  { name: 'KOTL', emoji: '🪜', type: 'minor' },
  { name: 'KOTH', emoji: '👑', type: 'minor' },
  { name: 'Auction', emoji: '💵', type: 'minor' },
  { name: 'Giant Cake', emoji: '🍰', type: 'minor' },
  { name: 'All bounty', emoji: '🪙', type: 'minor' },
  { name: 'Squads', emoji: '🏳️', type: 'major' },
  { name: 'Beast', emoji: '🐻', type: 'major' },
  { name: 'Pizza', emoji: '🍕', type: 'major' },
  { name: 'Rage Pit', emoji: '🥔', type: 'major' },
  { name: 'Spire', emoji: '🏯', type: 'major' },
  { name: 'Robbery', emoji: '💸', type: 'major' },
  { name: 'Blockhead', emoji: '🧱', type: 'major' },
  { name: 'Raffle', emoji: '🎟️', type: 'major' },
  { name: 'Team Deathmatch', emoji: '🆚', type: 'major' },
]);

const EVENT_BY_NAME = new Map(EVENTS.map((event) => [event.name, event]));
const EVENT_BY_EMOJI = new Map(EVENTS.map((event) => [normalizeEmoji(event.emoji), event]));

const commands = [
  new SlashCommandBuilder()
    .setName('pit')
    .setDescription('Hypixel Pit event notifications')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Create or replace the event subscription panel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel for the panel and event notifications')
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('minutes')
            .setDescription('Notify this many minutes before an event')
            .setMinValue(1)
            .setMaxValue(30)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('minutes')
        .setDescription('Change how many minutes before an event notifications are sent')
        .addIntegerOption((option) =>
          option
            .setName('value')
            .setDescription('Minutes before the event')
            .setMinValue(1)
            .setMaxValue(30)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show the current notification configuration'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('upcoming')
        .setDescription('Show the next upcoming Pit events')
        .addIntegerOption((option) =>
          option
            .setName('count')
            .setDescription('Number of events to show')
            .setMinValue(1)
            .setMaxValue(15)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('reset').setDescription('Remove this server configuration and stop notifications'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const devGuildId = process.env.DEV_GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let state = { guilds: {}, notified: {} };
let sourceCache = { fetchedAt: 0, events: [] };
let pollRunning = false;
let saveQueue = Promise.resolve();

function normalizeEmoji(value) {
  return String(value ?? '').replace(/\uFE0F/g, '');
}

function eventKey(event) {
  return `${event.timestamp}:${event.event}`;
}

function unixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function buildPanelEmbed(leadMinutes, ownerUserId) {
  const minors = EVENTS.filter((event) => event.type === 'minor')
    .map((event) => `${event.emoji}  **${event.name}**`)
    .join('\n');
  const majors = EVENTS.filter((event) => event.type === 'major')
    .map((event) => `${event.emoji}  **${event.name}**`)
    .join('\n');

  return new EmbedBuilder()
    .setTitle('Hypixel Pit Event Notifications')
    .setDescription(
      `<@${ownerUserId}>: react with the emoji for every event you want to be notified about.\n` +
        `Remove your reaction to disable that event. Notifications mention **you** and are sent **${leadMinutes} minutes before** an event.`,
    )
    .addFields(
      { name: 'Minor Events', value: minors, inline: true },
      { name: 'Major Events', value: majors, inline: true },
    )
    .setFooter({ text: 'Event schedule: brookeafk.com data' })
    .setTimestamp();
}

function buildNotificationEmbed(event, leadMinutes) {
  const meta = EVENT_BY_NAME.get(event.event);
  const starts = unixSeconds(event.timestamp);
  return new EmbedBuilder()
    .setTitle(`${meta?.emoji ?? '🔔'} ${event.event}`)
    .setDescription(`A **${event.type.toUpperCase()}** event is starting soon.`)
    .addFields(
      { name: 'Starts', value: `<t:${starts}:R>`, inline: true },
      { name: 'Time', value: `<t:${starts}:t>`, inline: true },
      { name: 'Reminder', value: `${leadMinutes} min before`, inline: true },
    )
    .setTimestamp(event.timestamp);
}

function buildUpcomingEmbed(events) {
  const lines = events.map((event) => {
    const meta = EVENT_BY_NAME.get(event.event);
    const starts = unixSeconds(event.timestamp);
    const tag = event.type === 'major' ? 'Major' : 'Minor';
    return `${meta?.emoji ?? '•'} **${event.event}** · ${tag} · <t:${starts}:R> · <t:${starts}:t>`;
  });

  return new EmbedBuilder()
    .setTitle('Upcoming Hypixel Pit Events')
    .setDescription(lines.join('\n') || 'No upcoming events were returned by the source.')
    .setFooter({ text: 'Source: brookeafk.com event data' })
    .setTimestamp();
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      guilds: parsed.guilds ?? {},
      notified: parsed.notified ?? {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read state file:', error);
    await persistState();
  }
}

function persistState() {
  saveQueue = saveQueue
    .then(async () => {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const temp = `${STATE_FILE}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await fs.rename(temp, STATE_FILE);
    })
    .catch((error) => console.error('Failed to persist state:', error));

  return saveQueue;
}

async function fetchSchedule(force = false) {
  const now = Date.now();
  if (!force && sourceCache.events.length && now - sourceCache.fetchedAt < SOURCE_REFRESH_MS) {
    return sourceCache.events;
  }

  try {
    const response = await fetch(`${SOURCE_URL}?t=${now}`, {
      headers: {
        'User-Agent': 'pit-event-notifier/1.0',
        Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Schedule source returned HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Schedule source did not return an array');

    const cleaned = data
      .filter(
        (item) =>
          item &&
          typeof item.event === 'string' &&
          Number.isFinite(item.timestamp) &&
          (item.type === 'major' || item.type === 'minor') &&
          EVENT_BY_NAME.has(item.event),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    sourceCache = { fetchedAt: now, events: cleaned };
    return cleaned;
  } catch (error) {
    if (sourceCache.events.length) {
      console.warn('Using cached schedule after source refresh failed:', error.message);
      return sourceCache.events;
    }
    throw error;
  }
}

async function fetchPanel(guildConfig) {
  const channel = await client.channels.fetch(guildConfig.panelChannelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const message = await channel.messages.fetch(guildConfig.panelMessageId).catch(() => null);
  return message;
}

async function isEventSelected(guildConfig, eventName) {
  const event = EVENT_BY_NAME.get(eventName);
  if (!event || !guildConfig.ownerUserId) return false;

  const panel = await fetchPanel(guildConfig);
  if (!panel) return false;

  const reaction = panel.reactions.cache.find(
    (candidate) => normalizeEmoji(candidate.emoji.name) === normalizeEmoji(event.emoji),
  );

  if (!reaction) return false;

  const users = await reaction.users.fetch();
  return users.has(guildConfig.ownerUserId);
}

async function sendEventNotification(guildId, config, event) {
  const channel = await client.channels.fetch(config.notifyChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  if (!config.ownerUserId) return true;

  const selected = await isEventSelected(config, event.event);
  if (!selected) return true;

  await channel.send({
    content: `<@${config.ownerUserId}>`,
    embeds: [buildNotificationEmbed(event, config.leadMinutes ?? DEFAULT_LEAD_MINUTES)],
    allowedMentions: { users: [config.ownerUserId] },
  });

  return true;
}

function pruneNotified() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [guildId, entries] of Object.entries(state.notified)) {
    for (const [key, timestamp] of Object.entries(entries)) {
      if (timestamp < cutoff) delete entries[key];
    }
    if (!Object.keys(entries).length) delete state.notified[guildId];
  }
}

async function pollNotifications() {
  if (pollRunning) return;
  pollRunning = true;

  try {
    const now = Date.now();
    const schedule = await fetchSchedule();
    let dirty = false;

    for (const [guildId, config] of Object.entries(state.guilds)) {
      const leadMinutes = config.leadMinutes ?? DEFAULT_LEAD_MINUTES;
      const leadMs = leadMinutes * 60_000;
      for (const event of schedule) {
        const until = event.timestamp - now;
        if (until < -60_000) continue;
        if (until > leadMs) break;

        const key = eventKey(event);
        state.notified[guildId] ??= {};
        if (state.notified[guildId][key]) continue;

        try {
          const handled = await sendEventNotification(guildId, config, event);
          if (handled) {
            state.notified[guildId][key] = now;
            dirty = true;
          }
        } catch (error) {
          console.error(`Failed to notify guild ${guildId} about ${key}:`, error);
        }
      }
    }

    const before = JSON.stringify(state.notified);
    pruneNotified();
    if (before !== JSON.stringify(state.notified)) dirty = true;
    if (dirty) await persistState();
  } catch (error) {
    console.error('Notification poll failed:', error);
  } finally {
    pollRunning = false;
  }
}

async function addPanelReactions(message) {
  for (const event of EVENTS) {
    await message.react(event.emoji);
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body: commands });
    console.log(`Registered guild commands for ${devGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Registered global commands');
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadState();
  await fetchSchedule(true).catch((error) => console.warn('Initial schedule fetch failed:', error));
  await pollNotifications();
  setInterval(pollNotifications, POLL_MS);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'pit') return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'setup') {
      const channel = interaction.options.getChannel('channel', true);
      const leadMinutes = interaction.options.getInteger('minutes') ?? DEFAULT_LEAD_MINUTES;

      if (!channel.isTextBased()) {
        await interaction.reply({ content: 'Choose a text-based channel.', ephemeral: true });
        return;
      }

      const permissions = channel.permissionsFor(interaction.guild.members.me);
      const needed = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.ReadMessageHistory,
      ];
      const missing = needed.filter((permission) => !permissions?.has(permission));
      if (missing.length) {
        await interaction.reply({
          content: 'I need View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History in that channel.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const previous = state.guilds[interaction.guildId];
      if (previous?.panelMessageId && previous?.panelChannelId) {
        const previousPanel = await fetchPanel(previous);
        await previousPanel?.delete().catch(() => null);
      }

      const panel = await channel.send({ embeds: [buildPanelEmbed(leadMinutes, interaction.user.id)] });
      await addPanelReactions(panel);

      state.guilds[interaction.guildId] = {
        panelChannelId: channel.id,
        panelMessageId: panel.id,
        notifyChannelId: channel.id,
        leadMinutes,
        ownerUserId: interaction.user.id,
      };
      delete state.notified[interaction.guildId];
      await persistState();

      await interaction.editReply(`Notification panel created in <#${channel.id}>.`);
      return;
    }

    if (subcommand === 'minutes') {
      const value = interaction.options.getInteger('value', true);
      const config = state.guilds[interaction.guildId];
      if (!config) {
        await interaction.reply({ content: 'Run `/pit setup` first.', ephemeral: true });
        return;
      }

      config.leadMinutes = value;
      delete state.notified[interaction.guildId];
      await persistState();

      const panel = await fetchPanel(config);
      if (panel) await panel.edit({ embeds: [buildPanelEmbed(value, config.ownerUserId)] });

      await interaction.reply({ content: `Notifications will now be sent ${value} minute(s) before events.`, ephemeral: true });
      return;
    }

    if (subcommand === 'status') {
      const config = state.guilds[interaction.guildId];
      if (!config) {
        await interaction.reply({ content: 'This server is not configured yet. Run `/pit setup`.', ephemeral: true });
        return;
      }

      await interaction.reply({
        content:
          `Panel: <#${config.panelChannelId}>\n` +
          `Notifications: <#${config.notifyChannelId}>\n` +
          `Lead time: **${config.leadMinutes ?? DEFAULT_LEAD_MINUTES} min**\n` +
          `Mention: <@${config.ownerUserId}>`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'upcoming') {
      const count = interaction.options.getInteger('count') ?? 10;
      await interaction.deferReply({ ephemeral: true });
      const schedule = await fetchSchedule(true);
      const upcoming = schedule.filter((event) => event.timestamp > Date.now() - 30_000).slice(0, count);
      await interaction.editReply({ embeds: [buildUpcomingEmbed(upcoming)] });
      return;
    }

    if (subcommand === 'reset') {
      const config = state.guilds[interaction.guildId];
      if (config) {
        const panel = await fetchPanel(config);
        await panel?.delete().catch(() => null);
        delete state.guilds[interaction.guildId];
        delete state.notified[interaction.guildId];
        await persistState();
      }

      await interaction.reply({ content: 'Pit event notifications have been disabled for this server.', ephemeral: true });
    }
  } catch (error) {
    console.error('Slash command failed:', error);
    const payload = { content: 'Something went wrong while handling that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const guildId = reaction.message.guildId;
  if (!guildId) return;

  const config = state.guilds[guildId];
  if (!config || reaction.message.id !== config.panelMessageId) return;

  const event = EVENT_BY_EMOJI.get(normalizeEmoji(reaction.emoji.name));
  if (!event || user.id !== config.ownerUserId) {
    await reaction.users.remove(user.id).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

await registerCommands();
await client.login(token);
