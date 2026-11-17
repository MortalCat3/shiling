import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

const normalize = (address: string): string => address.replace(/^::ffff:/i, '');
const resolver = new Resolver({ timeout: 1000, tries: 1 });
async function resolveAddresses(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const addresses = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  if (addresses.length === 0) throw new Error('Trusted proxy DNS is unavailable.');
  return addresses;
}

/** Trust only the immediate peer resolved from explicit deployment configuration. */
export function createProxyTrust(
  host: string | null,
  resolve: (host: string) => Promise<string[]> = resolveAddresses,
  now: () => number = Date.now,
) {
  let addresses = new Set<string>();
  let expiresAt = 0;
  let pending: Promise<void> | undefined;
  return {
    trust(address: string, hop: number): boolean {
      return host !== null && hop === 0 && addresses.has(normalize(address));
    },
    async refresh(): Promise<void> {
      if (host === null || now() < expiresAt) return;
      pending ??= (async () => {
        try {
          addresses = new Set((await resolve(host)).filter((ip) => isIP(ip)).map(normalize));
          expiresAt = now() + 5000;
        } catch {
          // Fail closed: never retain a stale trusted peer after DNS failure.
          addresses.clear();
          expiresAt = now() + 1000;
        } finally {
          pending = undefined;
        }
      })();
      await pending;
    },
  };
}
