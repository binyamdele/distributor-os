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
 * Walks a credit order to a picked warehouse task, through the real screens.
 *
 * Credit rather than cash, because the payment gate is Phase 5's subject and this file is about
 * what happens when the yard disagrees with the system.
 */
async function pickedTask(
  page: Page,
  bags: number,
): Promise<{ taskUrl: string; orderUrl: string }> {
  await signIn(page, 'sales@addisbuild.example');

  await page.goto('/inquiries/new');
  await page.getByLabel('Customer message').fill(`${bags} bags OPC cement`);
  await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Run parse' }).click();
  const items = page.getByTestId('inquiry-item');
  await expect(items.first()).toBeVisible();
  await items.first().getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('button', { name: 'Mark ready for quotation' }).click();
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
  const orderNumber = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim();

  await signIn(page, 'warehouse@addisbuild.example');
  await page.goto('/warehouse');
  const card = page.getByTestId('awaiting-order').filter({ hasText: orderNumber! });
  await expect(card).toHaveCount(1);
  await card.getByTestId('raise-task-button').click();
  await expect(page).toHaveURL(/\/warehouse\/[0-9a-f-]{36}/);
  const taskUrl = page.url();

  await page.getByTestId('start-task-button').click();
  const rows = page.getByTestId('task-item');
  const lineCount = await rows.count();
  for (let index = 0; index < lineCount; index += 1) {
    const row = rows.nth(index);
    await row.getByTestId('pick-line').click();
    await expect(row.getByTestId('unpick-line')).toBeVisible();
  }
  await page.getByTestId('mark-prepared-button').click();
  await expect(page.getByTestId('prepared-notice')).toBeVisible();

  return { taskUrl, orderUrl };
}

/** Reads the on-hand figure from a warehouse task line — unambiguous, unlike scraping a table. */
async function onHand(page: Page, taskUrl: string): Promise<number> {
  await page.goto(taskUrl);
  const cell = page.getByTestId('task-item').first().locator('td').nth(3);
  return Number(((await cell.textContent()) ?? '0').replace(/[^0-9]/g, ''));
}

