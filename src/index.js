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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../data/state.json');
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

const command = new SlashCommandBuilder()
  .setName('pit')
  .setDescription('Hypixel Pit event notifications')
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Create or replace your event notification setup')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Server channel for the panel and notifications')
          .setRequired(false),
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
      .setDescription('Change the notification lead time')
      .addIntegerOption((option) =>
        option.setName('value').setDescription('Minutes before the event').setMinValue(1).setMaxValue(30).setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('pause').setDescription('Pause notifications without deleting your settings'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Resume notifications with your saved settings'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the current notification configuration'))
  .addSubcommand((sub) =>
    sub
      .setName('upcoming')
      .setDescription('Show upcoming Pit events')
      .addIntegerOption((option) =>
        option.setName('count').setDescription('Number of events to show').setMinValue(1).setMaxValue(15).setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('reset').setDescription('Remove the current configuration and stop notifications'));

const commandJson = {
  ...command.toJSON(),
  integration_types: [0], // Guild Install
  contexts: [0, 1], // Guild + Bot DM
};

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let state = { guilds: {}, users: {}, notified: {} };
let scheduleCache = { fetchedAt: 0, events: [] };
let pollRunning = false;
let saveQueue = Promise.resolve();

function normalizeEmoji(value) {
  return String(value ?? '').replace(/\uFE0F/g, '');
}

function targetKey(scope, id) {
  return `${scope}:${id}`;
}

function eventKey(event) {
  return `${event.timestamp}:${event.event}`;
}

function toUnix(ms) {
  return Math.floor(ms / 1000);
}

function buildPanelEmbed(leadMinutes, ownerUserId) {
  const list = (type) =>
    EVENTS.filter((event) => event.type === type)
      .map((event) => `${event.emoji} **${event.name}**`)
      .join('\n');

  return new EmbedBuilder()
    .setTitle('Hypixel Pit Event Notifications')
    .setDescription(
      `<@${ownerUserId}>: react to the events you want to be notified about.\n` +
        `Remove a reaction to unsubscribe. Reminders are sent **${leadMinutes} minute(s) before** the event.`,
    )
    .addFields(
      { name: 'Minor Events', value: list('minor'), inline: true },
      { name: 'Major Events', value: list('major'), inline: true },
    )
    .setFooter({ text: 'Schedule source: brookeafk.com event data' })
    .setTimestamp();
}

function buildNotificationEmbed(event, leadMinutes) {
  const meta = EVENT_BY_NAME.get(event.event);
  const starts = toUnix(event.timestamp);
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
    const starts = toUnix(event.timestamp);
    return `${meta?.emoji ?? '•'} **${event.event}** · ${event.type === 'major' ? 'Major' : 'Minor'} · <t:${starts}:R>`;
  });

  return new EmbedBuilder()
    .setTitle('Upcoming Hypixel Pit Events')
    .setDescription(lines.join('\n') || 'No upcoming events were returned by the source.')
    .setFooter({ text: 'Source: brookeafk.com event data' })
    .setTimestamp();
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    state = {
      guilds: parsed.guilds ?? {},
      users: parsed.users ?? {},
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
  if (!force && scheduleCache.events.length && now - scheduleCache.fetchedAt < SOURCE_REFRESH_MS) {
    return scheduleCache.events;
  }

  try {
    const response = await fetch(`${SOURCE_URL}?t=${now}`, {
      headers: { 'User-Agent': 'pit-event-notifier/1.1', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Schedule source returned HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Schedule source did not return an array');

    const events = data
      .filter(
        (item) =>
          item &&
          typeof item.event === 'string' &&
          Number.isFinite(item.timestamp) &&
          (item.type === 'major' || item.type === 'minor') &&
          EVENT_BY_NAME.has(item.event),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    scheduleCache = { fetchedAt: now, events };
    return events;
  } catch (error) {
    if (scheduleCache.events.length) {
      console.warn('Using cached schedule:', error.message);
      return scheduleCache.events;
    }
    throw error;
  }
}

async function fetchPanel(config) {
  let channel = await client.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel && config.mode === 'dm') {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(config.panelMessageId).catch(() => null);
}

async function isSelected(config, eventName) {
  const meta = EVENT_BY_NAME.get(eventName);
  if (!meta || !config.ownerUserId) return false;

  const panel = await fetchPanel(config);
  if (!panel) return false;

  const reaction = panel.reactions.cache.find(
    (item) => normalizeEmoji(item.emoji.name) === normalizeEmoji(meta.emoji),
  );
  if (!reaction) return false;

  const users = await reaction.users.fetch();
  return users.has(config.ownerUserId);
}

async function sendNotification(scope, config, event) {
  if (!(await isSelected(config, event.event))) return true;

  let channel = null;
  if (scope === 'guild') {
    channel = await client.channels.fetch(config.notifyChannelId).catch(() => null);
  } else {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }

  if (!channel?.isTextBased()) return false;

  await channel.send({
    content: `<@${config.ownerUserId}>`,
    embeds: [buildNotificationEmbed(event, config.leadMinutes ?? DEFAULT_LEAD_MINUTES)],
    allowedMentions: { users: [config.ownerUserId] },
  });
  return true;
}

function pruneNotified() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [bucket, entries] of Object.entries(state.notified)) {
    for (const [key, sentAt] of Object.entries(entries)) {
      if (sentAt < cutoff) delete entries[key];
    }
    if (!Object.keys(entries).length) delete state.notified[bucket];
  }
}

async function processTarget(scope, id, config, schedule, now) {
  if (config.paused) return false;

  const leadMs = (config.leadMinutes ?? DEFAULT_LEAD_MINUTES) * 60_000;
  const bucket = targetKey(scope, id);
  let dirty = false;

  for (const event of schedule) {
    const reminderAt = event.timestamp - leadMs;
    if (event.timestamp < now - 60_000) continue;
    if (reminderAt > now) break;
    if (config.resumeAt && reminderAt < config.resumeAt) continue;

    const key = eventKey(event);
    state.notified[bucket] ??= {};
    if (state.notified[bucket][key]) continue;

    try {
      if (await sendNotification(scope, config, event)) {
        state.notified[bucket][key] = now;
        dirty = true;
      }
    } catch (error) {
      console.error(`Failed to notify ${scope} ${id} about ${key}:`, error);
    }
  }

  return dirty;
}

async function pollNotifications() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const now = Date.now();
    const schedule = await fetchSchedule();
    let dirty = false;

    for (const [guildId, config] of Object.entries(state.guilds)) {
      if (await processTarget('guild', guildId, config, schedule, now)) dirty = true;
    }
    for (const [userId, config] of Object.entries(state.users)) {
      if (await processTarget('dm', userId, config, schedule, now)) dirty = true;
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
  for (const event of EVENTS) await message.react(event.emoji);
}

function canManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function requireGuildManager(interaction, subcommand) {
  if (!interaction.inGuild() || subcommand === 'upcoming') return true;
  if (canManageGuild(interaction)) return true;
  await interaction.reply({ content: 'You need **Manage Server** to change Pit notification settings.', ephemeral: true });
  return false;
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: [commandJson] });
  console.log('Registered global /pit command for guilds and bot DMs');
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadState();
  await fetchSchedule(true).catch((error) => console.warn('Initial schedule fetch failed:', error.message));
  await pollNotifications();
  setInterval(pollNotifications, POLL_MS);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'pit') return;

  const subcommand = interaction.options.getSubcommand();
  if (!(await requireGuildManager(interaction, subcommand))) return;

  const inGuild = interaction.inGuild();
  const store = inGuild ? state.guilds : state.users;
  const id = inGuild ? interaction.guildId : interaction.user.id;
  const bucket = targetKey(inGuild ? 'guild' : 'dm', id);

  try {
    if (subcommand === 'setup') {
      const leadMinutes = interaction.options.getInteger('minutes') ?? DEFAULT_LEAD_MINUTES;
      let channel = interaction.channel;

      if (inGuild) {
        channel = interaction.options.getChannel('channel') ?? interaction.channel;
        if (!channel?.isTextBased()) {
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
        if (needed.some((permission) => !permissions?.has(permission))) {
          await interaction.reply({
            content: 'I need View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History in that channel.',
            ephemeral: true,
          });
          return;
        }
      } else if (!channel?.isTextBased()) {
        await interaction.reply({ content: 'This DM channel is unavailable.' });
        return;
      }

      await interaction.deferReply({ ephemeral: inGuild });

      const previous = store[id];
      if (previous?.panelMessageId) {
        const previousPanel = await fetchPanel(previous);
        await previousPanel?.delete().catch(() => null);
      }

      const panel = await channel.send({ embeds: [buildPanelEmbed(leadMinutes, interaction.user.id)] });
      await addPanelReactions(panel);

      store[id] = {
        mode: inGuild ? 'guild' : 'dm',
        panelChannelId: channel.id,
        panelMessageId: panel.id,
        notifyChannelId: inGuild ? channel.id : null,
        leadMinutes,
        ownerUserId: interaction.user.id,
        paused: false,
        resumeAt: null,
      };
      delete state.notified[bucket];
      await persistState();

      await interaction.editReply(
        inGuild
          ? `Notification panel created in <#${channel.id}>.`
          : 'DM notifications are configured. React to the event emojis in the panel above.',
      );
      return;
    }

    if (subcommand === 'upcoming') {
      const count = interaction.options.getInteger('count') ?? 10;
      await interaction.deferReply({ ephemeral: inGuild });
      const schedule = await fetchSchedule(true);
      const upcoming = schedule.filter((event) => event.timestamp > Date.now() - 30_000).slice(0, count);
      await interaction.editReply({ embeds: [buildUpcomingEmbed(upcoming)] });
      return;
    }

    const config = store[id];
    if (!config) {
      await interaction.reply({ content: 'Run `/pit setup` first.', ephemeral: inGuild });
      return;
    }

    if (subcommand === 'minutes') {
      const value = interaction.options.getInteger('value', true);
      config.leadMinutes = value;
      delete state.notified[bucket];
      await persistState();

      const panel = await fetchPanel(config);
      if (panel) await panel.edit({ embeds: [buildPanelEmbed(value, config.ownerUserId)] });

      await interaction.reply({
        content: `Notifications will now be sent ${value} minute(s) before events.`,
        ephemeral: inGuild,
      });
      return;
    }

    if (subcommand === 'pause') {
      if (config.paused) {
        await interaction.reply({ content: 'Pit event notifications are already paused.', ephemeral: inGuild });
        return;
      }
      config.paused = true;
      config.pausedAt = Date.now();
      await persistState();
      await interaction.reply({
        content: 'Notifications are paused. Your event selections and reminder settings are still saved.',
        ephemeral: inGuild,
      });
      return;
    }

    if (subcommand === 'resume') {
      if (!config.paused) {
        await interaction.reply({ content: 'Pit event notifications are already active.', ephemeral: inGuild });
        return;
      }
      config.paused = false;
      config.resumeAt = Date.now();
      delete config.pausedAt;
      await persistState();
      await interaction.reply({
        content: 'Notifications are active again. Your previous settings have been kept.',
        ephemeral: inGuild,
      });
      return;
    }

    if (subcommand === 'status') {
      await interaction.reply({
        content: inGuild
          ? `Status: **${config.paused ? 'Paused' : 'Active'}**\nPanel: <#${config.panelChannelId}>\nNotifications: <#${config.notifyChannelId}>\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD_MINUTES} min**\nMention: <@${config.ownerUserId}>`
          : `Status: **${config.paused ? 'Paused' : 'Active'}**\nDelivery: **Direct Message**\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD_MINUTES} min**\nMention: <@${config.ownerUserId}>`,
        ephemeral: inGuild,
      });
      return;
    }

    if (subcommand === 'reset') {
      const panel = await fetchPanel(config);
      await panel?.delete().catch(() => null);
      delete store[id];
      delete state.notified[bucket];
      await persistState();
      await interaction.reply({
        content: inGuild
          ? 'Pit event notifications have been disabled for this server.'
          : 'Pit event DM notifications have been disabled for you.',
        ephemeral: inGuild,
      });
    }
  } catch (error) {
    console.error('Slash command failed:', error);
    const payload = { content: 'Something went wrong while handling that command.', ephemeral: inGuild };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);

  const config = reaction.message.guildId ? state.guilds[reaction.message.guildId] : state.users[user.id];
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
