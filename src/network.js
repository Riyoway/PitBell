import dns from 'node:dns';
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
