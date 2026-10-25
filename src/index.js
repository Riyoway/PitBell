import 'dotenv/config';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const SOURCE_URL = 'https://raw.githubusercontent.com/BrookeAFK/brookeafk-api/main/events.js';
const POLL_MS = 20_000;
const SOURCE_REFRESH_MS = 60_000;
const DEFAULT_LEAD = 5;
const STREAM_URL = process.env.STREAM_URL || 'https://www.twitch.tv/hypixel';

const EVENTS = Object.freeze([
  ['Quick Maths', '🧮', 'minor', 15],
  ['Dragon Egg', '🐲', 'minor', 90],
  ['2x Rewards', '2️⃣', 'minor', 240],
  ['Care Package', '📦', 'minor', 30],
  ['KOTL', '🪜', 'minor', 180],
  ['KOTH', '👑', 'minor', 240],
  ['Auction', '💵', 'minor', 30],
  ['Giant Cake', '🍰', 'minor', 120],
  ['All bounty', '🪙', 'minor', 15],
  ['Squads', '🏳️', 'major', 480],
  ['Beast', '🐻', 'major', 480],
  ['Pizza', '🍕', 'major', 480],
  ['Rage Pit', '🥔', 'major', 420],
  ['Spire', '🏯', 'major', 480],
  ['Robbery', '💸', 'major', 420],
  ['Blockhead', '🧱', 'major', 480],
  ['Raffle', '🎟️', 'major', 480],
  ['Team Deathmatch', '🆚', 'major', 480],
].map(([name, emoji, type, durationSeconds]) => ({ name, emoji, type, durationSeconds })));

const byName = new Map(EVENTS.map((event) => [event.name, event]));
const norm = (value) => String(value ?? '').replace(/\uFE0F/g, '');

const command = new SlashCommandBuilder()
  .setName('pit')
  .setDescription('Hypixel Pit event notifications')
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Create or replace your event notification setup')
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Server channel for the panel and notifications'),
      )
      .addIntegerOption((option) =>
        option
          .setName('minutes')
          .setDescription('Notify this many minutes before an event')
          .setMinValue(1)
          .setMaxValue(30),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('minutes')
      .setDescription('Change the notification lead time')
      .addIntegerOption((option) =>
        option
          .setName('value')
          .setDescription('Minutes before the event')
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(true),
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
        option.setName('count').setDescription('Number of events to show').setMinValue(1).setMaxValue(15),
      ),
  )
  .addSubcommand((sub) => sub.setName('reset').setDescription('Remove the current configuration and stop notifications'));

const commandJson = { ...command.toJSON(), integration_types: [0], contexts: [0, 1] };
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

let state = { guilds: {}, users: {}, notified: {} };
let cache = { fetchedAt: 0, events: [] };
let lastPresence = '';
let polling = false;
let saveQueue = Promise.resolve();

const bucketKey = (scope, id) => `${scope}:${id}`;
const eventKey = (event) => `${event.timestamp}:${event.event}`;
const unix = (ms) => Math.floor(ms / 1000);

function selectedNames(config) {
  return Array.isArray(config?.selectedEvents) ? config.selectedEvents.filter((name) => byName.has(name)) : [];
}

function panelEmbed(config) {
  const selected = selectedNames(config);
  const selectedText = selected.length
    ? selected.map((name) => `${byName.get(name)?.emoji ?? '•'} ${name}`).join(', ')
    : '*No events selected yet.*';

  return new EmbedBuilder()
    .setTitle('Hypixel Pit Event Notifications')
    .setDescription(
      `<@${config.ownerUserId}>: choose the events you want from the dropdown below.\n` +
        'Use the buttons for quick selection, pausing, or clearing your subscriptions.',
    )
    .addFields(
      { name: 'Selected Events', value: selectedText },
      { name: 'Reminder', value: `${config.leadMinutes ?? DEFAULT_LEAD} minute(s) before`, inline: true },
      { name: 'Status', value: config.paused ? '⏸️ Paused' : '🟢 Active', inline: true },
    )
    .setFooter({ text: 'Schedule source: brookeafk.com event data' })
    .setTimestamp();
}

