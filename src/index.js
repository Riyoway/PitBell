import 'dotenv/config';
import {
  ActivityType, Client, EmbedBuilder, GatewayIntentBits, Partials,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
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
  ['Quick Maths','🧮','minor',15], ['Dragon Egg','🐲','minor',90],
  ['2x Rewards','2️⃣','minor',240], ['Care Package','📦','minor',30],
  ['KOTL','🪜','minor',180], ['KOTH','👑','minor',240],
  ['Auction','💵','minor',30], ['Giant Cake','🍰','minor',120],
  ['All bounty','🪙','minor',15], ['Squads','🏳️','major',480],
  ['Beast','🐻','major',480], ['Pizza','🍕','major',480],
  ['Rage Pit','🥔','major',420], ['Spire','🏯','major',480],
  ['Robbery','💸','major',420], ['Blockhead','🧱','major',480],
  ['Raffle','🎟️','major',480], ['Team Deathmatch','🆚','major',480],
].map(([name, emoji, type, durationSeconds]) => ({ name, emoji, type, durationSeconds })));

const byName = new Map(EVENTS.map(e => [e.name, e]));
const norm = s => String(s ?? '').replace(/\uFE0F/g, '');
const byEmoji = new Map(EVENTS.map(e => [norm(e.emoji), e]));

const command = new SlashCommandBuilder()
  .setName('pit').setDescription('Hypixel Pit event notifications')
  .addSubcommand(s => s.setName('setup').setDescription('Create or replace your event notification setup')
    .addChannelOption(o => o.setName('channel').setDescription('Server channel for the panel and notifications'))
    .addIntegerOption(o => o.setName('minutes').setDescription('Notify this many minutes before an event').setMinValue(1).setMaxValue(30)))
  .addSubcommand(s => s.setName('minutes').setDescription('Change the notification lead time')
    .addIntegerOption(o => o.setName('value').setDescription('Minutes before the event').setMinValue(1).setMaxValue(30).setRequired(true)))
  .addSubcommand(s => s.setName('pause').setDescription('Pause notifications without deleting your settings'))
  .addSubcommand(s => s.setName('resume').setDescription('Resume notifications with your saved settings'))
  .addSubcommand(s => s.setName('status').setDescription('Show the current notification configuration'))
  .addSubcommand(s => s.setName('upcoming').setDescription('Show upcoming Pit events')
    .addIntegerOption(o => o.setName('count').setDescription('Number of events to show').setMinValue(1).setMaxValue(15)))
  .addSubcommand(s => s.setName('reset').setDescription('Remove the current configuration and stop notifications'));

const commandJson = { ...command.toJSON(), integration_types: [0], contexts: [0, 1] };
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let state = { guilds: {}, users: {}, notified: {} };
let cache = { fetchedAt: 0, events: [] };
let lastPresence = '';
let polling = false;
let saveQueue = Promise.resolve();

const bucketKey = (scope, id) => `${scope}:${id}`;
const eventKey = e => `${e.timestamp}:${e.event}`;
const unix = ms => Math.floor(ms / 1000);

function panelEmbed(minutes, userId) {
  const list = type => EVENTS.filter(e => e.type === type).map(e => `${e.emoji} **${e.name}**`).join('\n');
  return new EmbedBuilder()
    .setTitle('Hypixel Pit Event Notifications')
    .setDescription(`<@${userId}>: react to the events you want.\nRemove a reaction to unsubscribe. Reminders are sent **${minutes} minute(s) before** the event.`)
    .addFields(
      { name: 'Minor Events', value: list('minor'), inline: true },
      { name: 'Major Events', value: list('major'), inline: true },
    )
    .setFooter({ text: 'Schedule source: brookeafk.com event data' }).setTimestamp();
}

function notificationEmbed(e, minutes) {
  const meta = byName.get(e.event);
  const t = unix(e.timestamp);
  return new EmbedBuilder()
    .setTitle(`${meta?.emoji ?? '🔔'} ${e.event}`)
    .setDescription(`A **${e.type.toUpperCase()}** event is starting soon.`)
    .addFields(
      { name: 'Starts', value: `<t:${t}:R>`, inline: true },
      { name: 'Time', value: `<t:${t}:t>`, inline: true },
      { name: 'Reminder', value: `${minutes} min before`, inline: true },
    ).setTimestamp(e.timestamp);
}

function upcomingEmbed(events) {
  const body = events.map(e => {
    const meta = byName.get(e.event);
    return `${meta?.emoji ?? '•'} **${e.event}** · ${e.type === 'major' ? 'Major' : 'Minor'} · <t:${unix(e.timestamp)}:R>`;
  }).join('\n');
  return new EmbedBuilder().setTitle('Upcoming Hypixel Pit Events')
    .setDescription(body || 'No upcoming events were returned by the source.')
    .setFooter({ text: 'Source: brookeafk.com event data' }).setTimestamp();
}

