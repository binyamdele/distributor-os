import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getWarehouseTask } from '@/modules/fulfillment';
import { blockingDiscrepancies } from '@/modules/inventory';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { TASK_TONE, taskStatusKey } from '../page';
import { ReportCountForm } from '../../exceptions/exception-forms';
import {
  CancelTaskForm,
  CompleteTaskForm,
  MarkPreparedForm,
  RecordPickupForm,
  StartTaskForm,
  ToggleItemForm,
} from '../warehouse-forms';

/**
 * One task, as the person picking it sees it.
 *
 * Only the legal action is offered, and a blocked one says why rather than being greyed out
 * with no explanation. The reservation column is on the screen before anyone presses Complete,
 * so a discrepancy is something you notice while walking the aisle rather than something the
 * system tells you after you have already loaded the lorry.
 */
export default async function WarehouseTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('read:warehouse-task');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const task = await getWarehouseTask(tx, id);
    if (!task.ok) return null;
    return {
      task: task.value,
      blocking: await blockingDiscrepancies(tx, id),
      history: can(session.role, 'read:audit')
        ? await auditTrailFor(tx, 'warehouse_task', id)
        : [],
    };
  });

  if (!data) notFound();
  const { task, blocking, history } = data;

  const allPicked = task.items.every((item) => item.prepared);

  return (
    <>
      <PageHeader
        title={task.taskNumber}
        description={`${task.customer.companyName} · ${task.order.orderNumber}`}
        action={<Badge tone={TASK_TONE[task.status]}>{t(taskStatusKey(task.status))}</Badge>}
      />

      {task.status === 'CANCELLED' && task.cancellationReason ? (
        <Card className="mb-6">
          <p className="text-sm text-ink">{task.cancellationReason}</p>
        </Card>
      ) : null}

      {task.status === 'PREPARED' ? (
        <Card className="mb-6 border-caution/30 bg-caution-soft" data-testid="prepared-notice">
          <p className="text-sm text-ink">{t('wh.preparedHint')}</p>
        </Card>
      ) : null}

      {task.status === 'COMPLETED' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft" data-testid="handed-over">
          <p className="text-sm text-ink">
            Goods handed over{' '}
            {task.completedAt
              ? formatDateTime(task.completedAt, session.locale, session.timezone)
              : ''}
            . Stock has been consumed and the reservation closed.
          </p>
          {task.order.pickedUpAt ? (
            <p className="mt-1 text-sm text-ink-muted">{t('wh.pickedUp')}</p>
          ) : null}
        </Card>
      ) : null}

      {blocking.length > 0 ? (
        <Card className="mb-6 border-critical/30 bg-critical-soft" data-testid="blocked-by-count">
          <h2 className="text-sm font-semibold text-critical">{t('exc.blockedByCount')}</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {blocking.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/exceptions/${entry.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {entry.discrepancyNumber}
                </Link>{' '}
                — {entry.sku}, {entry.variance > 0 ? '+' : ''}
                {entry.variance}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!task.reservationsAgree ? (
        <Card className="mb-6 border-critical/30 bg-critical-soft" data-testid="mismatch-warning">
          <p className="text-sm text-critical">{t('wh.mismatch')}</p>
        </Card>
      ) : null}

      {/* --- what to pick. quantities and units, nothing commercial ---------- */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('wh.lines')}</h2>
        <TableWrap>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th className="text-right">{t('wh.required')}</Th>
              <Th className="text-right">{t('wh.reserved')}</Th>
              <Th className="text-right">{t('wh.onHand')}</Th>
              <Th>{t('wh.picked')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {task.items.map((item) => (
              <tr key={item.id} data-testid="task-item" data-sku={item.sku}>
                <Td>
                  <div className="font-medium text-ink">{item.description}</div>
                  <div className="font-mono text-xs text-ink-faint">{item.sku}</div>
                </Td>
                <Td className="tabular text-right font-medium">
                  {item.quantityRequired.toLocaleString()} {item.unit}
                </Td>
                <Td
                  className={`tabular text-right ${
                    item.activeReservedQuantity === item.quantityRequired
                      ? 'text-ink-muted'
                      : 'text-critical'
                  }`}
                >
                  {item.activeReservedQuantity.toLocaleString()}
                </Td>
                <Td className="tabular text-right text-ink-muted">
                  {item.onHand === null ? '—' : item.onHand.toLocaleString()}
                </Td>
                <Td>
                  <Badge tone={item.prepared ? 'positive' : 'neutral'}>
                    {item.prepared ? t('wh.picked') : '—'}
                  </Badge>
                </Td>
                <Td>
                  {task.status === 'IN_PROGRESS' && can(session.role, 'prepare:warehouse-task') ? (
                    <ToggleItemForm taskId={task.id} itemId={item.id} prepared={item.prepared} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </section>

      {/* --- the legal action, and only that ---------------------------------- */}
      <section className="mb-6 space-y-4">
        {task.status === 'PENDING' && can(session.role, 'start:warehouse-task') ? (
          <Card>
            <StartTaskForm taskId={task.id} />
          </Card>
        ) : null}

        {task.status === 'IN_PROGRESS' && can(session.role, 'prepare:warehouse-task') ? (
          <Card>
            {allPicked ? (
              <MarkPreparedForm taskId={task.id} />
            ) : (
              <p className="text-sm text-ink-muted" data-testid="lines-outstanding">
                {task.items.filter((item) => !item.prepared).length} line(s) still to pick.
              </p>
            )}
          </Card>
        ) : null}

        {task.status === 'PREPARED' && can(session.role, 'complete:warehouse-task') ? (
          <Card>
            <CompleteTaskForm taskId={task.id} />
          </Card>
        ) : null}

        {task.status === 'COMPLETED' &&
        !task.order.deliveryRequired &&
        !task.order.pickedUpAt &&
        can(session.role, 'record:pickup') ? (
          <Card>
            <RecordPickupForm taskId={task.id} salesOrderId={task.order.id} />
          </Card>
        ) : null}

        {task.status !== 'COMPLETED' &&
        task.status !== 'CANCELLED' &&
        can(session.role, 'report:inventory-discrepancy') ? (
          <Card data-testid="report-discrepancy-panel">
            <h2 className="mb-2 text-sm font-semibold text-ink">{t('exc.reportFromTask')}</h2>
            <div className="space-y-4">
              {task.items
                .filter((item) => item.productId !== null)
                .map((item) => (
                  <div key={item.id} data-testid="report-line" data-sku={item.sku}>
                    <div className="mb-1 text-sm">
                      <span className="font-medium text-ink">{item.description}</span>{' '}
                      <span className="font-mono text-xs text-ink-faint">{item.sku}</span>
                      <span className="tabular ml-2 text-xs text-ink-muted">
                        {t('exc.systemOnHand')} {item.onHand?.toLocaleString() ?? '—'}
                      </span>
                    </div>
                    <ReportCountForm
                      productId={item.productId!}
                      warehouseTaskId={task.id}
                      redirectTo={`/warehouse/${task.id}`}
                    />
                  </div>
                ))}
            </div>
          </Card>
        ) : null}

        {task.status !== 'COMPLETED' &&
        task.status !== 'CANCELLED' &&
        can(session.role, 'cancel:warehouse-task') ? (
          <Card>
            <CancelTaskForm taskId={task.id} />
            <p className="mt-2 text-xs text-ink-faint">
              Cancelling the task does not cancel the order or release its stock — the order
              still owns what was reserved for it.
            </p>
          </Card>
        ) : null}
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('order.number')} value={task.order.orderNumber} />
          <Row label={t('quote.customer')} value={task.customer.companyName} />
          {task.customer.phone ? (
            <Row label={t('customer.phone')} value={task.customer.phone} />
          ) : null}
          <Row
            label={t('order.deliveryRequired')}
            value={task.order.deliveryRequired ? t('wh.delivery') : t('wh.recordPickup')}
          />
          {task.order.deliveryRequired && task.order.deliveryAddress ? (
            <Row label={t('order.deliveryAddress')} value={task.order.deliveryAddress} />
          ) : null}
          <div className="pt-1">
            <Link
              href={`/orders/${task.order.id}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {task.order.orderNumber}
            </Link>
          </div>
        </Card>

        <Card className="space-y-1.5 text-sm">
          {task.assignedUserName ? (
            <Row label={t('wh.assignedTo')} value={task.assignedUserName} />
          ) : null}
          {task.startedAt ? (
            <Row
              label={t('wh.start')}
              value={formatDateTime(task.startedAt, session.locale, session.timezone)}
            />
          ) : null}
          {task.preparedAt ? (
            <Row
              label={t('whStatus.prepared')}
              value={formatDateTime(task.preparedAt, session.locale, session.timezone)}
            />
          ) : null}
          {task.completedAt ? (
            <Row
              label={t('whStatus.completed')}
              value={formatDateTime(task.completedAt, session.locale, session.timezone)}
            />
          ) : null}
          {task.delivery ? (
            <div className="pt-1">
              <Link
                href={`/deliveries/${task.delivery.id}`}
                className="font-mono text-sm text-accent hover:underline"
                data-testid="task-delivery-link"
              >
                {task.delivery.deliveryNumber}
              </Link>
            </div>
          ) : null}
        </Card>
      </section>

      {history.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('activity.title')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('activity.action')}</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <Td className="font-mono text-xs">{entry.action}</Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(entry.createdAt, session.locale, session.timezone)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
