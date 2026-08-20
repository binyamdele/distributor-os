import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { recentAudit } from '@/modules/audit';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

/**
 * The audit log, read-only.
 *
 * This is the page that answers "who changed that, and when" — the question a distributor asks
 * when a number looks wrong. Later phases add the full lifecycle of a quotation and an order to
 * the same stream, which is why the columns are generic rather than customer-specific.
 */
export default async function ActivityPage() {
  const session = await requirePermission('read:audit');

  const events = await withTenant(session.organizationId, (tx) => recentAudit(tx, 100));

  return (
    <>
      <PageHeader
        title={t('activity.title')}
        description="Every recorded change, newest first. Entries cannot be edited or deleted."
      />

      <TableWrap>
        <thead>
          <tr>
            <Th className="w-16 text-right">#</Th>
            <Th>{t('activity.action')}</Th>
            <Th>Entity</Th>
            <Th>{t('activity.actor')}</Th>
            <Th>Source</Th>
            <Th>{t('activity.when')}</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="hover:bg-surface-sunken">
              <Td className="tabular text-right text-ink-faint">{String(event.sequence)}</Td>
              <Td className="font-mono text-xs">{event.action}</Td>
              <Td className="text-ink-muted">{event.entityType}</Td>
              <Td>
                {event.actorType === 'USER' ? (
                  <span className="text-ink-muted">User</span>
                ) : event.actorType === 'AI' ? (
                  <Badge tone="accent">AI suggested</Badge>
                ) : (
                  <span className="text-ink-faint">{t('activity.system')}</span>
                )}
              </Td>
              <Td className="text-ink-faint">{event.source}</Td>
              <Td className="text-ink-muted">
                {formatDateTime(event.createdAt, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {events.length === 0 ? <EmptyState message={t('activity.empty')} /> : null}
    </>
  );
}