function panelComponents(config) {
  const selected = new Set(selectedNames(config));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('pit:events')
    .setPlaceholder(selected.size ? `${selected.size} event(s) selected` : 'Choose Pit events')
    .setMinValues(1)
    .setMaxValues(EVENTS.length)
    .addOptions(
      EVENTS.map((event) => ({
        label: event.name,
        value: event.name,
        emoji: event.emoji,
        description: `${event.type === 'major' ? 'Major' : 'Minor'} event`,
        default: selected.has(event.name),
      })),
    );

  const quickButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pit:minor').setLabel('Minor').setEmoji('🔹').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pit:major').setLabel('Major').setEmoji('🔸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pit:all').setLabel('All').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pit:clear').setLabel('Clear').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('pit:toggle')
      .setLabel(config.paused ? 'Resume' : 'Pause')
      .setEmoji(config.paused ? '▶️' : '⏸️')
      .setStyle(config.paused ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder().addComponents(menu), quickButtons];
}

function notificationEmbed(event, minutes) {
  const meta = byName.get(event.event);
  const starts = unix(event.timestamp);

  return new EmbedBuilder()
    .setTitle(`${meta?.emoji ?? '🔔'} ${event.event}`)
    .setDescription(`A **${event.type.toUpperCase()}** event is starting soon.`)
    .addFields(
      { name: 'Starts', value: `<t:${starts}:R>`, inline: true },
      { name: 'Time', value: `<t:${starts}:t>`, inline: true },
      { name: 'Reminder', value: `${minutes} min before`, inline: true },
    )
    .setTimestamp(event.timestamp);
}

