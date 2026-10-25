import 'dotenv/config';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
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
const PANEL_TIMEOUT_MINUTES = Math.max(1, Number.parseInt(process.env.PANEL_TIMEOUT_MINUTES ?? '15', 10) || 15);
const PANEL_TIMEOUT_MS = PANEL_TIMEOUT_MINUTES * 60_000;
const DISCORD_EPOCH = 1420070400000n;

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

const command = new SlashCommandBuilder()
  .setName('pit')
  .setDescription('Hypixel Pit event notifications')
  .addSubcommand((sub) => sub.setName('help').setDescription('Show how to set up server and DM notifications'))
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Create or refresh the notification control panel')
      .addChannelOption((option) => option.setName('channel').setDescription('Server channel for the panel and notifications'))
      .addIntegerOption((option) =>
        option.setName('minutes').setDescription('Notify this many minutes before an event').setMinValue(1).setMaxValue(30),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('dm')
      .setDescription('Set up your personal event notifications in DM')
      .addIntegerOption((option) =>
        option.setName('minutes').setDescription('Notify this many minutes before an event').setMinValue(1).setMaxValue(30),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('minutes')
      .setDescription('Change the notification lead time for this setup')
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
      .addIntegerOption((option) => option.setName('count').setDescription('Number of events to show').setMinValue(1).setMaxValue(15)),
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
let scheduleCache = { fetchedAt: 0, events: [] };
let lastPresenceKey = '';
let pollRunning = false;
let saveQueue = Promise.resolve();

const bucketKey = (scope, id) => `${scope}:${id}`;
const eventKey = (event) => `${event.timestamp}:${event.event}`;
const toUnix = (ms) => Math.floor(ms / 1000);

function errorId() {
  return `PIT-${Date.now().toString(36).slice(-6).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function snowflakeTimestamp(id) {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

function selectedNames(config) {
  return Array.isArray(config?.selectedEvents) ? config.selectedEvents.filter((name) => byName.has(name)) : [];
}

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('PitBell Help')
    .setDescription('Choose whether you want notifications in a server channel or privately in DM.')
    .addFields(
      {
        name: '🏠 Server notifications',
        value:
          'A server manager runs `/pit setup` in the server.\n' +
          'Optionally choose `channel` and `minutes`. The setup panel appears in that channel.',
      },
      {
        name: '💬 Personal DM notifications',
        value:
          'Run `/pit dm` from any server where PitBell is installed. PitBell will send your private setup panel in DM.\n' +
          'You can also open a DM with PitBell and run `/pit setup` there.',
      },
      {
        name: '🎛️ Selecting events',
        value:
          'Use the dropdown to pick individual events, or the **Minor**, **Major**, **All**, and **Clear** buttons. ' +
          'Use **Pause / Resume** to keep your settings without receiving reminders.',
      },
      {
        name: '⌨️ Commands',
        value:
          '`/pit help` — this guide\n' +
          '`/pit setup` — server setup, or DM setup when used inside DM\n' +
          '`/pit dm` — open your personal DM setup\n' +
          '`/pit upcoming` — upcoming events\n' +
          '`/pit status` — current settings\n' +
          '`/pit minutes` — reminder lead time\n' +
          '`/pit pause` / `/pit resume` — temporarily stop/start reminders\n' +
          '`/pit reset` — delete the current setup',
      },
    )
    .setFooter({ text: 'Server settings require Manage Server. Personal DM settings belong only to you.' });
}

function panelEmbed(config) {
  const selected = selectedNames(config);
  const selectedText = selected.length
    ? selected.map((name) => `${byName.get(name)?.emoji ?? '•'} ${name}`).join(', ')
    : '*No events selected yet.*';

  return new EmbedBuilder()
    .setTitle(config.mode === 'dm' ? 'PitBell · Personal DM Notifications' : 'Hypixel Pit Event Notifications')
    .setDescription(
      `<@${config.ownerUserId}>: choose the events you want from the dropdown below.\n` +
        'Use the buttons for quick selection, pausing, or clearing your subscriptions.',
    )
    .addFields(
      { name: 'Selected Events', value: selectedText },
      { name: 'Reminder', value: `${config.leadMinutes ?? DEFAULT_LEAD} minute(s) before`, inline: true },
      { name: 'Status', value: config.paused ? '⏸️ Paused' : '🟢 Active', inline: true },
      { name: 'Delivery', value: config.mode === 'dm' ? '💬 Direct Message' : '🏠 Server channel', inline: true },
    )
    .setFooter({ text: `Controls expire after ${PANEL_TIMEOUT_MINUTES} minutes · Schedule source: brookeafk.com` })
    .setTimestamp();
}

function expiredPanelEmbed(config) {
  const selected = selectedNames(config);
  return new EmbedBuilder()
    .setTitle(config.mode === 'dm' ? 'PitBell · Personal DM Notifications' : 'Hypixel Pit Event Notifications')
    .setDescription(
      '⌛ **This setup panel has expired.**\n\n' +
        'Your selected events, reminder time, and notification state are still saved. ' +
        `Run ${config.mode === 'dm' ? '`/pit dm` or `/pit setup` in this DM' : '`/pit setup`'} to open a fresh control panel.`,
    )
    .addFields(
      { name: 'Selected Events', value: selected.length ? `${selected.length} selected` : 'None', inline: true },
      { name: 'Reminder', value: `${config.leadMinutes ?? DEFAULT_LEAD} min before`, inline: true },
      { name: 'Status', value: config.paused ? '⏸️ Paused' : '🟢 Active', inline: true },
    )
    .setFooter({ text: `Panel expired after ${PANEL_TIMEOUT_MINUTES} minutes` })
    .setTimestamp();
}

function panelComponents(config) {
  const selected = new Set(selectedNames(config));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('pit:events')
    .setPlaceholder(selected.size ? `${selected.size} event(s) selected` : 'Choose Pit events')
    .setMinValues(0)
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

  const buttons = new ActionRowBuilder().addComponents(
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

  return [new ActionRowBuilder().addComponents(menu), buttons];
}

function notificationEmbed(event, minutes) {
  const meta = byName.get(event.event);
  const starts = toUnix(event.timestamp);
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
      return `${meta?.emoji ?? '•'} **${event.event}** · ${event.type === 'major' ? 'Major' : 'Minor'} · <t:${toUnix(event.timestamp)}:R>`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle('Upcoming Hypixel Pit Events')
    .setDescription(body || 'No upcoming events were returned by the schedule source.')
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

  if (key === lastPresenceKey) return;
  client.user.setPresence({ status: 'online', activities: [{ name, type: ActivityType.Streaming, url: STREAM_URL }] });
  lastPresenceKey = key;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    state = { guilds: parsed.guilds ?? {}, users: parsed.users ?? {}, notified: parsed.notified ?? {} };
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

function normalizeStoredState() {
  let dirty = false;
  for (const config of [...Object.values(state.guilds), ...Object.values(state.users)]) {
    if (!Array.isArray(config.selectedEvents)) {
      config.selectedEvents = [];
      dirty = true;
    }
    if (!config.panelCreatedAt && config.panelMessageId) {
      config.panelCreatedAt = snowflakeTimestamp(config.panelMessageId) ?? Date.now();
      dirty = true;
    }
    if (config.panelExpiredAt === undefined) {
      config.panelExpiredAt = null;
      dirty = true;
    }
  }
  return dirty;
}

async function fetchSchedule(force = false) {
  const now = Date.now();
  if (!force && scheduleCache.events.length && now - scheduleCache.fetchedAt < SOURCE_REFRESH_MS) return scheduleCache.events;

  try {
    const response = await fetch(`${SOURCE_URL}?t=${now}`, {
      headers: { 'User-Agent': 'pit-event-notifier/1.6', 'Cache-Control': 'no-cache' },
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

async function getPanel(config) {
  if (!config?.panelMessageId || !config?.panelChannelId) return null;
  let channel = await client.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel && config.mode === 'dm') {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(config.panelMessageId).catch(() => null);
}

async function refreshPanel(config, message = null) {
  if (config.panelExpiredAt) return;
  const target = message ?? (await getPanel(config));
  if (!target) return;
  await target.edit({ embeds: [panelEmbed(config)], components: panelComponents(config) });
}

async function expirePanel(config) {
  if (!config?.panelMessageId || config.panelExpiredAt) return false;
  const createdAt = config.panelCreatedAt ?? snowflakeTimestamp(config.panelMessageId);
  if (!createdAt || Date.now() - createdAt < PANEL_TIMEOUT_MS) return false;

  const message = await getPanel(config);
  if (message) {
    await message.edit({ embeds: [expiredPanelEmbed(config)], components: [] }).catch((error) =>
      console.warn(`Could not expire panel ${config.panelMessageId}:`, error.message),
    );
  }
  config.panelExpiredAt = Date.now();
  return true;
}

async function expirePanels() {
  let dirty = false;
  for (const config of Object.values(state.guilds)) dirty = (await expirePanel(config)) || dirty;
  for (const config of Object.values(state.users)) dirty = (await expirePanel(config)) || dirty;
  if (dirty) await persistState();
}

async function sendNotification(scope, config, event) {
  if (!selectedNames(config).includes(event.event)) return true;
  let channel;

  if (scope === 'guild') channel = await client.channels.fetch(config.notifyChannelId).catch(() => null);
  else {
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

function pruneNotified() {
  const cutoff = Date.now() - 86_400_000;
  for (const [bucket, entries] of Object.entries(state.notified)) {
    for (const [key, sentAt] of Object.entries(entries)) if (sentAt < cutoff) delete entries[key];
    if (!Object.keys(entries).length) delete state.notified[bucket];
  }
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const now = Date.now();
    const events = await fetchSchedule();
    updatePresence(events);
    let dirty = false;

    for (const [id, config] of Object.entries(state.guilds)) dirty = (await processTarget('guild', id, config, events, now)) || dirty;
    for (const [id, config] of Object.entries(state.users)) dirty = (await processTarget('dm', id, config, events, now)) || dirty;

    const before = JSON.stringify(state.notified);
    pruneNotified();
    if (before !== JSON.stringify(state.notified)) dirty = true;
    if (dirty) await persistState();
    await expirePanels();
  } catch (error) {
    console.error('Notification poll failed:', error);
  } finally {
    pollRunning = false;
  }
}

function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function configForComponent(interaction) {
  return interaction.inGuild() ? state.guilds[interaction.guildId] : state.users[interaction.user.id];
}

function currentStoreAndId(interaction) {
  if (interaction.inGuild()) return { store: state.guilds, id: interaction.guildId, scope: 'guild' };
  return { store: state.users, id: interaction.user.id, scope: 'dm' };
}

async function acknowledgeCommand(interaction) {
  if (interaction.inGuild()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferReply();
}

async function createServerSetup(interaction, minutes) {
  const id = interaction.guildId;
  const previous = state.guilds[id];
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;

  if (!channel?.isTextBased()) throw new Error('Selected channel is not text-based.');
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
  if (needed.some((permission) => !permissions?.has(permission))) {
    const error = new Error('Missing required permissions in the selected channel.');
    error.userMessage = 'I need **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** in that channel.';
    throw error;
  }

  const oldPanel = previous ? await getPanel(previous) : null;
  const config = {
    mode: 'guild',
    panelChannelId: channel.id,
    panelMessageId: null,
    panelCreatedAt: Date.now(),
    panelExpiredAt: null,
    notifyChannelId: channel.id,
    leadMinutes: minutes ?? previous?.leadMinutes ?? DEFAULT_LEAD,
    ownerUserId: interaction.user.id,
    selectedEvents: selectedNames(previous),
    paused: previous?.paused ?? false,
    resumeAt: previous?.resumeAt ?? null,
  };

  const message = await channel.send({ embeds: [panelEmbed(config)], components: panelComponents(config) });
  config.panelMessageId = message.id;
  state.guilds[id] = config;
  delete state.notified[bucketKey('guild', id)];
  await persistState();
  if (oldPanel && oldPanel.id !== message.id) await oldPanel.delete().catch(() => null);
  return config;
}

async function createDmSetup(user, minutes) {
  const id = user.id;
  const previous = state.users[id];
  let dm;
  try {
    dm = await user.createDM();
  } catch (error) {
    error.userMessage = 'I could not open a DM with you. Please allow direct messages from server members, then run `/pit dm` again.';
    throw error;
  }

  const oldPanel = previous ? await getPanel(previous) : null;
  const config = {
    mode: 'dm',
    panelChannelId: dm.id,
    panelMessageId: null,
    panelCreatedAt: Date.now(),
    panelExpiredAt: null,
    notifyChannelId: null,
    leadMinutes: minutes ?? previous?.leadMinutes ?? DEFAULT_LEAD,
    ownerUserId: id,
    selectedEvents: selectedNames(previous),
    paused: previous?.paused ?? false,
    resumeAt: previous?.resumeAt ?? null,
  };

  let message;
  try {
    message = await dm.send({ embeds: [panelEmbed(config)], components: panelComponents(config) });
  } catch (error) {
    error.userMessage = 'I could not send you a DM. Please enable DMs for this server and try `/pit dm` again.';
    throw error;
  }

  config.panelMessageId = message.id;
  state.users[id] = config;
  delete state.notified[bucketKey('dm', id)];
  await persistState();
  if (oldPanel && oldPanel.id !== message.id) await oldPanel.delete().catch(() => null);
  return config;
}

async function replyFailure(interaction, error, context = 'interaction') {
  const id = errorId();
  console.error(`[${id}] ${context}:`, error);
  const userMessage = error?.userMessage ?? 'Something went wrong while processing that request.';
  const content = `❌ ${userMessage}\n\nError ID: \`${id}\``;

  if (!interaction.isRepliable()) return;
  try {
    if (interaction.deferred) await interaction.editReply(content);
    else if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined });
  } catch (replyError) {
    console.error(`[${id}] Could not send the error message:`, replyError);
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadState();
  if (normalizeStoredState()) await persistState();
  await expirePanels();

  const events = await fetchSchedule(true).catch((error) => {
    console.warn('Initial schedule fetch failed:', error.message);
    return [];
  });
  updatePresence(events);
  await poll();
  setInterval(poll, POLL_MS);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isStringSelectMenu() && interaction.customId === 'pit:events') {
    const config = configForComponent(interaction);
    if (!config || interaction.message.id !== config.panelMessageId) {
      await interaction.reply({ content: 'This setup panel is no longer active. Run `/pit setup` or `/pit dm` to create a new one.', flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    if (interaction.user.id !== config.ownerUserId) {
      await interaction.reply({ content: `This setup belongs to <@${config.ownerUserId}>.`, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    if (config.panelExpiredAt) {
      await interaction.reply({ content: 'This setup panel has expired. Run `/pit setup` or `/pit dm` to open a new one.', flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }

    try {
      await interaction.deferUpdate();
      config.selectedEvents = interaction.values.filter((name) => byName.has(name));
      await persistState();
      await interaction.message.edit({ embeds: [panelEmbed(config)], components: panelComponents(config) });
    } catch (error) {
      await replyFailure(interaction, error, 'event select menu');
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('pit:')) {
    const config = configForComponent(interaction);
    if (!config || interaction.message.id !== config.panelMessageId) {
      await interaction.reply({ content: 'This setup panel is no longer active. Run `/pit setup` or `/pit dm` to create a new one.', flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    if (interaction.user.id !== config.ownerUserId) {
      await interaction.reply({ content: `This setup belongs to <@${config.ownerUserId}>.`, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    if (config.panelExpiredAt) {
      await interaction.reply({ content: 'This setup panel has expired. Run `/pit setup` or `/pit dm` to open a new one.', flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }

    try {
      await interaction.deferUpdate();
      if (interaction.customId === 'pit:minor') config.selectedEvents = EVENTS.filter((event) => event.type === 'minor').map((event) => event.name);
      else if (interaction.customId === 'pit:major') config.selectedEvents = EVENTS.filter((event) => event.type === 'major').map((event) => event.name);
      else if (interaction.customId === 'pit:all') config.selectedEvents = EVENTS.map((event) => event.name);
      else if (interaction.customId === 'pit:clear') config.selectedEvents = [];
      else if (interaction.customId === 'pit:toggle') {
        if (config.paused) {
          config.paused = false;
          config.resumeAt = Date.now();
          delete config.pausedAt;
        } else {
          config.paused = true;
          config.pausedAt = Date.now();
        }
      }
      await persistState();
      await interaction.message.edit({ embeds: [panelEmbed(config)], components: panelComponents(config) });
    } catch (error) {
      await replyFailure(interaction, error, `button ${interaction.customId}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== 'pit') return;

  try {
    await acknowledgeCommand(interaction);
    const subcommand = interaction.options.getSubcommand();
    const inGuild = interaction.inGuild();

    if (subcommand === 'help') {
      await interaction.editReply({ embeds: [helpEmbed()] });
      return;
    }

    if (subcommand === 'dm') {
      const minutes = interaction.options.getInteger('minutes') ?? state.users[interaction.user.id]?.leadMinutes ?? DEFAULT_LEAD;
      await createDmSetup(interaction.user, minutes);
      await interaction.editReply(
        inGuild
          ? '✅ I sent your personal PitBell setup panel in DM. If you do not see it, check your DM privacy settings.'
          : '✅ Your personal DM setup panel has been refreshed above.',
      );
      return;
    }

    if (subcommand === 'upcoming') {
      const count = interaction.options.getInteger('count') ?? 10;
      const events = (await fetchSchedule(true)).filter((event) => event.timestamp > Date.now() - 30_000).slice(0, count);
      await interaction.editReply({ embeds: [upcomingEmbed(events)] });
      return;
    }

    const serverMutation = ['setup', 'minutes', 'pause', 'resume', 'reset'].includes(subcommand);
    if (inGuild && serverMutation && !canManage(interaction)) {
      await interaction.editReply('❌ You need **Manage Server** to change this server\'s PitBell notification settings.\n\nFor personal notifications, use `/pit dm`.');
      return;
    }

    if (subcommand === 'setup') {
      const minutes = interaction.options.getInteger('minutes');
      if (inGuild) {
        const config = await createServerSetup(interaction, minutes);
        await interaction.editReply(`✅ Server notification panel created in <#${config.panelChannelId}>. Use the dropdown there to choose events.`);
      } else {
        await createDmSetup(interaction.user, minutes);
        await interaction.editReply('✅ Your personal DM notification panel has been created. Use the dropdown above to choose events.');
      }
      return;
    }

    const { store, id, scope } = currentStoreAndId(interaction);
    const config = store[id];
    if (!config) {
      await interaction.editReply(
        inGuild
          ? 'No server setup exists yet. A server manager can run `/pit setup`. For your own private reminders, run `/pit dm`.'
          : 'No DM setup exists yet. Run `/pit setup` here to create one.',
      );
      return;
    }
    config.selectedEvents ??= [];

    if (subcommand === 'status') {
      const selected = selectedNames(config);
      const panelState = config.panelExpiredAt ? 'Expired' : 'Active';
      const text = inGuild
        ? `Status: **${config.paused ? 'Paused' : 'Active'}**\nPanel: **${panelState}**\nNotifications: <#${config.notifyChannelId}>\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nSelected events: **${selected.length}**\nOwner: <@${config.ownerUserId}>\n\nPersonal DM reminders are separate: use \`/pit dm\`.`
        : `Status: **${config.paused ? 'Paused' : 'Active'}**\nPanel: **${panelState}**\nDelivery: **Direct Message**\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nSelected events: **${selected.length}**`;
      await interaction.editReply(text);
      return;
    }

    if (subcommand === 'minutes') {
      const value = interaction.options.getInteger('value', true);
      config.leadMinutes = value;
      delete state.notified[bucketKey(scope, id)];
      await persistState();
      await refreshPanel(config);
      await interaction.editReply(`✅ Notifications will now be sent **${value} minute(s)** before events.`);
      return;
    }

    if (subcommand === 'pause') {
      if (config.paused) {
        await interaction.editReply('ℹ️ Notifications are already paused. Your event selections are still saved.');
        return;
      }
      config.paused = true;
      config.pausedAt = Date.now();
      await persistState();
      await refreshPanel(config);
      await interaction.editReply('⏸️ Notifications are paused. Your selected events and reminder time are still saved.');
      return;
    }

    if (subcommand === 'resume') {
      if (!config.paused) {
        await interaction.editReply('ℹ️ Notifications are already active.');
        return;
      }
      config.paused = false;
      config.resumeAt = Date.now();
      delete config.pausedAt;
      await persistState();
      await refreshPanel(config);
      await interaction.editReply('▶️ Notifications are active again. Your previous settings have been kept.');
      return;
    }

    if (subcommand === 'reset') {
      const oldPanel = await getPanel(config);
      delete store[id];
      delete state.notified[bucketKey(scope, id)];
      await persistState();
      if (oldPanel) await oldPanel.delete().catch(() => null);
      await interaction.editReply(
        inGuild
          ? '✅ Server PitBell notifications have been reset. Personal DM settings, if any, were not changed.'
          : '✅ Your personal PitBell DM notifications have been reset.',
      );
      return;
    }

    await interaction.editReply('Unknown subcommand. Run `/pit help` to see available commands.');
  } catch (error) {
    await replyFailure(interaction, error, 'slash command');
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [commandJson] });
console.log('Registered global /pit command for guilds and bot DMs');
await client.login(token);
