// Process-wide network preferences. Deliberately CLI-only: setDefaultResultOrder mutates global
// state for the whole process, which a library has no business doing to a host application that
// never asked for it. Library consumers who want this behavior call it themselves.

/** The slice of `node:dns` this needs, declared structurally so tests need no real DNS. */
export interface DnsOrderControl {
  setDefaultResultOrder?: (order: 'ipv4first' | 'verbatim' | 'ipv6first') => void;
}

/**
 * Applies `settings.preferIpv4` by pushing IPv4 addresses ahead of IPv6 in DNS results.
 *
 * Bun resolves IPv6-first by default, so on a network that advertises IPv6 without routing it,
 * every connection attempt hangs until the TCP timeout instead of failing fast — the Discord
 * voice websocket stalls for ~20 s and the call dies even though IPv4 to the same host works.
 * This is off by default because flipping the order unconditionally would break IPv6-only
 * networks in exactly the same way, and because a dead IPv6 route is a real fault worth seeing
 * rather than silently papering over.
 *
 * Returns whether the preference was actually applied, so the caller can say so out loud.
 */
export function applyNetworkPreferences(
  settings: { preferIpv4: boolean },
  dns: DnsOrderControl,
): boolean {
  if (!settings.preferIpv4) return false;

  // Node-compat surface: present in Bun today, but not worth failing a call over if it is not.
  if (typeof dns.setDefaultResultOrder !== 'function') return false;

  try {
    dns.setDefaultResultOrder('ipv4first');
    return true;
  } catch {
    return false;
  }
}
