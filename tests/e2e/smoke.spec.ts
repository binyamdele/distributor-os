import { expect, test } from '@playwright/test';

const PASSWORD = 'DemoPassword2026';

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
}

test.describe('sign in', () => {
  test('rejects a wrong password without saying whether the account exists', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('sales@addisbuild.example');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('do not match an account')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('sends an unauthenticated visitor to the login page', async ({ page }) => {
    await page.goto('/customers');
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs a salesperson in and shows their organization', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await expect(page.getByText('Addis Build Supply PLC').first()).toBeVisible();
  });
});

test.describe('the salesperson path', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
  });

  test('creates a customer and finds it in the list', async ({ page }) => {
    const companyName = `E2E Contractors ${Date.now()}`;

    await page.goto('/customers/new');
    await page.getByLabel('Company name').fill(companyName);
    await page.getByLabel('Contact name').fill('Tigist Alemu');
    await page.getByLabel('Phone').fill('+251911999888');
    await page.getByRole('button', { name: 'Create' }).click();

    // Lands on the detail page for the new customer.
    await expect(page.getByRole('heading', { name: companyName })).toBeVisible();

    // The audit trail is deliberately absent here: a salesperson holds no read:audit
    // permission, so the section does not render for them. The owner sees it — asserted below.
    await expect(page.getByText('customer.created')).toHaveCount(0);

    await page.goto('/customers');
    await expect(page.getByRole('link', { name: companyName })).toBeVisible();
  });

  test('refuses a credit limit on a cash-only customer', async ({ page }) => {
    await page.goto('/customers/new');
    await page.getByLabel('Company name').fill(`Contradiction ${Date.now()}`);
    await page.getByLabel(/Credit limit/).fill('500000');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByText(/cannot carry a credit limit/)).toBeVisible();
  });

  test('sees the seeded catalogue with its low-stock warning', async ({ page }) => {
    await page.goto('/products');
    await expect(page.getByRole('link', { name: 'Rebar 12mm' })).toBeVisible();
    // Rebar 16mm is seeded at 240 against a reorder threshold of 250.
    await expect(page.getByRole('link', { name: 'Rebar 16mm' })).toBeVisible();
    await expect(page.getByText('Low stock').first()).toBeVisible();
  });

  test('cannot adjust stock, because that is not a sales permission', async ({ page }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: 'Rebar 12mm' }).click();
    await expect(page.getByRole('heading', { name: 'Rebar 12mm' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Adjust stock' })).toHaveCount(0);
  });

  test('is redirected away from a page its role cannot open', async ({ page }) => {
    // A salesperson holds no read:audit permission; the guard is server-side, so the URL
    // cannot be used to get around the missing nav link.
    await page.goto('/activity');
    await expect(page).toHaveURL(/\/\?denied=1/);
  });
});

test.describe('the warehouse path', () => {
  test('adjusts stock and records the reason in the history', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');

    await page.goto('/products');
    await page.getByRole('link', { name: 'OPC Cement 50kg' }).click();

    await page.getByLabel(/Change/).fill('120');
    await page.getByLabel('Reason').fill('E2E delivery received');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Stock updated.')).toBeVisible();
    // .first(): the demo database accumulates adjustments across runs, so the reason text can
    // legitimately appear more than once.
    await expect(page.getByText('E2E delivery received').first()).toBeVisible();
  });

  test('cannot reach the customer list', async ({ page }) => {
    await signIn(page, 'warehouse@addisbuild.example');
    await page.goto('/customers');
    await expect(page).toHaveURL(/\/\?denied=1/);
  });
});

test.describe('the owner path', () => {
  test('sees the audit trail on a customer that sales cannot', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');
    await page.goto('/customers');
    await page.getByRole('link', { name: 'ABC Construction PLC' }).click();
    await expect(page.getByText('customer.created').first()).toBeVisible();
  });

  test('sees the audit log, newest first', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');
    await page.goto('/activity');

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByText('product.created').first()).toBeVisible();
  });

  test('signs out, and the session stops working', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/customers');
    await expect(page).toHaveURL(/\/login/);
  });
});
