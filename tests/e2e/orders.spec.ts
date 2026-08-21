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
 * Walks a message all the way to a SENT quotation through the real screens.
 *
 * Slower than seeding one, and the point: the join between Phase 2, Phase 3 and Phase 4 is part
 * of what these tests exist to prove.
 */
async function sentQuotation(page: Page, message: string): Promise<string> {
  await page.goto('/inquiries/new');
  await page.getByLabel('Customer message').fill(message);
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
  await expect(page.getByText('Ready for quotation')).toBeVisible();

  await page.getByRole('button', { name: 'Create quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText(/Marked sent/)).toBeVisible();

  return page.url();
}

test.describe('the follow-up queue', () => {
  test('shows a sent quotation and records the outcome', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    const quotationUrl = await sentQuotation(page, `40 bags OPC cement. Ref ${Date.now()}`);

    // The follow-up is scheduled with the send, and shows on the quotation.
    await expect(page.getByRole('heading', { name: 'Follow-up history' })).toBeVisible();
    const quotationNumber = (
      await page.getByRole('heading', { level: 1 }).first().textContent()
    )?.trim();
    expect(quotationNumber).toMatch(/^Q-\d+$/);

    // The queue includes upcoming work, so a freshly sent quotation is visible immediately.
    await page.goto('/follow-ups');
    await expect(page.getByRole('heading', { name: 'Follow up today' })).toBeVisible();

    // Scoped to *this* quotation. Other tests leave their own quotations in the shared demo
    // queue, so asserting the queue is empty would be asserting something about them.
    const card = page.getByTestId('follow-up').filter({ hasText: quotationNumber! });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('ABC Construction PLC');

    await card.getByLabel('What happened?').selectOption('CUSTOMER_CONSIDERING');
    await card.getByLabel('Note').fill('Checking their site schedule');
    await card.getByRole('button', { name: 'Save outcome' }).click();

    // Completed, so this one leaves the queue.
    await expect(card).toHaveCount(0);

    await page.goto(quotationUrl);
    await expect(page.getByText('Customer is considering it')).toBeVisible();
  });
});

test.describe('accepting and converting', () => {
  test('records acceptance, creates the order and reserves stock', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await sentQuotation(page, `30 bags OPC cement. Ref ${Date.now()}`);

    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();

    await expect(page.getByText('Customer accepted')).toBeVisible();
    // Stated plainly: a record of a conversation, not a signature.
    await expect(page.getByText(/not an electronic signature/)).toBeVisible();

    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

    // Cash order: money outstanding, and the warehouse is explicitly not unlocked.
    await expect(page.getByTestId('awaiting-payment')).toBeVisible();
    await expect(page.getByText(/not released until finance confirms payment/)).toBeVisible();
    await expect(page.getByText('Unpaid')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();

    // The reservation is visible and attributed to this order.
    await expect(page.getByRole('heading', { name: /Stock reservations/ })).toBeVisible();
    await expect(page.getByText('ACTIVE').first()).toBeVisible();
  });

  test('the follow-up disappears once the customer has answered', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await sentQuotation(page, `25 bags OPC cement. Ref ${Date.now()}`);

    await page.getByLabel('How did they tell you?').selectOption('IN_PERSON');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await expect(page.getByText('Customer accepted')).toBeVisible();

    // Nobody should be asked to chase a quotation the customer already answered.
    await page.goto('/follow-ups');
    const cards = page.getByTestId('follow-up');
    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      await expect(cards.nth(index)).not.toContainText('Ref');
    }
  });

  test('does not create a second order for the same quotation', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    const quotationUrl = await sentQuotation(page, `20 bags OPC cement. Ref ${Date.now()}`);

    await page.getByLabel('How did they tell you?').selectOption('MESSAGE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    const orderUrl = page.url();

    // Going back and pressing again must land on the same order, not raise another.
    await page.goto(quotationUrl);
    await expect(page.getByRole('button', { name: 'Create sales order' })).toHaveCount(0);
    await expect(page.getByText(/Converted to/)).toBeVisible();

    // toHaveURL waits for the navigation; reading page.url() straight after a click does not.
    await page.getByRole('link', { name: /^SO-/ }).click();
    await expect(page).toHaveURL(orderUrl);
  });
});

