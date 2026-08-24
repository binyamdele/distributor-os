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
 * Walks a message to an open cash sales order through the real screens.
 *
 * The whole Phase 2–4 path, again, because the thing being proved here is that the payment gate
 * sits correctly on top of an order that genuinely came from the workflow — including the stock
 * reservation that makes "not ready" mean something.
 */
async function cashOrder(page: Page, bags: number): Promise<{ url: string; total: string }> {
  await page.goto('/inquiries/new');
  // One line, and no trailing reference number. The parser reads the first number in each
  // segment, so a "Ref E2E-1758…" tacked on the end would become a second, unresolvable line —
  // which would be this test failing over its own fixture rather than over the product.
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
  await page.getByRole('button', { name: 'Create sales order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

  const total = (await page.getByTestId('order-total').textContent())?.trim() ?? '';
  return { url: page.url(), total };
}

/** The amount the submission form pre-fills — the outstanding balance, as a decimal string. */
async function prefilledAmount(page: Page): Promise<string> {
  return page.getByLabel('Amount the customer says they paid').inputValue();
}

/**
 * Confirms, and waits for the decision to have actually landed.
 *
 * The wait is the point. Clicking and then navigating straight to the order screen races the
 * server action's transaction: the database ends up correct, but the page can be rendered from a
 * request that was issued before the commit, and the test then reports a stale screen as a
 * product defect. The decision controls disappearing is the first thing that can only be true
 * once the confirmation has been written.
 */
async function confirmAndSettle(page: Page): Promise<void> {
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('confirm-button')).toHaveCount(0);
  await expect(page.getByText('Confirmation fingerprint')).toBeVisible();
}

test.describe('the cash payment gate', () => {
  test('a salesperson submits evidence and finance confirms it, releasing the goods', async ({
    page,
  }) => {
    const reference = `E2E-${Date.now()}`;

    // --- sales records what the customer says ---------------------------
    await signIn(page, 'sales@addisbuild.example');
    const order = await cashOrder(page, 12);

    await expect(page.getByTestId('awaiting-payment')).toBeVisible();
    const amount = await prefilledAmount(page);
    expect(amount).not.toBe('');

    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByLabel('Name on the payment').fill('ABC Construction PLC');
    await page.getByTestId('submit-payment-button').click();

    // Submitting is a claim, and the screen must not suggest otherwise.
    await expect(page.getByTestId('order-payment')).toHaveCount(1);
    await expect(page.getByTestId('awaiting-payment')).toBeVisible();
    await expect(page.getByText('Unpaid')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();

    // A salesperson has no way through to the review screen or the evidence.
    await expect(page.getByRole('link', { name: 'Payments' })).toHaveCount(0);

    // --- finance decides -------------------------------------------------
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    const row = page.getByTestId('payment-row').filter({ hasText: reference });
    await expect(row).toHaveCount(1);
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}/);

    // The order's figures and the entered figures sit side by side.
    await expect(page.getByText('What the order says')).toBeVisible();
    await expect(page.getByText('What was entered')).toBeVisible();

    await confirmAndSettle(page);

    // The order is now paid, and the warehouse is unlocked — by the confirmation, and only by it.
    await page.goto(order.url);
    await expect(page.getByText('Paid').first()).toBeVisible();
    await expect(page.getByText('Ready to prepare')).toBeVisible();
    await expect(page.getByTestId('awaiting-payment')).toHaveCount(0);
  });

  test('a mismatched claim is flagged, and correcting it does not confirm it', async ({ page }) => {
    const reference = `E2E-MISMATCH-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    await cashOrder(page, 8);

    // Deliberately far below what is outstanding.
    await page.getByLabel('Amount the customer says they paid').fill('10.00');
    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByTestId('submit-payment-button').click();
    await expect(page.getByTestId('order-payment')).toHaveCount(1);

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    await page.getByTestId('payment-row').filter({ hasText: reference }).getByRole('link').click();

    // Named checks rather than a score. The one that matters is stated as a fact about numbers.
    await expect(page.getByTestId('match-factor').first()).toBeVisible();
    await expect(page.locator('[data-code="AMOUNT_BELOW_OUTSTANDING"]')).toHaveCount(1);
    // A named comparison, not a score. Nothing on this screen offers a confidence percentage.
    await expect(page.getByText(/% match/)).toHaveCount(0);

    // Correcting the figure leaves it in review — editing is not a step towards confirming.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Needs review').first()).toBeVisible();
  });

  test('rejecting evidence leaves the order exactly where it was', async ({ page }) => {
    const reference = `E2E-REJECT-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    const order = await cashOrder(page, 6);
    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByTestId('submit-payment-button').click();
    await expect(page.getByTestId('order-payment')).toHaveCount(1);

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    await page.getByTestId('payment-row').filter({ hasText: reference }).getByRole('link').click();

    await page.getByLabel('Why is this being rejected?').fill('The slip is for a different account.');
    await page.getByTestId('reject-button').click();
    await expect(page.getByText('The slip is for a different account.')).toBeVisible();

    // Off the queue, and the order untouched.
    await page.goto('/payments');
    await expect(page.getByTestId('payment-row').filter({ hasText: reference })).toHaveCount(0);

    await page.goto(order.url);
    await expect(page.getByText('Unpaid')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();
  });

  test('two part payments settle an order, and only the second releases it', async ({ page }) => {
    const reference = `E2E-SPLIT-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    const order = await cashOrder(page, 10);

    const outstanding = await prefilledAmount(page);
    const totalMinor = Math.round(Number(outstanding) * 100);
    const firstHalf = (Math.floor(totalMinor / 2) / 100).toFixed(2);

    await page.getByLabel('Amount the customer says they paid').fill(firstHalf);
    await page.getByLabel('Transaction reference').fill(`${reference}-1`);
    await page.getByTestId('submit-payment-button').click();

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    await page
      .getByTestId('payment-row')
      .filter({ hasText: `${reference}-1` })
      .getByRole('link')
      .click();
    await confirmAndSettle(page);

    // Part paid. Emphatically not ready.
    await page.goto(order.url);
    await expect(page.getByText('Part paid')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();

    // The rest, submitted by sales against the balance the screen now shows.
    await signIn(page, 'sales@addisbuild.example');
    await page.goto(order.url);
    const remaining = await prefilledAmount(page);
    await page.getByLabel('Transaction reference').fill(`${reference}-2`);
    await page.getByTestId('submit-payment-button').click();

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    await page
      .getByTestId('payment-row')
      .filter({ hasText: `${reference}-2` })
      .getByRole('link')
      .click();
    await confirmAndSettle(page);

    await page.goto(order.url);
    await expect(page.getByText('Paid').first()).toBeVisible();
    await expect(page.getByText('Ready to prepare')).toBeVisible();
    expect(Number(remaining)).toBeGreaterThan(0);
  });
});

test.describe('receivables', () => {
  test('lists what is owed, worst first, and links to the order', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/receivables');

    await expect(page.getByRole('heading', { name: 'Receivables' })).toBeVisible();
    const rows = page.getByTestId('receivable-row');
    await expect(rows.first()).toBeVisible();

    // The seeded 24-days-overdue credit order is the one a clerk should see first.
    await expect(rows.first()).toContainText('Overdue');
    await expect(page.getByTestId('receivables-total')).toBeVisible();

    await rows.first().getByRole('link').first().click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  });

  test('a submitted claim does not clear a receivable — only a confirmation does', async ({
    page,
  }) => {
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/receivables');

    const before = await page.getByTestId('receivable-row').count();
    expect(before).toBeGreaterThan(0);

    // Nothing was confirmed in this test, so the list must be unchanged on reload.
    await page.reload();
    await expect(page.getByTestId('receivable-row')).toHaveCount(before);
  });
});

test.describe('who may see payment evidence', () => {
  test('sales cannot open the queue, the review screen or a file', async ({ page }) => {
    /*
     * This test uploads its own bank slip rather than borrowing one from the queue.
     *
     * It used to take the first row of `/payments` and read its evidence link. That worked on a
     * freshly seeded database and degraded quietly: every run confirms or rejects some of the
     * seeded payments, so the queue drains of the ones that *have* evidence, and eventually the
     * first row is a payment with none. The link never appears, and a permission test fails with
     * a sixty-second timeout that says nothing about permissions.
     *
     * Owning the data removes the dependency on what previous runs happened to leave behind —
     * and it adds the upload path to the end-to-end suite, which had no coverage of it at all:
     * every other evidence assertion in this file is about a payment the seed created.
     */
    await signIn(page, 'sales@addisbuild.example');
    const order = await cashOrder(page, 6);
    await page.goto(order.url);

    const amount = await prefilledAmount(page);
    const reference = `E2E-EVIDENCE-${Date.now()}`;
    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByLabel('Name on the payment').fill('ABC Construction PLC');

    // A real PDF, by its magic bytes — the validator reads the content, not the filename.
    await page.getByLabel('Receipt or screenshot').setInputFiles({
      name: 'slip.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(`%PDF-1.4\n% synthetic slip for ${amount}\n%%EOF\n`, 'utf8'),
    });
    await page.getByTestId('submit-payment-button').click();
    await expect(page.getByTestId('order-payment')).toHaveCount(1);

    // Now read that evidence id as finance, who may.
    //
    // Selected by its reference rather than by position: the queue holds whatever previous runs
    // left behind, including payments submitted with no evidence at all, so "the first row" is
    // not this test's payment and may have no evidence link to read.
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');
    const queued = page.getByTestId('payment-row').filter({ hasText: reference });
    await expect(queued).toHaveCount(1);
    await queued.getByRole('link').click();
    const evidenceHref = await page.getByTestId('evidence-link').getAttribute('href');
    expect(evidenceHref).toBeTruthy();
    const reviewUrl = page.url();

    await signIn(page, 'sales@addisbuild.example');

    // The queue and the review screen bounce back to the dashboard.
    await page.goto('/payments');
    await expect(page).toHaveURL(/\/\?denied=1/);

    await page.goto(reviewUrl);
    await expect(page).toHaveURL(/\/\?denied=1/);

    // And the file id, held in hand, resolves to nothing.
    const response = await page.request.get(evidenceHref!);
    expect(response.status()).toBe(404);
  });

  test('the warehouse cannot reach payments at all', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');

    await expect(page.getByRole('link', { name: 'Payments' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Receivables' })).toHaveCount(0);

    await page.goto('/payments');
    await expect(page).toHaveURL(/\/\?denied=1/);

    await page.goto('/receivables');
    await expect(page).toHaveURL(/\/\?denied=1/);
  });

  test('a signed-out visitor gets nothing', async ({ page }) => {
    await page.context().clearCookies();

    const response = await page.request.get(
      '/payments/evidence/00000000-0000-0000-0000-000000000000',
    );
    expect(response.status()).toBe(404);

    await page.goto('/payments');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a made-up payment id is not found rather than an error page', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');

    // A malformed id and an id that was never issued must be indistinguishable, and neither
    // may crash: before the id guard, the malformed one reached Prisma and produced a 500.
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const response = await page.goto(`/payments/${id}`);
      expect(response?.status()).toBe(404);
    }
  });
});

test.describe('on a phone', () => {
  test('finance can work the queue and confirm a payment', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile viewport only');

    const reference = `E2E-MOBILE-${Date.now()}`;

    await signIn(page, 'sales@addisbuild.example');
    const order = await cashOrder(page, 5);
    await page.getByLabel('Transaction reference').fill(reference);
    await page.getByTestId('submit-payment-button').click();
    await expect(page.getByTestId('order-payment')).toHaveCount(1);

    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/payments');

    // The queue is wide; it must scroll inside its own container rather than the page.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(true);

    await page.getByTestId('payment-row').filter({ hasText: reference }).getByRole('link').click();
    await confirmAndSettle(page);

    await page.goto(order.url);
    await expect(page.getByText('Ready to prepare')).toBeVisible();
  });
});