test.describe('an inventory discrepancy', () => {
  test('blocks the handoff, and reconciling it lets the goods go', async ({ page }) => {
    const { taskUrl } = await pickedTask(page, 8);
    const before = await onHand(page, taskUrl);

    // --- the warehouse reports what it counted --------------------------
    const line = page.getByTestId('report-line').first();
    await expect(line).toBeVisible();
    await line.getByLabel('How many are actually there?').fill(String(before - 3));
    await line.getByTestId('report-count-button').click();
    await expect(page).toHaveURL(new RegExp(taskUrl.replace(/^https?:\/\/[^/]+/, '') + '$'));

    /*
     * Wait for the report to have landed before navigating anywhere.
     *
     * `click` returns once the click is dispatched, not once the server action it triggers has
     * committed — and the next line navigates, which abandons the in-flight request. The server
     * still records the count, so the database ends up correct while the browser is looking at a
     * page rendered a few milliseconds too early: the discrepancy is open, and the card that
     * announces it is missing.
     *
     * It failed only in the mobile project, and deterministically, which is what made it look
     * like a layout bug. It is not: on a 393px viewport the button sits below the fold, so the
     * click waits for a scroll first and loses the race that the desktop click happens to win.
     * A timing assumption that holds at one viewport and not another is still a timing
     * assumption.
     *
     * Waiting on the action's own visible consequence removes the assumption entirely.
     */
    await expect(page.getByTestId('blocked-by-count')).toBeVisible();

    // Reporting moves nothing. The figure on the line is unchanged.
    expect(await onHand(page, taskUrl)).toBe(before);

    // And the handoff is still blocked after a fresh load, with the reference to follow.
    await expect(page.getByTestId('blocked-by-count')).toBeVisible();
    await page.getByTestId('complete-task-button').click();
    await expect(page.getByText(/^IR-\d{6} is open/)).toBeVisible();

    // The warehouse cannot resolve its own count.
    await expect(page.getByTestId('reconcile-button')).toHaveCount(0);

    // --- the manager reviews and confirms --------------------------------
    await signIn(page, 'manager@addisbuild.example');
    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'Inventory exceptions' })).toBeVisible();

    await page.getByTestId('blocked-link').or(page.getByTestId('exception-row')).first();
    await page.goto(taskUrl);
    await page.getByTestId('blocked-by-count').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/exceptions\/[0-9a-f-]{36}/);

    await expect(page.getByTestId('variance')).toContainText('-3');
    await page.getByTestId('reconcile-button').click();
    await expect(page.getByTestId('resolved-notice')).toBeVisible();

    // --- stock corrected, and the handoff released ------------------------
    await signIn(page, 'warehouse@addisbuild.example');
    expect(await onHand(page, taskUrl)).toBe(before - 3);
    await expect(page.getByTestId('blocked-by-count')).toHaveCount(0);

    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();
  });

  test('cannot be recorded while it would over-promise, until a reservation gives way', async ({
    page,
  }) => {
    const { taskUrl } = await pickedTask(page, 6);
    const before = await onHand(page, taskUrl);

    // Count far below what is committed across all orders.
    const line = page.getByTestId('report-line').first();
    await line.getByLabel('How many are actually there?').fill('1');
    await line.getByTestId('report-count-button').click();

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(taskUrl);
    await page.getByTestId('blocked-by-count').getByRole('link').first().click();

    await page.getByTestId('reconcile-button').click();
    // Asserted on the error element itself rather than by searching the page for the sentence:
    // the refusal is what this test is about, and the message lives in exactly one place.
    const refusal = page.getByTestId('reconcile-error');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('is committed to orders');
    await expect(refusal).toContainText('a reservation has to be reduced');

    // The affected orders are listed, and the shortfall is recorded rather than lost.
    await page.reload();
    await expect(page.getByTestId('shortfall-notice')).toBeVisible();
    await expect(page.getByTestId('affected-order').first()).toBeVisible();

    // Nothing moved.
    await signIn(page, 'warehouse@addisbuild.example');
    expect(await onHand(page, taskUrl)).toBe(before);
  });

  test('the warehouse can report but never resolve', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'Inventory exceptions' })).toBeVisible();

    const rows = page.getByTestId('exception-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      await expect(page).toHaveURL(/\/exceptions\/[0-9a-f-]{36}/);
      // Establishing physical reality is theirs; writing it into stock is not.
      await expect(page.getByTestId('reconcile-button')).toHaveCount(0);
      await expect(page.getByTestId('withdraw-discrepancy-button')).toHaveCount(0);
      await expect(page.getByTestId('reduce-reservation-button')).toHaveCount(0);
    }
  });

  test('a salesperson can look and touch nothing', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'Inventory exceptions' })).toBeVisible();

    const rows = page.getByTestId('exception-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      await expect(page.getByTestId('reconcile-button')).toHaveCount(0);
      await expect(page.getByTestId('reduce-reservation-button')).toHaveCount(0);
    }
  });
});

