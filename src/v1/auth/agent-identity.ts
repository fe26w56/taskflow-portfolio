import { z } from 'zod';
import type { Actor } from '../contracts/index.ts';

const clients = z.record(z.string().min(1), z.array(z.string().min(1).refine(name => name === name.trim())));

/** Resolve labels only against authenticated cid, never client_name or body actor. */
export function resolveActingAgent(actor: Actor, agent: string | undefined, config?: string): Actor | null {
  const { agent: _previousAgent, ...authenticated } = actor;
  if (!agent) return authenticated;
  if (actor.kind !== 'oauth_client' || !config) return null;
  try {
    const parsed = clients.safeParse(JSON.parse(config));
    if (!parsed.success || !Object.hasOwn(parsed.data, actor.client_id) ||
      !parsed.data[actor.client_id].includes(agent)) return null;
    return { ...authenticated, agent };
  } catch {
    // Invalid configuration disables identities; do not log configuration or parser errors.
    return null;
  }
}
