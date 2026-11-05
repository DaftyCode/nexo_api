/** A vault secret as listings show it: its name and allowed domains, never its value. */
export interface SecretSummary {
  name: string;
  /** Hosts it may be sent to (`api.example.com`, `*.example.com`); empty allows every host. */
  allowedHosts: string[];
}

/** Allowed domains as a person types them: separated by commas, spaces or lines. */
export function parseAllowedDomains(text: string): string[] {
  const domains = text
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter(Boolean);
  return [...new Set(domains)];
}

/** Allowed domains as the vault form shows them. */
export function formatAllowedDomains(hosts: readonly string[]): string {
  return hosts.join(', ');
}

/** The secret and host of the engine's error for a secret kept from a domain it is not allowed on. */
export function blockedSecret(
  error: string | undefined,
): { name: string; host: string } | undefined {
  const match = /^Secret (.+) cannot be sent to (\S+)$/.exec(error ?? '');
  return match ? { name: match[1], host: match[2] } : undefined;
}