test.describe('a credit order', () => {
  test('is ready to prepare with nothing owed yet', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');

    await page.goto('/inquiries/new');
    await page.getByLabel('Customer message').fill(`15 bags OPC cement. Ref ${Date.now()}`);
    await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
    await page.getByRole('button', { name: 'Create' }).click();

    await page.getByRole('button', { name: 'Run parse' }).click();
    const items = page.getByTestId('inquiry-item');
    await expect(items.first()).toBeVisible();
    await items.first().getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('button', { name: 'Mark ready for quotation' }).click();

    // ABC Construction is credit-allowed, so credit terms are offered.
    await page.getByLabel('Payment terms').selectOption('CREDIT_30');
    await page.getByRole('button', { name: 'Create quotation' }).click();

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as sent' }).click();

    await page.getByLabel('How did they tell you?').selectOption('EMAIL');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    await expect(page.getByText('Not due yet')).toBeVisible();
    await expect(page.getByText('Ready to prepare')).toBeVisible();
    await expect(page.getByText(/Warehouse preparation is not part of this phase/)).toBeVisible();
  });
});

test.describe('insufficient stock', () => {
  test('refuses with exact numbers and reserves nothing', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    // Rebar 16mm is seeded at 240; ask for more than exists.
    await sentQuotation(page, `400 pcs 16mm rebar. Ref ${Date.now()}`);

    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();

    // A specific refusal, not "something went wrong".
    const shortfall = page.getByTestId('stock-shortfall');
    await expect(shortfall).toBeVisible();
    await expect(shortfall).toContainText('Rebar 16mm');
    await expect(shortfall).toContainText('Requested: 400');
    await expect(shortfall).toContainText('Short by');
    await expect(shortfall).toContainText(/Nothing was reserved/);

    // The quotation is untouched and still convertible once stock arrives.
    await expect(page.getByRole('button', { name: 'Create sales order' })).toBeVisible();
  });
});

test.describe('cancellation', () => {
  test('releases the stock it held', async ({ page }) => {
    await signIn(page, 'manager@addisbuild.example');
    await sentQuotation(page, `10 bags OPC cement. Ref ${Date.now()}`);

    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

    await page.getByLabel('Why is it being cancelled?').fill('Site postponed');
    await page.getByRole('button', { name: 'Cancel order' }).click();

    await expect(page.getByText(/cancelled and its stock released/)).toBeVisible();
    await expect(page.getByText('RELEASED').first()).toBeVisible();
  });
});

test.describe('order permissions', () => {
  test('a salesperson cannot cancel an order', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await sentQuotation(page, `12 bags OPC cement. Ref ${Date.now()}`);
    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  });

  test('warehouse can read an order but not reach follow-ups', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Sales orders' })).toBeVisible();

    await page.goto('/follow-ups');
    await expect(page).toHaveURL(/\/\?denied=1/);
  });

  test('finance can read orders but not create one', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Sales orders' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create sales order' })).toHaveCount(0);
  });
});

test.describe('mobile', () => {
  test('the follow-up queue and order detail stay usable at a phone width', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'only meaningful in the mobile project');

    await signIn(page, 'sales@addisbuild.example');
    await sentQuotation(page, `18 bags OPC cement. Ref ${Date.now()}`);

    await page.goto('/follow-ups');
    await expect(page.getByTestId('follow-up').first()).toBeVisible();

    let overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, 'the follow-up queue scrolls horizontally on mobile').toBe(false);

    await page.goto('/quotations');
    await page.getByRole('link', { name: /^Q-/ }).first().click();
    await page.getByLabel('How did they tell you?').selectOption('PHONE');
    await page.getByRole('button', { name: 'Record accepted' }).click();
    await page.getByRole('button', { name: 'Create sales order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);

    await expect(page.getByTestId('order-total')).toBeVisible();
    overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, 'the order page scrolls horizontally on mobile').toBe(false);
  });
});
