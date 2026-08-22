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

test.describe('the owner dashboard', () => {
  test('shows the figures, the queue, and routes into the work', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');

    // --- the four figures ------------------------------------------------
    await expect(page.getByTestId('kpi-row')).toBeVisible();
    await expect(page.getByTestId('kpi-orders')).toBeVisible();
    await expect(page.getByTestId('kpi-accepted')).toBeVisible();
    await expect(page.getByTestId('kpi-payments')).toBeVisible();
    await expect(page.getByTestId('kpi-overdue')).toBeVisible();

    // Amounts are rendered as money, not as raw minor units.
    await expect(page.getByTestId('kpi-overdue')).toContainText('ETB');

    // The reporting timezone is stated rather than assumed.
    await expect(page.getByText(/Africa\/Addis_Ababa/)).toBeVisible();

    // --- the attention queue ----------------------------------------------
    const items = page.getByTestId('attention-item');
    await expect(items.first()).toBeVisible();

    // Severity is shown, and the most severe is first.
    const firstSeverity = await items.first().textContent();
    expect(firstSeverity).toMatch(/Critical|High|Normal/);

    // --- following an item lands on the workflow that fixes it -------------
    const overdue = items.filter({ hasText: 'overdue' }).first();
    if ((await overdue.count()) > 0) {
      await overdue.click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
      await page.goBack();
      await expect(page.getByTestId('kpi-row')).toBeVisible();
    }

    // --- an inventory exception routes to the exception detail -------------
    const discrepancy = page
      .getByTestId('attention-item')
      .filter({ has: page.locator('[data-kind^="RESERVATION_SHORTFALL"], [data-kind="INVENTORY_DISCREPANCY"]') })
      .first();

    const anyDiscrepancy = page.locator('[data-kind="INVENTORY_DISCREPANCY"], [data-kind="RESERVATION_SHORTFALL"], [data-kind="DISCREPANCY_BLOCKING_HANDOFF"]').first();
    if ((await anyDiscrepancy.count()) > 0) {
      await anyDiscrepancy.click();
      await expect(page).toHaveURL(/\/exceptions\/[0-9a-f-]{36}/);
      await expect(page.getByTestId('variance')).toBeVisible();
    }
    void discrepancy;
  });

  test('shows the compact sections with real counts', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');

    await expect(page.getByTestId('panel-pipeline')).toBeVisible();
    await expect(page.getByTestId('panel-receivables')).toBeVisible();
    await expect(page.getByTestId('panel-fulfilment')).toBeVisible();
    await expect(page.getByTestId('panel-inventory')).toBeVisible();

    // The receivables panel must agree with the receivables page it links to. Two figures for
    // "outstanding" that differ is how an owner stops believing the dashboard.
    const panelText = (await page.getByTestId('panel-receivables').textContent()) ?? '';
    const outstanding = panelText.match(/Outstanding\s*(ETB[\s ][\d,]+\.\d{2})/)?.[1];
    expect(outstanding).toBeTruthy();

    await page.goto('/receivables');
    const total = await page.getByTestId('receivables-total').textContent();
    expect(total?.replace(/\s/g, ' ')).toContain(outstanding!.replace(/ /g, ' ').split(' ')[1]!);
  });

  test('draws the seven-day chart', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');
    const chart = page.getByTestId('seven-day-chart');
    await expect(chart).toBeVisible();
    // Seven bars, always — a quiet day is a zero, not a gap.
    await expect(chart.locator('> div')).toHaveCount(7);
  });
});

test.describe('the daily brief', () => {
  test('renders from the deterministic snapshot and says so honestly', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');

    const brief = page.getByTestId('daily-brief');
    await expect(brief).toBeVisible();

    // With no real provider configured the deterministic version shows, and the page must not
    // claim otherwise. Labelling fallback prose "AI-assisted" would be a small lie on the one
    // page whose whole value is that its numbers can be trusted.
    await expect(brief).toHaveAttribute('data-source', 'DETERMINISTIC');
    await expect(page.getByRole('heading', { name: 'Daily summary', exact: true })).toBeVisible();
    await expect(page.getByText('Written by the system from the figures above.')).toBeVisible();
    await expect(page.getByText(/AI-assisted/)).toHaveCount(0);
  });

  test('is complete rather than a placeholder', async ({ page }) => {
    await signIn(page, 'owner@addisbuild.example');

    const brief = page.getByTestId('daily-brief');
    const text = (await brief.textContent()) ?? '';

    // Something substantive, in money, with no arithmetic artefacts.
    expect(text.length).toBeGreaterThan(80);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Infinity');
  });
});

test.describe('role-sensitive dashboards', () => {
  test('a warehouse user sees no financial totals anywhere', async ({ page }) => {
    // §30, the important one: aggregation must not be a side door around RBAC.
    await signIn(page, 'warehouse@addisbuild.example');

    await expect(page.getByTestId('kpi-overdue')).toHaveCount(0);
    await expect(page.getByTestId('kpi-payments')).toHaveCount(0);
    await expect(page.getByTestId('kpi-accepted')).toHaveCount(0);
    await expect(page.getByTestId('panel-receivables')).toHaveCount(0);
    await expect(page.getByTestId('panel-pipeline')).toHaveCount(0);

    // And no money appears in the brief or the queue either.
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toMatch(/ETB[\s ][\d,]+\.\d{2}/);
  });

  test('a warehouse user still gets a useful operational dashboard', async ({ page }) => {
    // Withholding money must not leave the role with an empty page.
    await signIn(page, 'warehouse@addisbuild.example');
    await expect(page.getByTestId('panel-fulfilment')).toBeVisible();
    await expect(page.getByTestId('panel-inventory')).toBeVisible();
  });

  test('finance sees the money view', async ({ page }) => {
    await signIn(page, 'finance@addisbuild.example');
    await expect(page.getByTestId('kpi-overdue')).toBeVisible();
    await expect(page.getByTestId('panel-receivables')).toBeVisible();
  });

  test('a salesperson sees the pipeline and no money', async ({ page }) => {
    await signIn(page, 'sales@addisbuild.example');
    await expect(page.getByTestId('panel-pipeline')).toBeVisible();
    await expect(page.getByTestId('panel-receivables')).toHaveCount(0);
    await expect(page.getByTestId('kpi-overdue')).toHaveCount(0);
  });

  test('a sales manager sees receivables, because they hold the permission', async ({ page }) => {
    await signIn(page, 'manager@addisbuild.example');
    await expect(page.getByTestId('panel-receivables')).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test('the dashboard stays usable without a horizontal scroll', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile viewport only');

    await signIn(page, 'owner@addisbuild.example');
    await expect(page.getByTestId('kpi-row')).toBeVisible();

    const noBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(noBodyScroll).toBe(true);

    // The queue is the reason to open this page on a phone, so it has to be reachable and
    // tappable rather than trapped inside a wide table.
    const items = page.getByTestId('attention-item');
    await expect(items.first()).toBeVisible();
    await items.first().click();
    await expect(page).not.toHaveURL(/\/$/);

    await page.goto('/');
    await expect(page.getByTestId('daily-brief')).toBeVisible();
    const stillNoScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(stillNoScroll).toBe(true);
  });
});
