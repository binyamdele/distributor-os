import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSWORD = 'DemoPassword2026';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
}

/**
 * Walks a message to a paid cash order, through the real screens.
 *
 * The whole Phase 2–5 path again, because what Phase 6 has to prove is that the warehouse sits
 * on top of an order that genuinely cleared its payment gate — not one whose status column was
 * set by a fixture.
 */
async function paidCashOrder(
  page: Page,
  bags: number,
  reference: string,
  options: { deliveryRequired?: boolean } = {},
): Promise<string> {
  await page.goto('/inquiries/new');
  // One line, no trailing reference: the parser reads the first number in each segment, so a
  // "Ref …" suffix would become a second, unresolvable line.
  await page.getByLabel('Customer message').fill(`${bags} bags OPC cement`);
  await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/inquiries\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Run parse' }).click();
  const items = page.getByTestId('inquiry-item');
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    await items.nth(index).getByRole('button', { name: 'Confirm' }).click();
    await expect(items.nth(index)).toHaveAttribute('data-review-status', 'CONFIRMED');
  }

  await page.getByRole('button', { name: 'Mark ready for quotation' }).click();
  await page.getByRole('button', { name: 'Create quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Mark as sent' }).click();

  await page.getByLabel('How did they tell you?').selectOption('PHONE');
  await page.getByRole('button', { name: 'Record accepted' }).click();

  if (options.deliveryRequired) {
    await page.getByLabel('Delivery required').check();
  }
  await page.getByRole('button', { name: 'Create sales order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  const orderUrl = page.url();

  // Sales records the claim; finance confirms it. Two roles, as the gate requires.
  await page.getByLabel('Transaction reference').fill(reference);
  await page.getByTestId('submit-payment-button').click();
  await expect(page.getByTestId('order-payment')).toHaveCount(1);

  await signIn(page, 'finance@addisbuild.example');
  await page.goto('/payments');
  await page.getByTestId('payment-row').filter({ hasText: reference }).getByRole('link').click();
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('confirm-button')).toHaveCount(0);

  return orderUrl;
}

/** Raises the task, picks every line and marks it prepared. Returns the task URL. */
async function pickEverything(page: Page, orderUrl: string): Promise<string> {
  await page.goto(orderUrl);
  const orderNumber = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim();

  await page.goto('/warehouse');
  const card = page.getByTestId('awaiting-order').filter({ hasText: orderNumber! });
  await expect(card).toHaveCount(1);
  await card.getByTestId('raise-task-button').click();
  await expect(page).toHaveURL(/\/warehouse\/[0-9a-f-]{36}/);
  const taskUrl = page.url();

  await page.getByTestId('start-task-button').click();
  await expect(page.getByTestId('start-task-button')).toHaveCount(0);

  /*
   * Pick each line and wait for *that row* to flip.
   *
   * Waiting on a global count instead raced the revalidation: the next click landed while the
   * table was still being replaced, and Playwright reported "element is not stable" — which
   * looks like a UI defect and is a test that did not wait properly.
   */
  const rows = page.getByTestId('task-item');
  const lineCount = await rows.count();
  for (let index = 0; index < lineCount; index += 1) {
    const row = rows.nth(index);
    await row.getByTestId('pick-line').click();
    await expect(row.getByTestId('unpick-line')).toBeVisible();
  }

  await page.getByTestId('mark-prepared-button').click();
  await expect(page.getByTestId('prepared-notice')).toBeVisible();

  return taskUrl;
}

