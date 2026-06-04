import type { UTCTimestamp } from 'lightweight-charts'

// Bar is the chart-native OHLCV unit shared by indicators, SMC and scripts.
// `time` is unix-seconds (lightweight-charts UTCTimestamp).
export interface Bar {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
  volume: number
}
