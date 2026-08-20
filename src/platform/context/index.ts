import type { Role } from '@/platform/rbac';

/**
 * Who is doing something, on behalf of which organization, and from where.
 *
 * Every mutation takes one of these. It is what the audit log records and what the tenancy
 * layer scopes by, which is why it is a single object rather than three loose arguments that
 * a call site could get out of step.
 */
export interface ActorContext {
  readonly organizationId: string;
  /** Null when the actor is the system or an AI process rather than a person. */
  readonly userId: string | null;
  readonly role: Role | null;
  readonly source: ActorSource;
}

export type ActorSource = 'web' | 'api' | 'seed' | 'test' | 'system';

export type ActorType = 'USER' | 'SYSTEM' | 'AI';

export function actorTypeOf(context: ActorContext): ActorType {
  return context.userId ? 'USER' : 'SYSTEM';
}

export function systemContext(organizationId: string, source: ActorSource = 'system'): ActorContext {
  return { organizationId, userId: null, role: null, source };
}