function currentEvent(schedule, now = Date.now()) {
  for (let i = schedule.length - 1; i >= 0; i--) {
    const e = schedule[i];
    if (e.timestamp > now) continue;
    const duration = (byName.get(e.event)?.durationSeconds ?? 0) * 1000;
    return duration && now < e.timestamp + duration ? e : null;
  }
  return null;
}

function updatePresence(schedule) {
  if (!client.user) return;
  const now = Date.now();
  const current = currentEvent(schedule, now);
  let key, name;

  if (current) {
    const meta = byName.get(current.event);
    key = `current:${current.timestamp}:${current.event}`;
    name = `${meta?.emoji ?? '🔴'} ${current.event} · ${current.type === 'major' ? 'Major' : 'Minor'}`;
  } else {
    const next = schedule.find(e => e.timestamp > now);
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
    const p = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    state = { guilds: p.guilds ?? {}, users: p.users ?? {}, notified: p.notified ?? {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read state file:', e);
    await persist();
  }
}

function persist() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tmp, STATE_FILE);
  }).catch(e => console.error('Failed to persist state:', e));
  return saveQueue;
}

async function schedule(force = false) {
  const now = Date.now();
  if (!force && cache.events.length && now - cache.fetchedAt < SOURCE_REFRESH_MS) return cache.events;

  try {
    const r = await fetch(`${SOURCE_URL}?t=${now}`, {
      headers: { 'User-Agent': 'pit-event-notifier/1.2', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Schedule source returned HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('Schedule source did not return an array');

    const events = data.filter(e =>
      e && typeof e.event === 'string' && Number.isFinite(e.timestamp) &&
      (e.type === 'major' || e.type === 'minor') && byName.has(e.event)
    ).sort((a, b) => a.timestamp - b.timestamp);

    cache = { fetchedAt: now, events };
    return events;
  } catch (e) {
    if (cache.events.length) {
      console.warn('Using cached schedule:', e.message);
      return cache.events;
    }
    throw e;
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

async function selected(config, eventName) {
  const meta = byName.get(eventName);
  if (!meta) return false;
  const msg = await panel(config);
  if (!msg) return false;
  const reaction = msg.reactions.cache.find(r => norm(r.emoji.name) === norm(meta.emoji));
  if (!reaction) return false;
  return (await reaction.users.fetch()).has(config.ownerUserId);
}

async function notify(scope, config, e) {
  if (!(await selected(config, e.event))) return true;
  let channel;
  if (scope === 'guild') channel = await client.channels.fetch(config.notifyChannelId).catch(() => null);
  else {
    const user = await client.users.fetch(config.ownerUserId).catch(() => null);
    channel = await user?.createDM().catch(() => null);
  }
  if (!channel?.isTextBased()) return false;

  await channel.send({
    content: `<@${config.ownerUserId}>`,
    embeds: [notificationEmbed(e, config.leadMinutes ?? DEFAULT_LEAD)],
    allowedMentions: { users: [config.ownerUserId] },
  });
  return true;
}

async function processTarget(scope, id, config, events, now) {
  if (config.paused) return false;
  const lead = (config.leadMinutes ?? DEFAULT_LEAD) * 60_000;
  const bucket = bucketKey(scope, id);
  let dirty = false;

  for (const e of events) {
    const reminderAt = e.timestamp - lead;
    if (e.timestamp < now - 60_000) continue;
    if (reminderAt > now) break;
    if (config.resumeAt && reminderAt < config.resumeAt) continue;
    state.notified[bucket] ??= {};
    const key = eventKey(e);
    if (state.notified[bucket][key]) continue;

    try {
      if (await notify(scope, config, e)) {
        state.notified[bucket][key] = now;
        dirty = true;
      }
    } catch (err) {
      console.error(`Failed to notify ${scope} ${id} about ${key}:`, err);
    }
  }
  return dirty;
}

function prune() {
  const cutoff = Date.now() - 86_400_000;
  for (const [bucket, entries] of Object.entries(state.notified)) {
    for (const [key, sentAt] of Object.entries(entries)) if (sentAt < cutoff) delete entries[key];
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

    for (const [id, config] of Object.entries(state.guilds))
      dirty = (await processTarget('guild', id, config, events, now)) || dirty;
    for (const [id, config] of Object.entries(state.users))
      dirty = (await processTarget('dm', id, config, events, now)) || dirty;

    const before = JSON.stringify(state.notified);
    prune();
    if (before !== JSON.stringify(state.notified)) dirty = true;
    if (dirty) await persist();
  } catch (e) {
    console.error('Notification poll failed:', e);
  } finally {
    polling = false;
  }
}

const canManage = i => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadState();
  const events = await schedule(true).catch(e => {
    console.warn('Initial schedule fetch failed:', e.message);
    return [];
  });
  updatePresence(events);
  await poll();
  setInterval(poll, POLL_MS);
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'pit') return;
  const sub = i.options.getSubcommand();
  const inGuild = i.inGuild();

  if (inGuild && sub !== 'upcoming' && !canManage(i)) {
    await i.reply({ content: 'You need **Manage Server** to change Pit notification settings.', ephemeral: true });
    return;
  }

  const store = inGuild ? state.guilds : state.users;
  const id = inGuild ? i.guildId : i.user.id;
  const bucket = bucketKey(inGuild ? 'guild' : 'dm', id);

  try {
    if (sub === 'setup') {
      const minutes = i.options.getInteger('minutes') ?? DEFAULT_LEAD;
      let channel = i.channel;

      if (inGuild) {
        channel = i.options.getChannel('channel') ?? i.channel;
        if (!channel?.isTextBased()) return i.reply({ content: 'Choose a text-based channel.', ephemeral: true });
        const perms = channel.permissionsFor(i.guild.members.me);
        const needed = [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.ReadMessageHistory,
        ];
        if (needed.some(p => !perms?.has(p))) {
          return i.reply({
            content: 'I need View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History in that channel.',
            ephemeral: true,
          });
        }
      } else if (!channel?.isTextBased()) return i.reply('This DM channel is unavailable.');

      await i.deferReply({ ephemeral: inGuild });
      if (store[id]?.panelMessageId) await (await panel(store[id]))?.delete().catch(() => null);

      const msg = await channel.send({ embeds: [panelEmbed(minutes, i.user.id)] });
      for (const e of EVENTS) await msg.react(e.emoji);

      store[id] = {
        mode: inGuild ? 'guild' : 'dm',
        panelChannelId: channel.id, panelMessageId: msg.id,
        notifyChannelId: inGuild ? channel.id : null,
        leadMinutes: minutes, ownerUserId: i.user.id,
        paused: false, resumeAt: null,
      };
      delete state.notified[bucket];
      await persist();
      return i.editReply(inGuild ? `Notification panel created in <#${channel.id}>.` :
        'DM notifications are configured. React to the event emojis in the panel above.');
    }

    if (sub === 'upcoming') {
      const count = i.options.getInteger('count') ?? 10;
      await i.deferReply({ ephemeral: inGuild });
      const events = (await schedule(true)).filter(e => e.timestamp > Date.now() - 30_000).slice(0, count);
      return i.editReply({ embeds: [upcomingEmbed(events)] });
    }

    const config = store[id];
    if (!config) return i.reply({ content: 'Run `/pit setup` first.', ephemeral: inGuild });

    if (sub === 'minutes') {
      const value = i.options.getInteger('value', true);
      config.leadMinutes = value;
      delete state.notified[bucket];
      await persist();
      const msg = await panel(config);
      if (msg) await msg.edit({ embeds: [panelEmbed(value, config.ownerUserId)] });
      return i.reply({ content: `Notifications will now be sent ${value} minute(s) before events.`, ephemeral: inGuild });
    }

    if (sub === 'pause') {
      if (config.paused) return i.reply({ content: 'Pit event notifications are already paused.', ephemeral: inGuild });
      config.paused = true; config.pausedAt = Date.now();
      await persist();
      return i.reply({ content: 'Notifications are paused. Your settings are still saved.', ephemeral: inGuild });
    }

    if (sub === 'resume') {
      if (!config.paused) return i.reply({ content: 'Pit event notifications are already active.', ephemeral: inGuild });
      config.paused = false; config.resumeAt = Date.now(); delete config.pausedAt;
      await persist();
      return i.reply({ content: 'Notifications are active again. Your previous settings have been kept.', ephemeral: inGuild });
    }

    if (sub === 'status') {
      const text = inGuild
        ? `Status: **${config.paused ? 'Paused' : 'Active'}**\nPanel: <#${config.panelChannelId}>\nNotifications: <#${config.notifyChannelId}>\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nMention: <@${config.ownerUserId}>`
        : `Status: **${config.paused ? 'Paused' : 'Active'}**\nDelivery: **Direct Message**\nLead time: **${config.leadMinutes ?? DEFAULT_LEAD} min**\nMention: <@${config.ownerUserId}>`;
      return i.reply({ content: text, ephemeral: inGuild });
    }

    if (sub === 'reset') {
      await (await panel(config))?.delete().catch(() => null);
      delete store[id]; delete state.notified[bucket];
      await persist();
      return i.reply({
        content: inGuild ? 'Pit event notifications have been disabled for this server.' : 'Pit event DM notifications have been disabled for you.',
        ephemeral: inGuild,
      });
    }
  } catch (e) {
    console.error('Slash command failed:', e);
    const payload = { content: 'Something went wrong while handling that command.', ephemeral: inGuild };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => null);
    else await i.reply(payload).catch(() => null);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const config = reaction.message.guildId ? state.guilds[reaction.message.guildId] : state.users[user.id];
  if (!config || reaction.message.id !== config.panelMessageId) return;
  const event = byEmoji.get(norm(reaction.emoji.name));
  if (!event || user.id !== config.ownerUserId) await reaction.users.remove(user.id).catch(() => null);
});

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));

const rest = new REST({ version: '10' }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: [commandJson] });
console.log('Registered global /pit command for guilds and bot DMs');
await client.login(token);
