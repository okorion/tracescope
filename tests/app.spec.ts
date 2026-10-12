import { expect, test } from '@playwright/test'

const fixture = (id = 9001, name = 'fixture precise request') => ({
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'fixture-service' } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: id.toString(16).padStart(32, '0'),
              spanId: '0000000000000001',
              name,
              startTimeUnixNano: '1780000000000000001',
              endTimeUnixNano: '1780000000123456789',
              status: { code: 2 },
              attributes: [{ key: 'test.source', value: { stringValue: 'synthetic E2E fixture' } }],
            },
          ],
        },
      ],
    },
  ],
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Rust engine ready')).toBeVisible()
  await expect(page.locator('.trace-row')).toHaveCount(8)
})

test('WASM startup, real sample, search, filter, sorting and pagination', async ({ page }) => {
  await expect(
    page.locator('.metric-card').filter({ hasText: 'TOTAL TRACES' }).locator('.metric-value'),
  ).toHaveText('12')
  await expect(
    page.locator('.metric-card').filter({ hasText: 'TOTAL SPANS' }).locator('.metric-value'),
  ).toHaveText('120')
  await expect(page.getByLabel('Span Waterfall')).toBeVisible()
  await page.getByRole('button', { name: '다음 트레이스 페이지' }).click()
  await expect(page.locator('.trace-row')).toHaveCount(4)
  await page.getByRole('button', { name: '이전 트레이스 페이지' }).click()
  await page
    .getByRole('textbox', { name: '서비스, Operation, Trace ID 검색' })
    .fill('no-such-operation')
  await expect(page.getByText('검색 결과가 없습니다')).toBeVisible()
  await page.getByRole('button', { name: '필터 초기화' }).click()
  await page.getByRole('checkbox', { name: '오류만' }).check()
  await expect(page.locator('.trace-row')).toHaveCount(2)
  await expect(page.locator('.trace-row .error-tag')).toHaveCount(2)
  await page.getByRole('checkbox', { name: '오류만' }).uncheck()
  await page.getByLabel('최소 Duration (ms)').fill('1000')
  await expect(page.locator('.trace-row')).toHaveCount(2)
  await page.getByLabel('최소 Duration (ms)').fill('')
  await page.getByLabel('정렬', { exact: true }).selectOption('slowest')
  await expect(page.locator('.trace-row').first()).toContainText('/api/payments')
  await page.getByLabel('서비스 필터').selectOption('Database')
  await expect(page.locator('.trace-row')).toHaveCount(8)
})

test('OTLP import preserves nanosecond precision, attributes and duplicates', async ({ page }) => {
  const upload = {
    name: 'fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture())),
  }
  await page.getByTestId('import-file').setInputFiles(upload)
  await expect(page.getByRole('status').filter({ hasText: 'fixture.json' })).toContainText(
    '1 spans 가져옴',
  )
  await page
    .getByRole('textbox', { name: '서비스, Operation, Trace ID 검색' })
    .fill('fixture precise')
  await expect(page.locator('.trace-row')).toHaveCount(1)
  await expect(page.getByLabel('Trace 상세')).toContainText('fixture precise request')
  await expect(page.getByLabel('선택한 Span')).toContainText('test.source')
  await page.getByText('원본 시간 · 나노초 정밀도').click()
  await expect(page.getByText('1780000000000000001 ns', { exact: true })).toBeVisible()
  await expect(page.getByText('1780000000123456789 ns', { exact: true })).toBeVisible()
  await page.getByTestId('import-file').setInputFiles(upload)
  await expect(page.getByRole('status').filter({ hasText: 'fixture.json' })).toContainText(
    '중복 1개',
  )
})

test('JSONL atomic errors, malformed JSON and empty file feedback', async ({ page }) => {
  await page.getByTestId('import-file').setInputFiles({
    name: 'bad.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(JSON.stringify(fixture()) + '\n{bad'),
  })
  await expect(page.getByRole('alert')).toContainText('JSONL 2행')
  await expect(
    page.locator('.metric-card').filter({ hasText: 'TOTAL TRACES' }).locator('.metric-value'),
  ).toHaveText('12')
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from('') })
  await expect(page.getByRole('alert')).toContainText('빈 파일')
  await page.getByTestId('import-file').setInputFiles({
    name: 'unsupported.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"spans":[]}'),
  })
  await expect(page.getByRole('alert')).toContainText('resourceSpans')
  await page.getByTestId('import-file').setInputFiles({
    name: 'valid.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(JSON.stringify(fixture(9001)) + '\n' + JSON.stringify(fixture(9002))),
  })
  await expect(page.getByRole('status').filter({ hasText: 'valid.jsonl' })).toContainText(
    '2 spans 가져옴',
  )
})

