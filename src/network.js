import dns from 'node:dns';
import { ChatInputCommandInteraction } from 'discord.js';
import { Agent, setGlobalDispatcher } from 'undici';

dns.setDefaultResultOrder('ipv4first');

const dispatcher = new Agent({
  connect: {
    timeout: 1200,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

setGlobalDispatcher(dispatcher);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientConnectError(error) {
  const code = error?.code ?? error?.cause?.code;
  return code === 'UND_ERR_CONNECT_TIMEOUT' || error?.name === 'ConnectTimeoutError' || error?.cause?.name === 'ConnectTimeoutError';
}

const originalDeferReply = ChatInputCommandInteraction.prototype.deferReply;
ChatInputCommandInteraction.prototype.deferReply = async function patchedDeferReply(...args) {
  try {
    return await originalDeferReply.apply(this, args);
  } catch (error) {
    const age = Date.now() - this.createdTimestamp;
    if (!isTransientConnectError(error) || age > 1700) throw error;
    await sleep(50);
    return originalDeferReply.apply(this, args);
  }
};

let lastHealthy = true;

async function warmDiscordConnection() {
  try {
    const response = await fetch('https://discord.com/api/v10/gateway', {
      signal: AbortSignal.timeout(2500),
      headers: { 'User-Agent': 'pit-event-notifier/network-warmup' },
    });
    await response.arrayBuffer();
    if (!lastHealthy) console.log('Discord REST connection recovered');
    lastHealthy = true;
  } catch (error) {
    if (lastHealthy) console.warn('Discord REST warmup failed:', error.message);
    lastHealthy = false;
  }
}

void warmDiscordConnection();
setInterval(() => void warmDiscordConnection(), 20_000).unref();