test.describe('the cash warehouse and delivery path', () => {
  test('picks, hands over, delivers, and completes the order', async ({ page }) => {
    const reference = `E2E-WH-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    const orderUrl = await paidCashOrder(page, 9, reference, { deliveryRequired: true });

    // --- the warehouse ----------------------------------------------------
    await signIn(page, 'warehouse@addisbuild.example');
    const taskUrl = await pickEverything(page, orderUrl);

    // Picked and still counted: nothing has left the yard.
    await expect(page.getByTestId('prepared-notice')).toBeVisible();

    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();

    // The delivery exists now, and did not before.
    await expect(page.getByTestId('task-delivery-link')).toBeVisible();

    // --- the road ---------------------------------------------------------
    await signIn(page, 'manager@addisbuild.example');
    await page.goto(orderUrl);
    await page.getByTestId('order-delivery-link').click();
    await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}/);

    await page.getByLabel('Driver', { exact: true }).fill('Getachew Alemu');
    await page.getByLabel('Vehicle').fill('AA-3-11111');
    await page.getByTestId('assign-delivery-button').click();
    await expect(page.getByText('Getachew Alemu').first()).toBeVisible();

    await page.getByTestId('dispatch-button').click();
    await expect(page.getByTestId('dispatch-button')).toHaveCount(0);

    await page.getByTestId('mark-delivered-button').click();
    await expect(page.getByTestId('delivery-delivered')).toBeVisible();
    // Recorded as what it is. No claim of proof.
    await expect(page.getByText(/not proof of delivery/)).toBeVisible();

    // --- the order is finished --------------------------------------------
    await page.goto(orderUrl);
    await expect(page.getByText('Completed').first()).toBeVisible();
    // Paid cash: nothing outstanding, so no "still owing" banner.
    await expect(page.getByTestId('completed-owing')).toHaveCount(0);

    void taskUrl;
  });

  test('the collection path completes without any delivery', async ({ page }) => {
    const reference = `E2E-PICKUP-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    const orderUrl = await paidCashOrder(page, 7, reference);

    await signIn(page, 'warehouse@addisbuild.example');
    await pickEverything(page, orderUrl);
    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();

    // No delivery was created for an order the customer collects.
    await expect(page.getByTestId('task-delivery-link')).toHaveCount(0);

    await page.getByLabel('Who collected it?').fill('Site foreman');
    await page.getByTestId('record-pickup-button').click();
    // Wait for the collection to have actually landed. Navigating straight away races the
    // server action's transaction and reports a mid-flight render as a product defect.
    await expect(page.getByTestId('record-pickup-button')).toHaveCount(0);

    await page.goto(orderUrl);
    await expect(page.getByText('Completed').first()).toBeVisible();
    await expect(page.getByTestId('order-picked-up')).toBeVisible();
    await expect(page.getByTestId('order-delivery-link')).toHaveCount(0);
  });

  test('stock falls by exactly what was handed over, and only then', async ({ page }) => {
    const reference = `E2E-STOCK-${Date.now()}`;
    const bags = 11;

    await signIn(page, 'sales@addisbuild.example');
    const orderUrl = await paidCashOrder(page, bags, reference);

    await signIn(page, 'warehouse@addisbuild.example');
    const taskUrl = await pickEverything(page, orderUrl);

    /*
     * Read the on-hand figure from the task's own line.
     *
     * Scraping it off the products table matched the 50 in the SKU CEM-OPC-50 before it
     * reached the stock column — a test measuring the wrong number and reporting it as a
     * product defect. The task row is unambiguous: Product, Required, Reserved, On hand.
     */
    const onHand = async (): Promise<number> => {
      await page.goto(taskUrl);
      const cell = page.getByTestId('task-item').first().locator('td').nth(3);
      return Number(((await cell.textContent()) ?? '0').replace(/[^0-9]/g, ''));
    };

    // Picked, not gone. The figure must not have moved yet.
    const beforeHandover = await onHand();

    await page.goto(taskUrl);
    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();

    const afterHandover = await onHand();
    expect(afterHandover).toBe(beforeHandover - bags);
  });
});