test('Pin, expire, actual GC, unpin and free-slot reuse', async ({ page }) => {
  await page.getByRole('button', { name: 'Trace Pin', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Trace Unpin', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: /Handle 추적/ }).click()
  await expect(page.getByText('VALID HANDLE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '엔진 시간 +5분' }).click()
  await page.getByRole('button', { name: '만료만 적용' }).click()
  await expect(page.locator('.trace-row')).toHaveCount(1)
  const metric = (name: string) =>
    page
      .locator('.inspector-metrics > div')
      .filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
      .locator('strong')
  await expect(metric('Active Spans')).toHaveText('120')
  await page.getByRole('button', { name: 'GC 실행', exact: true }).click()
  await expect(metric('Active Spans')).toHaveText('10')
  await expect(metric('Free Slots')).toHaveText('110')
  await expect(page.getByText('VALID HANDLE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trace Unpin', exact: true }).click()
  await page.getByRole('button', { name: 'GC 실행', exact: true }).click()
  await expect(metric('Active Spans')).toHaveText('0')
  await expect(metric('Free Slots')).toHaveText('120')
  await expect(page.getByText('STALE / EMPTY', { exact: true })).toBeVisible()
  await page.getByLabel('샘플 Span 수').selectOption('100')
  await page.getByRole('button', { name: '샘플 실행', exact: true }).click()
  await expect(metric('Reused Slots')).toHaveText('100')
  await expect(metric('Active Spans')).toHaveText('100')
  await expect(metric('Free Slots')).toHaveText('20')
  await expect(page.getByText('STALE / EMPTY', { exact: true })).toBeVisible()
})

test('10,000 span traffic batches and reload reset', async ({ page }) => {
  await page.getByLabel('샘플 Span 수').selectOption('10000')
  await page.getByRole('button', { name: '샘플 실행', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '합성 샘플 10,000' })).toBeVisible()
  await expect(
    page.locator('.metric-card').filter({ hasText: 'TOTAL SPANS' }).locator('.metric-value'),
  ).toHaveText('10,120')
  await page.reload()
  await expect(
    page.locator('.metric-card').filter({ hasText: 'TOTAL SPANS' }).locator('.metric-value'),
  ).toHaveText('120')
})

test('detail pages reach later spans and retain whole-trace error summaries', async ({ page }) => {
  const data = fixture(9200, 'fixture-many-spans')
  const root = data.resourceSpans[0].scopeSpans[0].spans[0]
  root.status.code = 1
  const spans = Array.from({ length: 55 }, (_, index) => ({
    ...root,
    spanId: (index + 1).toString(16).padStart(16, '0'),
    parentSpanId: index ? root.spanId : '',
    name: index ? `child-${index}` : root.name,
    status: { code: index === 54 ? 2 : 1 },
  }))
  data.resourceSpans[0].scopeSpans[0].spans = spans
  await page.getByTestId('import-file').setInputFiles({
    name: 'many.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  })
  await page
    .getByRole('textbox', { name: '서비스, Operation, Trace ID 검색' })
    .fill('fixture-many-spans')
  await expect(page.locator('.waterfall-row')).toHaveCount(24)
  await expect(page.locator('.detail-meta')).toContainText('오류 1개')
  await page.getByRole('button', { name: '다음 Span 페이지' }).click()
  await expect(page.locator('.waterfall-row')).toHaveCount(24)
  await page.getByRole('button', { name: '다음 Span 페이지' }).click()
  await expect(page.locator('.waterfall-row')).toHaveCount(7)
  await expect(page.getByRole('button', { name: 'Span child-54', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Span child-54', exact: true }).click()
  await expect(page.getByLabel('선택한 Span')).toContainText('error')
})

test('mobile layout contains page overflow and keeps controls usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'OTLP 가져오기' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Handle 추적/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.getByRole('button', { name: /Handle 추적/ }).click()
  await expect(page.getByText('VALID HANDLE', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

test('local inputs never produce outbound network requests', async ({ page }) => {
  const unexpected: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(new URL(page.url()).origin)) unexpected.push(request.url())
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByTestId('import-file').setInputFiles({
    name: 'private-local.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture())),
  })
  await expect(page.getByRole('status').filter({ hasText: 'private-local.json' })).toBeVisible()
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('WASM download failure offers a visible retry', async ({ page }) => {
  await page.route('**/*.wasm', (route) => route.abort())
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('WASM 엔진을 시작하지 못했습니다')
  await expect(page.getByRole('button', { name: '다시 불러오기' })).toBeVisible()
})

test('capture real product and GC lifecycle states', async ({ page }) => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, 'Optional screenshot evidence capture')
  await page.getByLabel('샘플 Span 수').selectOption('1000')
  await page.getByRole('button', { name: '샘플 실행', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '합성 샘플 1,000' })).toBeVisible()
  await page.getByRole('button', { name: '알림 닫기' }).click()
  await page.getByLabel('정렬', { exact: true }).selectOption('slowest')
  await page.locator('.trace-row').first().click()
  await expect(page.getByLabel('Trace 상세')).toContainText('/api/payments')
  await page.screenshot({ path: 'docs/screenshots/overview.png', fullPage: true })
  await page.getByLabel('Trace 상세').screenshot({ path: 'docs/screenshots/detail.png' })
  await page.getByRole('button', { name: 'Trace Pin', exact: true }).click()
  await page.getByRole('button', { name: /Handle 추적/ }).click()
  await expect(page.getByText('VALID HANDLE', { exact: true })).toBeVisible()
  await page
    .getByLabel('Memory Inspector', { exact: true })
    .screenshot({ path: 'docs/screenshots/inspector.png' })
  await page.getByRole('button', { name: '엔진 시간 +5분' }).click()
  await page.getByRole('button', { name: '만료만 적용' }).click()
  await expect(page.locator('.trace-row')).toHaveCount(1)
  await page
    .getByLabel('Memory Inspector', { exact: true })
    .screenshot({ path: 'docs/screenshots/gc-before.png' })
  await page.getByRole('button', { name: 'GC 실행', exact: true }).click()
  await expect(page.locator('.gc-result')).toContainText('1,110')
  await page
    .getByLabel('Memory Inspector', { exact: true })
    .screenshot({ path: 'docs/screenshots/gc-after.png' })
})
