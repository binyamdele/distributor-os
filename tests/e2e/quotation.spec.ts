import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSWORD = 'DemoPassword2026';

async function signIn(page: Page, email: string) {
  // The escalation test signs in twice in one run, and /login redirects an already-authenticated
  // visitor straight to the dashboard. Dropping the cookie first makes a second sign-in work.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
}

/**
 * Takes a message all the way from paste to a ready inquiry, then drafts a quotation from it.
 *
 * Goes through the real Phase 2 screens rather than seeding a ready inquiry, because the join
 * between the two phases is part of what these tests exist to prove.
 */
async function draftQuotation(page: Page, message: string): Promise<string> {
  await page.goto('/inquiries/new');
  await page.getByLabel('Customer message').fill(message);
  await page.getByLabel('Customer (optional)').selectOption({ label: 'ABC Construction PLC' });
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/inquiries\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Run parse' }).click();

  const items = page.getByTestId('inquiry-item');
  // Wait for the parse to render before counting. Counting straight after the click reads zero
  // and silently skips the confirm loop, which then shows up as an unrelated failure further on.
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

  return page.url();
}

test.describe('the quotation happy path', () => {
  test('drafts, discounts within authority, approves and marks sent', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await draftQuotation(page, `200 bags OPC cement and 40 pcs 12mm rebar. Ref ${Date.now()}`);

    // Snapshotted prices from the catalogue.
    const cementLine = page.getByTestId('quotation-line').filter({ hasText: 'OPC Cement 50kg' });
    await expect(cementLine).toContainText('1,250.00');
    await expect(page.getByTestId('grand-total')).toBeVisible();

    // Governance is stated on the page, not hidden.
    await expect(page.getByText('A salesperson may approve this')).toBeVisible();

    // A discount inside the salesperson's own 3% authority.
    await page
      .getByLabel('Discount OPC Cement 50kg')
      .fill('2');
    await page
      .locator('form')
      .filter({ has: page.getByLabel('Discount OPC Cement 50kg') })
      .getByRole('button', { name: 'Save' })
      .click();

    await expect(cementLine).toContainText('2.00%');
    await expect(page.getByText('A salesperson may approve this')).toBeVisible();

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('Awaiting approval')).toBeVisible();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approved', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await expect(page.getByText(/Marked sent/)).toBeVisible();
    await expect(page.getByText(/Nothing was transmitted by this system/)).toBeVisible();
  });
});

test.describe('manager escalation', () => {
  test('a salesperson cannot approve a manager-level discount, and a manager can', async ({
    page,
  }) => {
    await signIn(page, 'sales@addisbuild.example');
    const url = await draftQuotation(page, `100 bags OPC cement. Ref ${Date.now()}`);

    // 6% is past the 3% salesperson limit but inside the 10% manager limit.
    await page.getByLabel('Discount OPC Cement 50kg').fill('6');
    await page
      .locator('form')
      .filter({ has: page.getByLabel('Discount OPC Cement 50kg') })
      .getByRole('button', { name: 'Save' })
      .click();

    await expect(page.getByText('A sales manager must approve this')).toBeVisible();

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('Awaiting approval')).toBeVisible();

    // The salesperson holds no manager approval permission, so no approve button is offered.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByText('Your role cannot approve at this level')).toBeVisible();

    // The manager can.
    await signIn(page, 'manager@addisbuild.example');
    await page.goto(url);
    await expect(page.getByText('A sales manager must approve this')).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect(page.getByText('Approved', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await expect(page.getByText(/Marked sent/)).toBeVisible();
  });

  test('blocks a discount past the manager ceiling instead of escalating it', async ({ page }) => {
    await signIn(page, 'manager@addisbuild.example');
    await draftQuotation(page, `50 bags OPC cement. Ref ${Date.now()}`);

    await page.getByLabel('Discount OPC Cement 50kg').fill('25');
    await page
      .locator('form')
      .filter({ has: page.getByLabel('Discount OPC Cement 50kg') })
      .getByRole('button', { name: 'Save' })
      .click();

    await expect(page.getByText('This cannot be approved as it stands')).toBeVisible();
    await expect(page.getByText(/there is no signature that unlocks this/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  });
});

test.describe('approval invalidation', () => {
  test('an edit after approval withdraws it and blocks sending', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await draftQuotation(page, `80 bags OPC cement. Ref ${Date.now()}`);

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark as sent' })).toBeEnabled();

    // Change an approval-sensitive figure.
    await page.getByLabel('Quantity OPC Cement 50kg').fill('81');
    await page
      .locator('form')
      .filter({ has: page.getByLabel('Quantity OPC Cement 50kg') })
      .getByRole('button', { name: 'Save' })
      .click();

    // The page says so immediately, and sending is no longer offered.
    await expect(page.getByText('Draft')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark as sent' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
  });
});

test.describe('quotation permissions', () => {
  test('finance can read a quotation but not price or approve it', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');
    await page.goto('/quotations');
    await expect(page.getByRole('heading', { name: 'Quotations' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  });

  test('warehouse cannot reach quotations at all', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/quotations');
    await expect(page).toHaveURL(/\/\?denied=1/);
  });
});

test.describe('mobile', () => {
  test('the quotation review works at a phone width', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'only meaningful in the mobile project');

    await signIn(page, 'sales@addisbuild.example');
    await draftQuotation(page, `60 bags OPC cement. Ref ${Date.now()}`);

    await expect(page.getByTestId('quotation-line')).toHaveCount(1);
    await expect(page.getByTestId('grand-total')).toBeVisible();
    await expect(page.getByText('A salesperson may approve this')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, 'the quotation page scrolls horizontally on mobile').toBe(false);

    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await expect(page.getByText(/Marked sent/)).toBeVisible();
  });
});