test.describe('a failed delivery', () => {
  /** Takes a picked task all the way to a failed delivery. */
  async function toFailure(page: Page, bags: number) {
    const { taskUrl, orderUrl } = await pickedTask(page, bags);
    await page.getByTestId('complete-task-button').click();
    await expect(page.getByTestId('handed-over')).toBeVisible();

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(orderUrl);
    await page.getByTestId('order-delivery-link').click();
    await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}/);
    const deliveryUrl = page.url();

    await page.getByTestId('dispatch-button').click();
    await expect(page.getByTestId('dispatch-button')).toHaveCount(0);
    await page.getByTestId('mark-failed-button').click();
    await expect(page.getByTestId('delivery-failed')).toBeVisible();

    return { taskUrl, orderUrl, deliveryUrl };
  }

  test('is retried as a new attempt, with no stock movement', async ({ page }) => {
    const scenario = await toFailure(page, 9);

    await signIn(page, 'warehouse@addisbuild.example');
    const afterShipment = await onHand(page, scenario.taskUrl);

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(scenario.deliveryUrl);
    await expect(page.getByTestId('failure-resolution')).toBeVisible();
    await page.getByTestId('retry-delivery-button').click();
    /*
     * Wait for the retry's own page, not merely for "a delivery URL".
     *
     * The starting page already matched /deliveries/<uuid>, so a URL assertion passes instantly
     * and the identity check then compares the page against itself. The attempt history is the
     * first thing that can only be true once the new attempt exists.
     */
    await expect(page.getByTestId('attempt-history')).toBeVisible();
    expect(page.url()).not.toBe(scenario.deliveryUrl);
    await expect(page.getByTestId('attempt-row')).toHaveCount(2);

    // The invariant: stock is exactly where the original shipment left it.
    await signIn(page, 'warehouse@addisbuild.example');
    expect(await onHand(page, scenario.taskUrl)).toBe(afterShipment);

    // --- the retry succeeds and the order completes ----------------------
    await signIn(page, 'manager@addisbuild.example');
    await page.goto('/deliveries?status=PENDING');
    const pending = page.getByTestId('delivery-row');
    await expect(pending.first()).toBeVisible();
    await page.goto(scenario.orderUrl);
    await page.getByTestId('order-delivery-link').click();
    await page.getByTestId('dispatch-button').click();
    await page.getByTestId('mark-delivered-button').click();
    await expect(page.getByTestId('delivery-delivered')).toBeVisible();

    await page.goto(scenario.orderUrl);
    await expect(page.getByText('Completed').first()).toBeVisible();

    // Still no second consumption.
    await signIn(page, 'warehouse@addisbuild.example');
    expect(await onHand(page, scenario.taskUrl)).toBe(afterShipment);
  });

  test('is returned, and only the sellable portion goes back on the shelf', async ({ page }) => {
    const scenario = await toFailure(page, 10);

    await signIn(page, 'warehouse@addisbuild.example');
    const afterShipment = await onHand(page, scenario.taskUrl);

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(scenario.deliveryUrl);
    await page.getByTestId('record-return-button').click();
    await expect(page).toHaveURL(/\/returns\/[0-9a-f-]{36}/);
    const returnUrl = page.url();

    // --- the warehouse receives and counts -------------------------------
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto(returnUrl);
    await page.getByTestId('receive-return-button').click();
    await expect(page.getByTestId('receive-return-button')).toHaveCount(0);

    const line = page.getByTestId('inspect-line').first();
    const sku = await line.getAttribute('data-sku');
    await line.getByLabel(`Received ${sku}`).fill('10');
    await line.getByLabel(`Sellable ${sku}`).fill('8');
    await line.getByLabel(`Damaged ${sku}`).fill('2');
    await page.getByTestId('inspect-return-button').click();
    await expect(page.getByTestId('complete-return-button')).toBeVisible();

    // Inspection moves nothing.
    expect(await onHand(page, scenario.taskUrl)).toBe(afterShipment);

    await page.goto(returnUrl);
    await page.getByTestId('complete-return-button').click();
    await expect(page.getByTestId('return-completed')).toBeVisible();

    // Only the eight sellable units came back; the two broken ones did not.
    expect(await onHand(page, scenario.taskUrl)).toBe(afterShipment + 8);

    // And every unit is still accounted for.
    await page.goto(returnUrl);
    const accounting = page.getByTestId('return-accounting');
    await expect(accounting).toContainText('10');
    await expect(accounting).toContainText('8');
    await expect(accounting).toContainText('2');
    await expect(page.getByText(/Nothing has been refunded/)).toBeVisible();
  });

  test('refuses a split that does not add up', async ({ page }) => {
    const scenario = await toFailure(page, 7);

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(scenario.deliveryUrl);
    await page.getByTestId('record-return-button').click();
    // Wait for the redirect before reading the URL, or this captures the delivery page.
    await expect(page).toHaveURL(/\/returns\/[0-9a-f-]{36}/);
    const returnUrl = page.url();

    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto(returnUrl);
    await page.getByTestId('receive-return-button').click();

    const line = page.getByTestId('inspect-line').first();
    const sku = await line.getAttribute('data-sku');
    await line.getByLabel(`Received ${sku}`).fill('7');
    await line.getByLabel(`Sellable ${sku}`).fill('3');
    await line.getByLabel(`Damaged ${sku}`).fill('1');
    await page.getByTestId('inspect-return-button').click();

    await expect(page.getByTestId('inspect-error')).toBeVisible();
    await expect(page.getByText(/has to be one or the other/)).toBeVisible();
  });

  test('is written off without restoring stock or touching the money', async ({ page }) => {
    const scenario = await toFailure(page, 5);

    await signIn(page, 'warehouse@addisbuild.example');
    const afterShipment = await onHand(page, scenario.taskUrl);

    await signIn(page, 'manager@addisbuild.example');
    await page.goto(scenario.deliveryUrl);
    await page.getByLabel('What happened to the goods?').fill('Vehicle broken into overnight.');
    await page.getByTestId('mark-lost-button').click();
    await expect(page.getByTestId('failure-resolved')).toBeVisible();

    // Nothing came back.
    await signIn(page, 'warehouse@addisbuild.example');
    expect(await onHand(page, scenario.taskUrl)).toBe(afterShipment);

    // The order carries a visible exception and is not pretending to be finished.
    await signIn(page, 'manager@addisbuild.example');
    await page.goto(scenario.orderUrl);
    await expect(page.getByTestId('order-exception')).toBeVisible();
    await expect(page.getByText('Goods lost')).toBeVisible();
  });

  test('offers no resolution to a role that may not choose one', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/deliveries?status=FAILED');

    const rows = page.getByTestId('delivery-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      // The warehouse handles the physical return; deciding that goods come back at all, or are
      // written off, is a commercial call.
      await expect(page.getByTestId('retry-delivery-button')).toHaveCount(0);
      await expect(page.getByTestId('record-return-button')).toHaveCount(0);
      await expect(page.getByTestId('mark-lost-button')).toHaveCount(0);
    }
  });
});

