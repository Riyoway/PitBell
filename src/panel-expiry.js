import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const DISCORD_EPOCH = 1420070400000n;
const CHECK_MS = 15_000;
const timeoutMinutes = Math.max(1, Number.parseInt(process.env.PANEL_TIMEOUT_MINUTES ?? '15', 10) || 15);
const TIMEOUT_MS = timeoutMinutes * 60_000;
const token = process.env.DISCORD_TOKEN;

function snowflakeTimestamp(id) {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Panel expiry could not read state:', error.message);
    return null;
  }
}

async function markExpired(scope, id, messageId) {
  const latest = await readState();
  if (!latest) return;

  const store = scope === 'guild' ? latest.guilds : latest.users;
  const config = store?.[id];
  if (!config || config.panelMessageId !== messageId) return;

  config.panelMessageId = null;
  config.panelExpiredAt = Date.now();

  const temp = `${STATE_FILE}.expiry.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  await fs.rename(temp, STATE_FILE);
}

async function expireMessage(scope, id, config) {
  const messageId = config.panelMessageId;
  const channelId = config.panelChannelId;
  if (!messageId || !channelId) return;

  const createdAt = snowflakeTimestamp(messageId);
  if (!createdAt || Date.now() - createdAt < TIMEOUT_MS) return;

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pit-event-notifier/1.4',
    },
    body: JSON.stringify({
      content: '',
      embeds: [
        {
          title: 'Hypixel Pit Event Notifications',
          description:
            '⌛ **This setup panel has expired.**\n\n' +
            'Your selected events, reminder time, and notification state are still saved. ' +
            'Run `/pit setup` to open a fresh control panel.',
          color: 0x5865f2,
          footer: { text: `Panel expired after ${timeoutMinutes} minutes` },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [],
      allowed_mentions: { parse: [] },
    }),
  }).catch((error) => {
    console.warn(`Panel expiry request failed for ${scope} ${id}:`, error.message);
    return null;
  });

  if (!response) return;

  if (response.ok || response.status === 404) {
    await markExpired(scope, id, messageId).catch((error) =>
      console.warn(`Could not persist expired panel for ${scope} ${id}:`, error.message),
    );
    return;
  }

  const body = await response.text().catch(() => '');
  console.warn(`Could not expire panel for ${scope} ${id}: HTTP ${response.status}${body ? ` ${body}` : ''}`);
}

async function expirePanels() {
  if (!token) return;

  const state = await readState();
  if (!state) return;

  for (const [id, config] of Object.entries(state.guilds ?? {})) {
    await expireMessage('guild', id, config);
  }

  for (const [id, config] of Object.entries(state.users ?? {})) {
    await expireMessage('dm', id, config);
  }
}

if (!token) {
  console.warn('Panel expiry disabled because DISCORD_TOKEN is missing.');
} else {
  void expirePanels();
  setInterval(() => void expirePanels(), CHECK_MS).unref();
}
