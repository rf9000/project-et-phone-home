import { describe, expect, test } from 'bun:test';
import { applyNetworkPreferences } from '../../src/cli/network.ts';
import type { DnsOrderControl } from '../../src/cli/network.ts';

function recordingDns(): { calls: string[]; dns: DnsOrderControl } {
  const calls: string[] = [];
  return {
    calls,
    dns: {
      setDefaultResultOrder: (order: string) => {
        calls.push(order);
      },
    },
  };
}

describe('applyNetworkPreferences', () => {
  test('does nothing when preferIpv4 is off — the default must not touch global DNS state', () => {
    const { calls, dns } = recordingDns();

    const applied = applyNetworkPreferences({ preferIpv4: false }, dns);

    expect(applied).toBe(false);
    expect(calls).toEqual([]);
  });

  test('forces ipv4first when preferIpv4 is on', () => {
    const { calls, dns } = recordingDns();

    const applied = applyNetworkPreferences({ preferIpv4: true }, dns);

    expect(applied).toBe(true);
    expect(calls).toEqual(['ipv4first']);
  });

  test('a runtime without setDefaultResultOrder is reported, not crashed on', () => {
    // Bun implements this today, but it is a Node-compat surface: an older or different runtime
    // may not, and failing to place a call over a DNS preference would be absurd.
    const applied = applyNetworkPreferences({ preferIpv4: true }, {} as DnsOrderControl);

    expect(applied).toBe(false);
  });

  test('a throwing setDefaultResultOrder is swallowed', () => {
    const dns: DnsOrderControl = {
      setDefaultResultOrder: () => {
        throw new Error('unsupported');
      },
    };

    expect(applyNetworkPreferences({ preferIpv4: true }, dns)).toBe(false);
  });
});
