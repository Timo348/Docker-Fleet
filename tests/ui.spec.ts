import { test, expect } from '@playwright/test';
import { join } from 'node:path';
test.skip(
  !process.env.FLEET_TEST_URL,
  'Run npm run test:integration to provision actual isolated Docker test hosts.',
);
test('two-host resources, filters, navigation, logs and host configuration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Containers', exact: true })).toBeVisible();
  await expect(page.getByText('LOCAL DEV')).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: 'same-name' })).toHaveCount(2);
  await page.getByLabel('Filter by host').selectOption('one');
  await expect(page.locator('tbody tr').filter({ hasText: 'same-name' })).toHaveCount(1);
  await page.getByLabel('Search resources').fill('not-present');
  await expect(page.getByText('No matching resources')).toBeVisible();
  await page.getByLabel('Search resources').fill('');
  await page.getByLabel('Filter by host').selectOption('all');
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody').getByText('Unavailable')).toHaveCount(2);
  await page.getByRole('button', { name: 'Containers', exact: true }).click();
  await page
    .getByRole('button', { name: 'Logs for same-name on Test Host one', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('real-docker-log', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.log-output script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause follow' }).click();
  await expect(page.getByRole('button', { name: 'Resume follow' })).toBeVisible();
  await page.getByLabel('Filter logs').fill('stderr-marker');
  await expect(page.locator('.log-line').first()).toContainText('stderr-marker');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toContain('logs-one-same-name');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hosts & settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add host', exact: true }).click();
  await page.getByLabel('Host ID', { exact: true }).fill('disabled-new');
  await page.getByLabel('Display name', { exact: true }).fill('Disabled added host');
  await page
    .getByLabel('Agent endpoint', { exact: true })
    .fill('https://unconfigured.example.invalid:9443');
  await page.getByLabel('Host enabled', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tbody tr').filter({ hasText: 'Disabled added host' })).toBeVisible();
});
test('an expired proxy session keeps the previous resource table and explains reauthentication', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('tbody tr').filter({ hasText: 'same-name' })).toHaveCount(2);
  await page.route('**/api/resources', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html>Authentication required</html>',
    }),
  );
  await expect(page.getByRole('alert')).toContainText('Reload to sign in', { timeout: 8000 });
  await expect(page.locator('tbody tr').filter({ hasText: 'same-name' })).toHaveCount(2);
});
test('compact desktop and contained mobile overflow', async ({ page }) => {
  const artifactDir = process.env.FLEET_TEST_ARTIFACTS || 'test-results';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('tbody tr').filter({ hasText: 'same-name' })).toHaveCount(2);
  await page.screenshot({ path: join(artifactDir, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Filter by host')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .getByRole('button', { name: 'Logs for same-name on Test Host one', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Close logs', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'mobile.png'), fullPage: true });
});
