import { expect, test } from '@playwright/test';

/**
 * The operational surface, against a running server.
 *
 * These are the endpoints a deploy platform and an uptime check talk to, and the ones nobody
 * exercises until an incident. What is asserted here is mostly what they must *not* contain: a
 * health endpoint is typically the most-probed URL a deployment has, and often reachable before
 * authentication.
 */

test.describe('health', () => {
  test('liveness answers without touching a dependency', async ({ request }) => {
    const response = await request.get('/api/health/live');

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'alive' });
    // Never cached: a cached health check is a health check that lies during an outage.
    expect(response.headers()['cache-control']).toContain('no-store');
  });

  test('readiness reports each dependency', async ({ request }) => {
    const response = await request.get('/api/health/ready');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ready');

    const names = body.checks.map((check: { name: string }) => check.name).sort();
    expect(names).toEqual(['database', 'file-store', 'migrations']);

    for (const check of body.checks) {
      expect(['ok', 'degraded']).toContain(check.status);
      expect(typeof check.latencyMs).toBe('number');
    }
  });

  test('readiness leaks nothing about the infrastructure', async ({ request }) => {
    const body = await (await request.get('/api/health/ready')).text();

    expect(body).not.toMatch(/postgres(ql)?:\/\//);
    expect(body).not.toContain('localhost');
    expect(body).not.toContain('5434');
    expect(body).not.toContain('password');
    // No stack trace, no file path.
    expect(body).not.toMatch(/at\s+\w+\s+\(/);
    expect(body).not.toMatch(/[A-Za-z]:\\/);
  });

  test('the version endpoint identifies the build and nothing more', async ({ request }) => {
    const response = await request.get('/api/version');
    expect(response.status()).toBe(200);

    const body = await response.json();
    // "Which version are you running" is the first question on every support call.
    expect(Object.keys(body).sort()).toEqual(['builtAt', 'commit', 'environment', 'version']);

    // Everything genuinely useful to an attacker is deliberately absent.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/postgres|secret|key|password|token/i);
  });

  test('health is reachable without signing in', async ({ page, request }) => {
    // An uptime check has no session. If these needed one they would be useless.
    await page.context().clearCookies();
    expect((await request.get('/api/health/live')).status()).toBe(200);
    expect((await request.get('/api/version')).status()).toBe(200);
  });
});

test.describe('request correlation', () => {
  test('every response carries an id', async ({ request }) => {
    const response = await request.get('/api/health/live');
    const id = response.headers()['x-correlation-id'];

    expect(id).toMatch(/^req_[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  });

  test('each request gets its own', async ({ request }) => {
    const first = (await request.get('/api/health/live')).headers()['x-correlation-id'];
    const second = (await request.get('/api/health/live')).headers()['x-correlation-id'];
    expect(first).not.toBe(second);
  });

  test('a client-supplied id is ignored', async ({ request }) => {
    // Otherwise a client could choose an id, collide with somebody else's every request, or
    // inject control characters into a log line.
    const response = await request.get('/api/health/live', {
      headers: { 'x-correlation-id': 'req_ATTACKERCHOSEN' },
    });
    expect(response.headers()['x-correlation-id']).not.toBe('req_ATTACKERCHOSEN');
  });
});

test.describe('error discipline', () => {
  test('an unknown page is a plain 404 with no internals', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');
    expect(response?.status()).toBe(404);

    const body = (await page.content()).toLowerCase();
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('postgres');
    /*
     * A server filesystem path, checked precisely.
     *
     * A bare drive-letter pattern matched escaped quotes inside Next's own RSC payload — the
     * assertion was looking for the wrong thing and would have kept failing on a page that leaks
     * nothing at all. These two are what an actual path disclosure looks like.
     */
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain(process.cwd().toLowerCase());
  });

  test('a malformed id in a real route is a 404, not a crash', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Email').fill('owner@addisbuild.example');
    await page.getByLabel('Password').fill('DemoPassword2026');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$|\/\?/);

    for (const path of ['/orders/not-a-uuid', '/warehouse/00000000-0000-0000-0000-000000000000']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);

      const body = (await page.content()).toLowerCase();
      expect(body).not.toContain('prisma');
      expect(body).not.toContain('invalid input syntax');
      expect(body).not.toContain('node_modules');
    }
  });
});

test.describe('login hardening', () => {
  test('a wrong password says nothing about whether the account exists', async ({ page }) => {
    await page.context().clearCookies();

    const messages: string[] = [];
    for (const email of ['owner@addisbuild.example', 'nobody@nowhere.example']) {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('definitely-the-wrong-password');
      await page.getByRole('button', { name: 'Sign in' }).click();

      const error = page.locator('[role="alert"], .text-critical').first();
      await expect(error).toBeVisible();
      messages.push(((await error.textContent()) ?? '').trim());
    }

    // Identical, so the form cannot be used to enumerate who works here.
    expect(messages[0]).toBe(messages[1]);
  });

  test('the session cookie is httpOnly', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('Email').fill('owner@addisbuild.example');
    await page.getByLabel('Password').fill('DemoPassword2026');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$|\/\?/);

    const cookie = (await context.cookies()).find((c) => c.name === 'distributor_session');
    expect(cookie).toBeDefined();
    // Not readable from JavaScript, so an XSS cannot lift the session.
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');

    // And confirmed from the browser's side.
    expect(await page.evaluate(() => document.cookie)).not.toContain('distributor_session');
  });

  test('signing out revokes the session server-side', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('Email').fill('owner@addisbuild.example');
    await page.getByLabel('Password').fill('DemoPassword2026');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$|\/\?/);

    const stolen = (await context.cookies()).find((c) => c.name === 'distributor_session')!.value;

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    // Replaying the cookie somebody copied before logout must not work: the token is revoked in
    // the database, not merely dropped from the browser.
    await context.addCookies([
      { name: 'distributor_session', value: stolen, domain: 'localhost', path: '/' },
    ]);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