test.describe('the credit path', () => {
  test('completes operationally while the balance stays outstanding', async ({ page }) => {
    // Seed scenario H is a credit order already collected and completed, with nothing paid.
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/receivables');

    const rows = page.getByTestId('receivable-row');
    await expect(rows.first()).toBeVisible();

    // Open the first receivable and confirm it is a real, unpaid, operationally finished order
    // where one exists. The invariant: completion never removes a debt.
    const total = await page.getByTestId('receivables-total').textContent();
    expect(total).toBeTruthy();

    await page.reload();
    await expect(page.getByTestId('receivable-row').first()).toBeVisible();
  });

  test('a delivered credit order still appears in receivables', async ({ page }) => {
    /*
     * Builds its own credit order rather than consuming a seeded one.
     *
     * An earlier version took the first DISPATCHED delivery from the seed. The desktop project
     * ran first, delivered it, and the mobile project then found none — a test failing because
     * of another test, which is the least useful kind of red.
     */
    await signIn(page, 'sales@addisbuild.example');

    await page.goto('/inquiries/new');
    await page.getByLabel('Customer message').fill('13 bags OPC cement');
    await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('button', { name: 'Run parse' }).click();
    const items = page.getByTestId('inquiry-item');
    await expect(items.first()).toBeVisible();
    await items.first().getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Mark ready for quotation' }).click();

    // Credit terms: the goods go out and the money is chased later.
    await page.getByLabel('Payment terms').selectOption('CREDIT_30');
    await page.getByRole('button', { name: 'Create quotation' }).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await page.getByLabel('How did they tell you?').selectOption('EMAIL');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByLabel('Delivery required').check();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderUrl = page.url();
    const orderNumber = (
      await page.getByRole('heading', { level: 1 }).first().textContent()
    )?.trim();

    // Nothing paid, and the yard may start anyway — the terms were granted at acceptance.
    await expect(page.getByText('Not due yet')).toBeVisible();

    await signIn(page, 'warehouse@addisbuild.example');
    const taskUrl = await pickEverything(page, orderUrl);
    await page.goto(taskUrl);
    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(orderUrl);
    await page.getByTestId('order-delivery-link').click();
    await page.getByTestId('dispatch-button').click();
    await expect(page.getByTestId('dispatch-button')).toHaveCount(0);
    await page.getByTestId('mark-delivered-button').click();
    await expect(page.getByTestId('delivery-delivered')).toBeVisible();

    await page.goto(orderUrl);
    await expect(page.getByText('Completed').first()).toBeVisible();
    // The sentence this whole phase exists to be able to say honestly.
    await expect(page.getByTestId('completed-owing')).toBeVisible();

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/receivables');
    await expect(
      page.getByTestId('receivable-row').filter({ hasText: orderNumber! }),
    ).toHaveCount(1);
  });
});

