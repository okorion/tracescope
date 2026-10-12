/** Synthetic traffic. Every generated span goes through the public OTLP ingest path. */
type Attribute = {
  key: string
  value: { stringValue: string } | { intValue: string } | { boolValue: boolean }
}
type SampleSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  kind: number
  status: { code: number; message?: string }
  attributes: Attribute[]
}

let sequence = 1
const sessionId = BigInt(Date.now())
const attr = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } })
const serviceNames = [
  'API Gateway',
  'Auth Service',
  'Product Service',
  'Database',
  'Order Service',
  'Payment Service',
]

export function generateSample(spanCount: number): string {
  const byService = new Map<string, SampleSpan[]>(serviceNames.map((name) => [name, []]))
  const now = BigInt(Date.now()) * 1_000_000n
  let remaining = Math.max(1, Math.floor(spanCount))
  while (remaining > 0) {
    const number = sequence++
    const scenario = number % 6
    const traceId = ((sessionId << 64n) + BigInt(number)).toString(16).padStart(32, '0')
    const spanId = (index: number) =>
      (BigInt(number) * 16n + BigInt(index + 1)).toString(16).padStart(16, '0')
    const duration = [46, 174, 642, 1280, 386, 213][scenario] + (number % 31)
    const start = now - BigInt(number % 300) * 310_000_000n - BigInt(duration) * 1_000_000n
    const operations = [
      '/api/products',
      '/api/checkout',
      '/api/products/search',
      '/api/payments',
      '/api/orders',
      '/api/cart',
    ]
    const paymentStart = duration * 0.38
    const definitions: [string, string, number, number, number | null][] = [
      ['API Gateway', `POST ${operations[scenario]}`, 0, duration, null],
      ['Auth Service', 'validate session', 1, Math.min(17, duration * 0.15), 0],
      [
        'Product Service',
        'get products',
        duration * 0.1,
        duration * (scenario === 2 ? 0.76 : 0.26),
        0,
      ],
      [
        'Database',
        'SELECT products',
        duration * 0.12,
        duration * (scenario === 2 ? 0.69 : 0.17),
        2,
      ],
      ['Product Service', 'hydrate catalog', duration * 0.15, duration * 0.08, 2],
      ['Order Service', 'create order', duration * 0.36, duration * 0.59, 0],
      ['Order Service', 'reserve inventory', duration * 0.37, duration * 0.06, 5],
      [
        'Payment Service',
        'authorize payment',
        paymentStart,
        duration * (scenario === 3 ? 0.52 : 0.34),
        5,
      ],
      ['Database', 'INSERT orders', duration * 0.78, duration * 0.09, 5],
      ['Order Service', 'publish order.created', duration * 0.9, duration * 0.03, 5],
    ]
    const count = Math.min(remaining, definitions.length)
    for (let i = 0; i < count; i++) {
      const [service, name, offset, spanDuration, parent] = definitions[i]
      const error = scenario === 4 && (i === 0 || i === 7)
      const attributes: Attribute[] = [
        { key: 'tracescope.sample', value: { boolValue: true } },
        attr(
          'sample.scenario',
          [
            'short-request',
            'distributed-request',
            'database-bottleneck',
            'slow-payment',
            'service-error',
            'missing-parent',
          ][scenario],
        ),
      ]
      if (i === 0)
        attributes.push(
          attr('http.request.method', 'POST'),
          attr('url.path', operations[scenario]),
          { key: 'http.response.status_code', value: { intValue: error ? '503' : '200' } },
        )
      if (service === 'Database')
        attributes.push(
          attr('db.system.name', 'postgresql'),
          attr('db.namespace', 'store'),
          attr('db.operation.name', i === 3 ? 'SELECT' : 'INSERT'),
        )
      if (i === 7)
        attributes.push(
          attr('payment.provider', 'sample-provider'),
          attr('error.type', error ? 'UpstreamTimeout' : 'none'),
        )
      byService.get(service)!.push({
        traceId,
        spanId: spanId(i),
        ...(parent === null
          ? {}
          : { parentSpanId: scenario === 5 && i === 3 ? 'fffffffffffffffe' : spanId(parent) }),
        name,
        kind: service === 'Database' ? 3 : 2,
        startTimeUnixNano: (start + BigInt(Math.round(offset * 1_000_000))).toString(),
        endTimeUnixNano: (
          start + BigInt(Math.round((offset + spanDuration) * 1_000_000))
        ).toString(),
        status: {
          code: error ? 2 : 1,
          ...(error ? { message: 'Synthetic payment provider timeout' } : {}),
        },
        attributes,
      })
    }
    remaining -= count
  }
  return JSON.stringify({
    resourceSpans: [...byService]
      .filter(([, spans]) => spans.length)
      .map(([service, spans]) => ({
        resource: {
          attributes: [
            attr('service.name', service),
            attr('deployment.environment.name', 'synthetic'),
            { key: 'tracescope.sample', value: { boolValue: true } },
          ],
        },
        scopeSpans: [{ scope: { name: 'tracescope.synthetic', version: '1.0.0' }, spans }],
      })),
  })
}
