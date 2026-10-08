export type TokometerMode = 'everything' | 'generated'

export type TokometerGauge = {
  /** Smoothed tokens per second, all local sessions together, in the current mode. */
  rate: number
  /** This session's share of `rate` (main thread and subagents). */
  own: number
  /** How many other sessions contributed. */
  others: number
  /** Where `rate` sits among the person's usual rates: 0 below all, 1 above all. */
  rank: number
  /** 0 green, 1 amber, 2 orange, 3 red; -1 while nothing streams. */
  band: number
  /** True until 30 s of streaming has been seen and the starter bands apply. */
  isLearning: boolean
  mode: TokometerMode
}