function upcomingEmbed(events) {
  const body = events
    .map((event) => {
      const meta = byName.get(event.event);
      return `${meta?.emoji ?? '•'} **${event.event}** · ${event.type === 'major' ? 'Major' : 'Minor'} · <t:${unix(event.timestamp)}:R>`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle('Upcoming Hypixel Pit Events')
    .setDescription(body || 'No upcoming events were returned by the source.')
    .setFooter({ text: 'Source: brookeafk.com event data' })
    .setTimestamp();
}

function currentEvent(schedule, now = Date.now()) {
  for (let index = schedule.length - 1; index >= 0; index--) {
    const event = schedule[index];
    if (event.timestamp > now) continue;
    const duration = (byName.get(event.event)?.durationSeconds ?? 0) * 1000;
    return duration && now < event.timestamp + duration ? event : null;
  }
  return null;
}

function updatePresence(schedule) {
  if (!client.user) return;

  const now = Date.now();
  const current = currentEvent(schedule, now);
  let key;
  let name;

  if (current) {
    const meta = byName.get(current.event);
    key = `current:${current.timestamp}:${current.event}`;
    name = `${meta?.emoji ?? '🔴'} ${current.event} · ${current.type === 'major' ? 'Major' : 'Minor'}`;
  } else {
    const next = schedule.find((event) => event.timestamp > now);
    if (next) {
      const minutes = Math.max(1, Math.ceil((next.timestamp - now) / 60_000));
      const meta = byName.get(next.event);
      key = `next:${next.timestamp}:${minutes}`;
      name = `⏳ Next: ${meta?.emoji ?? ''} ${next.event} in ${minutes}m`.trim();
    } else {
      key = 'idle';
      name = '⏳ Waiting for Pit events';
    }
  }

  if (key === lastPresence) return;

  client.user.setPresence({
    status: 'online',
    activities: [{ name, type: ActivityType.Streaming, url: STREAM_URL }],
  });
  lastPresence = key;
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
    await persist();
  }
}

function persist() {
  saveQueue = saveQueue
    .then(async () => {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const temp = `${STATE_FILE}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
      await fs.rename(temp, STATE_FILE);
    })
    .catch((error) => console.error('Failed to persist state:', error));

  return saveQueue;
}

async function schedule(force = false) {
  const now = Date.now();
  if (!force && cache.events.length && now - cache.fetchedAt < SOURCE_REFRESH_MS) return cache.events;

  try {
    const response = await fetch(`${SOURCE_URL}?t=${now}`, {
      headers: { 'User-Agent': 'pit-event-notifier/1.3', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) throw new Error(`Schedule source returned HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Schedule source did not return an array');

    const events = data
      .filter(
        (event) =>
          event &&
          typeof event.event === 'string' &&
          Number.isFinite(event.timestamp) &&
          (event.type === 'major' || event.type === 'minor') &&
          byName.has(event.event),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    cache = { fetchedAt: now, events };
    return events;
  } catch (error) {
    if (cache.events.length) {
      console.warn('Using cached schedule:', error.message);
      return cache.events;
    }
    throw error;
  }
}

async function panel(config) {
  let channel = await client.channels.fetch(config.panelChannelId).catch(() => null);

  if (!channel && config.mode === 'dm') {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }

  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(config.panelMessageId).catch(() => null);
}

function selected(config, eventName) {
  return selectedNames(config).includes(eventName);
}

async function notify(scope, config, event) {
  if (!selected(config, event.event)) return true;

  let channel;
  if (scope === 'guild') {
    channel = await client.channels.fetch(config.notifyChannelId).catch(() => null);
  } else {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }

  if (!channel?.isTextBased()) return false;

  await channel.send({
    content: `<@${config.ownerUserId}>`,
    embeds: [notificationEmbed(event, config.leadMinutes ?? DEFAULT_LEAD)],
    allowedMentions: { users: [config.ownerUserId] },
  });
  return true;
}

async function processTarget(scope, id, config, events, now) {
  if (config.paused) return false;

  const lead = (config.leadMinutes ?? DEFAULT_LEAD) * 60_000;
  const bucket = bucketKey(scope, id);
  let dirty = false;

  for (const event of events) {
    const reminderAt = event.timestamp - lead;
    if (event.timestamp < now - 60_000) continue;
    if (reminderAt > now) break;
    if (config.resumeAt && reminderAt < config.resumeAt) continue;

    state.notified[bucket] ??= {};
    const key = eventKey(event);
    if (state.notified[bucket][key]) continue;

    try {
      if (await notify(scope, config, event)) {
        state.notified[bucket][key] = now;
        dirty = true;
      }
    } catch (error) {
      console.error(`Failed to notify ${scope} ${id} about ${key}:`, error);
    }
  }

  return dirty;
}

function prune() {
  const cutoff = Date.now() - 86_400_000;
  for (const [bucket, entries] of Object.entries(state.notified)) {
    for (const [key, sentAt] of Object.entries(entries)) {
      if (sentAt < cutoff) delete entries[key];
    }
    if (!Object.keys(entries).length) delete state.notified[bucket];
  }
}

async function poll() {
  if (polling) return;
  polling = true;

  try {
    const now = Date.now();
    const events = await schedule();
    updatePresence(events);
    let dirty = false;

    for (const [id, config] of Object.entries(state.guilds)) {
      dirty = (await processTarget('guild', id, config, events, now)) || dirty;
    }
    for (const [id, config] of Object.entries(state.users)) {
      dirty = (await processTarget('dm', id, config, events, now)) || dirty;
    }

    const before = JSON.stringify(state.notified);
    prune();
    if (before !== JSON.stringify(state.notified)) dirty = true;
    if (dirty) await persist();
  } catch (error) {
    console.error('Notification poll failed:', error);
  } finally {
    polling = false;
  }
}

function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function findComponentConfig(interaction) {
  if (interaction.inGuild()) {
    return { config: state.guilds[interaction.guildId] };
  }
  return { config: state.users[interaction.user.id] };
}

async function refreshPanelMessage(config, message = null) {
  const target = message ?? (await panel(config));
  if (!target) return;
  await target.edit({ embeds: [panelEmbed(config)], components: panelComponents(config) });
}

async function migrateLegacyConfig(scope, id, config) {
  if (Array.isArray(config.selectedEvents)) return false;

  const oldPanel = await panel(config);
  const selectedEvents = [];

  if (oldPanel) {
    for (const event of EVENTS) {
      const reaction = oldPanel.reactions.cache.find((item) => norm(item.emoji.name) === norm(event.emoji));
      if (!reaction) continue;
      const users = await reaction.users.fetch().catch(() => null);
      if (users?.has(config.ownerUserId)) selectedEvents.push(event.name);
    }
  }

  config.selectedEvents = selectedEvents;

  if (oldPanel?.channel?.isTextBased()) {
    const newPanel = await oldPanel.channel.send({
      embeds: [panelEmbed(config)],
      components: panelComponents(config),
    });
    config.panelMessageId = newPanel.id;
    config.panelChannelId = newPanel.channel.id;
    await oldPanel.delete().catch(() => null);
  }

  console.log(`Migrated ${scope} ${id} from reactions to components (${selectedEvents.length} selections)`);
  return true;
}

async function migrateLegacyPanels() {
  let dirty = false;

  for (const [id, config] of Object.entries(state.guilds)) {
    dirty = (await migrateLegacyConfig('guild', id, config)) || dirty;
  }
  for (const [id, config] of Object.entries(state.users)) {
    dirty = (await migrateLegacyConfig('dm', id, config)) || dirty;
  }

  if (dirty) await persist();
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadState();
  await migrateLegacyPanels();

  const events = await schedule(true).catch((error) => {
    console.warn('Initial schedule fetch failed:', error.message);
    return [];
  });

  updatePresence(events);
  await poll();
  setInterval(poll, POLL_MS);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isStringSelectMenu() && interaction.customId === 'pit:events') {
    const { config } = findComponentConfig(interaction);
    if (!config || interaction.message.id !== config.panelMessageId) return;

    if (interaction.user.id !== config.ownerUserId) {
      await interaction.reply({ content: `This setup belongs to <@${config.ownerUserId}>.`, ephemeral: true });
      return;
    }

    config.selectedEvents = interaction.values.filter((name) => byName.has(name));
    await persist();
    await interaction.update({ embeds: [panelEmbed(config)], components: panelComponents(config) });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('pit:')) {
    const { config } = findComponentConfig(interaction);
    if (!config || interaction.message.id !== config.panelMessageId) return;

    if (interaction.user.id !== config.ownerUserId) {
      await interaction.reply({ content: `This setup belongs to <@${config.ownerUserId}>.`, ephemeral: true });
      return;
    }

    if (interaction.customId === 'pit:minor') {
      config.selectedEvents = EVENTS.filter((event) => event.type === 'minor').map((event) => event.name);
    } else if (interaction.customId === 'pit:major') {
      config.selectedEvents = EVENTS.filter((event) => event.type === 'major').map((event) => event.name);
    } else if (interaction.customId === 'pit:all') {
      config.selectedEvents = EVENTS.map((event) => event.name);
    } else if (interaction.customId === 'pit:clear') {
      config.selectedEvents = [];
    } else if (interaction.customId === 'pit:toggle') {
      if (config.paused) {
        config.paused = false;
        config.resumeAt = Date.now();
        delete config.pausedAt;
      } else {
        config.paused = true;
        config.pausedAt = Date.now();
      }
    }

    await persist();
    await interaction.update({ embeds: [panelEmbed(config)], components: panelComponents(config) });
    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== 'pit') return;

  const subcommand = interaction.options.getSubcommand();
  const inGuild = interaction.inGuild();

  if (inGuild && subcommand !== 'upcoming' && !canManage(interaction)) {
    await interaction.reply({ content: 'You need **Manage Server** to change Pit notification settings.', ephemeral: true });
    return;
  }

  const store = inGuild ? state.guilds : state.users;
  const id = inGuild ? interaction.guildId : interaction.user.id;
  const bucket = bucketKey(inGuild ? 'guild' : 'dm', id);

  try {
    if (subcommand === 'setup') {
      const minutes = interaction.options.getInteger('minutes') ?? DEFAULT_LEAD;
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
          PermissionFlagsBits.ReadMessageHistory,
        ];

        if (needed.some((permission) => !permissions?.has(permission))) {
          await interaction.reply({
            content: 'I need View Channel, Send Messages, Embed Links, and Read Message History in that channel.',
            ephemeral: true,
          });
          return;
        }
      } else if (!channel?.isTextBased()) {
        await interaction.reply('This DM channel is unavailable.');
        return;
      }

      await interaction.deferReply({ ephemeral: inGuild });

      if (store[id]?.panelMessageId) {
        await (await panel(store[id]))?.delete().catch(() => null);
      }

      const config = {
        mode: inGuild ? 'guild' : 'dm',
        panelChannelId: channel.id,
        panelMessageId: null,
        notifyChannelId: inGuild ? channel.id : null,
        leadMinutes: minutes,
        ownerUserId: interaction.user.id,
        selectedEvents: [],
        paused: false,
        resumeAt: null,
      };

      const message = await channel.send({
        embeds: [panelEmbed(config)],
        components: panelComponents(config),
      });

      config.panelMessageId = message.id;
      store[id] = config;
      delete state.notified[bucket];
      await persist();

      await interaction.editReply(
        inGuild
          ? `Notification panel created in <#${channel.id}>.`
          : 'DM notifications are configured. Choose your events from the dropdown above.',
      );
      return;
    }

    if (subcommand === 'upcoming') {
      const count = interaction.options.getInteger('count') ?? 10;
      await interaction.deferReply({ ephemeral: inGuild });
      const events = (await schedule(true)).filter((event) => event.timestamp > Date.now() - 30_000).slice(0, count);
      await interaction.editReply({ embeds: [upcomingEmbed(events)] });
      return;
    }

    const config = store[id];
    if (!config) {
      await interaction.reply({ content: 'Run `/pit setup` first.', ephemeral: inGuild });
      return;
    }

    if (!Array.isArray(config.selectedEvents)) config.selectedEvents = [];

    if (subcommand === 'minutes') {
      const value = interaction.options.getInteger('value', true);
      config.leadMinutes = value;
      delete state.notified[bucket];
      await persist();
      await refreshPanelMessage(config);
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
      await persist();
      await refreshPanelMessage(config);
      await interaction.reply({ content: 'Notifications are paused. Your settings are still saved.', ephemeral: inGuild });
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
      await persist();
      await refreshPanelMessage(config);
      await interaction.reply({
        content: 'Notifications are active again. Your previous settings have been kept.',
        ephemeral: inGuild,
      });
      return;
    }

    if (subcommand === 'status') {
      const selected = selectedNames(config);
      const text = inGuild
        ? `Status: **${config.paused ? 'Paused' : 'Active'}**\nPanel: <#${config.panelChannelId}>\nNotifications: <#${config.notifyChannelId}>\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nSelected events: **${selected.length}**\nMention: <@${config.ownerUserId}>`
        : `Status: **${config.paused ? 'Paused' : 'Active'}**\nDelivery: **Direct Message**\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nSelected events: **${selected.length}**\nMention: <@${config.ownerUserId}>`;

      await interaction.reply({ content: text, ephemeral: inGuild });
      return;
    }

    if (subcommand === 'reset') {
      await (await panel(config))?.delete().catch(() => null);
      delete store[id];
      delete state.notified[bucket];
      await persist();
      await interaction.reply({
        content: inGuild
          ? 'Pit event notifications have been disabled for this server.'
          : 'Pit event DM notifications have been disabled for you.',
        ephemeral: inGuild,
      });
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    const payload = { content: 'Something went wrong while handling that interaction.', ephemeral: inGuild };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [commandJson] });
console.log('Registered global /pit command for guilds and bot DMs');
await client.login(token);