test.describe('security', () => {
  test('an unauthorized role cannot reach a resolution route', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');

    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'Inventory exceptions' })).toBeVisible();

    const rows = page.getByTestId('exception-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      // Finance sees the problem because somebody has to settle it. It moves no stock.
      await expect(page.getByTestId('reconcile-button')).toHaveCount(0);
      await expect(page.getByTestId('reduce-reservation-button')).toHaveCount(0);
    }

    await page.goto('/returns');
    const returns = page.getByTestId('return-row');
    if ((await returns.count()) > 0) {
      await returns.first().getByRole('link').first().click();
      await expect(page.getByTestId('receive-return-button')).toHaveCount(0);
      await expect(page.getByTestId('complete-return-button')).toHaveCount(0);
    }
  });

  test('a made-up discrepancy or return id is not found', async ({ page }) => {
    await signIn(page, 'manager@addisbuild.example');

    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect((await page.goto(`/exceptions/${id}`))?.status()).toBe(404);
      expect((await page.goto(`/returns/${id}`))?.status()).toBe(404);
    }
  });
});

test.describe('on a phone', () => {
  test('the exception and return screens are usable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile viewport only');

    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/exceptions');
    await expect(page.getByRole('heading', { name: 'Inventory exceptions' })).toBeVisible();

    const noBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(noBodyScroll).toBe(true);

    const rows = page.getByTestId('exception-row');
    if ((await rows.count()) > 0) {
      await rows.first().getByRole('link').first().click();
      await expect(page.getByTestId('variance')).toBeVisible();
    }

    await page.goto('/returns');
    await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
    const stillNoBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(stillNoBodyScroll).toBe(true);
  });
});