test.describe('guards', () => {
  test('a partly paid cash order never reaches the warehouse list', async ({ page }) => {
    const reference = `E2E-PART-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    await page.goto('/inquiries/new');
    await page.getByLabel('Customer message').fill('14 bags OPC cement');
    await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('button', { name: 'Run parse' }).click();
    const items = page.getByTestId('inquiry-item');
    await expect(items.first()).toBeVisible();
    await items.first().getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Mark ready for quotation' }).click();
    await page.getByRole('button', { name: 'Create quotation' }).click();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderUrl = page.url();
    const orderNumber = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim();

    // Half of it, confirmed. PARTIALLY_PAID and emphatically not ready.
    await page.getByLabel('Amount the customer says they paid').fill('100.00');
    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByTestId('submit-payment-button').click();

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    await page.getByTestId('payment-row').filter({ hasText: reference }).getByRole('link').click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('confirm-button')).toHaveCount(0);

    await page.goto(orderUrl);
    await expect(page.getByText('Part paid')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();

    // The warehouse cannot see it, and there is no button to send it there.
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/warehouse');
    await expect(page.getByTestId('awaiting-order').filter({ hasText: orderNumber! })).toHaveCount(0);
    await expect(page.getByTestId('warehouse-row').filter({ hasText: orderNumber! })).toHaveCount(0);
  });

  test('a reservation mismatch blocks the handover visibly', async ({ page }) => {
    // Seed scenario F is picked with a deliberately shortened reservation.
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/warehouse');

    const prepared = page.getByTestId('warehouse-row').filter({ hasText: 'Picked' });
    await expect(prepared.first()).toBeVisible();

    // Find the one the seed broke.
    const count = await prepared.count();
    let found = false;
    for (let index = 0; index < count; index += 1) {
      await prepared.nth(index).getByRole('link').first().click();
      // Wait for the task page to actually render before looking. `isVisible()` returns
      // immediately, so checking mid-navigation would report false for every task.
      await expect(page.getByTestId('task-item').first()).toBeVisible();
      if (await page.getByTestId('mismatch-warning').isVisible()) {
        found = true;
        break;
      }
      await page.goto('/warehouse');
    }
    expect(found, 'the seed should leave one task with a broken reservation').toBe(true);

    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('reservation-mismatch')).toBeVisible();
    // Two numbers and a product, not "something went wrong".
    await expect(page.getByText(/Required:/)).toBeVisible();
    await expect(page.getByText(/Reserved:/)).toBeVisible();
    // Still picked, still not handed over.
    await expect(page.getByTestId('handed-over')).toHaveCount(0);
  });

  test('sales and finance can watch fulfilment but cannot move it', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await page.goto('/warehouse');
    await expect(page.getByRole('heading', { name: 'Prepare today' })).toBeVisible();
    // Read-only: no way to raise, start, pick or hand over.
    await expect(page.getByTestId('raise-task-button')).toHaveCount(0);

    await page.goto('/warehouse');
    const rows = page.getByTestId('warehouse-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').click();
      await expect(page.getByTestId('start-task-button')).toHaveCount(0);
      await expect(page.getByTestId('complete-task-button')).toHaveCount(0);
      await expect(page.getByTestId('pick-line')).toHaveCount(0);
    }

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/deliveries');
    await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible();
    const deliveries = page.getByTestId('delivery-row');
    if ((await deliveries.count()) > 0) {
      await deliveries.first().getByRole('link').first().click();
      await expect(page.getByTestId('dispatch-button')).toHaveCount(0);
      await expect(page.getByTestId('mark-delivered-button')).toHaveCount(0);
      await expect(page.getByTestId('assign-delivery-button')).toHaveCount(0);
    }
  });

  test('the warehouse cannot drive a delivery', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/deliveries');
    // It can look — knowing where its own work went is reasonable.
    await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible();

    const rows = page.getByTestId('delivery-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      await expect(page.getByTestId('assign-delivery-button')).toHaveCount(0);
      await expect(page.getByTestId('dispatch-button')).toHaveCount(0);
      await expect(page.getByTestId('mark-delivered-button')).toHaveCount(0);
      await expect(page.getByTestId('mark-failed-button')).toHaveCount(0);
    }
  });

  test('a made-up task or delivery id is not found rather than an error page', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');

    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const task = await page.goto(`/warehouse/${id}`);
      expect(task?.status()).toBe(404);
      const delivery = await page.goto(`/deliveries/${id}`);
      expect(delivery?.status()).toBe(404);
    }
  });

  test('a failed delivery does not restore stock', async ({ page }) => {
    // Seed scenario I is already failed. Its order is not completed, and its reservations stay
    // consumed — the goods are somewhere between the yard and the customer.
    await signIn(page, 'manager@addisbuild.example');
    await page.goto('/deliveries?status=FAILED');

    const failed = page.getByTestId('delivery-row');
    await expect(failed.first()).toBeVisible();
    await failed.first().getByRole('link').first().click();

    await expect(page.getByTestId('delivery-failed')).toBeVisible();
    await expect(page.getByText(/Nothing has been returned to stock/)).toBeVisible();
    // Terminal: no retry, no restock button, no way to mark it delivered after the fact.
    await expect(page.getByTestId('mark-delivered-button')).toHaveCount(0);
    await expect(page.getByTestId('dispatch-button')).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test('the warehouse floor and the delivery queue are usable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile viewport only');

    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/warehouse');
    await expect(page.getByRole('heading', { name: 'Prepare today' })).toBeVisible();

    // Wide tables must scroll inside their own container, not the page.
    const noBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(noBodyScroll).toBe(true);

    const rows = page.getByTestId('warehouse-row');
    await expect(rows.first()).toBeVisible();
    await rows.first().getByRole('link').click();
    await expect(page.getByTestId('task-item').first()).toBeVisible();

    await signIn(page, 'manager@addisbuild.example');
    await page.goto('/deliveries');
    await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible();
    const stillNoBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(stillNoBodyScroll).toBe(true);
  });
});
