export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms === 0) return '0 ms'
  if (ms < 1) return `${(ms * 1000).toFixed(ms < 0.01 ? 2 : 1)} μs`
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
}
export const number = (value: number) => value.toLocaleString('ko-KR')
export const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`
export function timestamp(ns: string): string {
  try {
    return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleTimeString('ko-KR', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '시간 없음'
  }
}
const colors = ['#65a8ff', '#b296ff', '#42d6b5', '#f7ba65', '#ee90bd', '#67cce6']
const known = [
  'API Gateway',
  'Auth Service',
  'Product Service',
  'Database',
  'Order Service',
  'Payment Service',
]
export function serviceColor(service: string): string {
  const index = known.indexOf(service)
  return colors[
    index >= 0
      ? index
      : [...service].reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length
  ]
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
