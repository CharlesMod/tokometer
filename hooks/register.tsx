import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { TokometerGauge, TokometerMode } from '../types'

// A token speedometer. Every model request this session makes (main thread
// and subagents) streams through `turn.step`: output (text, thinking, tool
// call arguments) is counted as it arrives and squared with the API's own
// usage figures when the response ends; input (uncached, cache writes, cache
// reads) is spread over the request's life instead of landing as one spike.
// Each session shares its live rate through a small file, so the gauge adds
// up every local session. The ticker runs at 4 Hz only while something is
// moving and drops to one look every 2 s when all is quiet.

const GAUGE = { plugin: 'tokometer', key: 'gauge' } as const

const TICK_MS = 250
const IDLE_MS = 2000
const SHARE_MS = 500
const FRESH_MS = 2500
const TAU_MS = 500
// Characters per token before the first response calibrates it.
const CHARS_PER_TOKEN = 3.6

// What "typical" means is learned: every tick that tokens flow adds its
// share of streaming time to a histogram of rates, a quarter octave per
// bin from 1 tok/s up. Older time fades with a half-life of six hours of
// streaming, so the bands follow the person's habits as they change. All
// sessions fold their samples into one histogram in the store.
const BINS_PER_OCTAVE = 4
const BIN_COUNT = 96
const HALF_LIFE_S = 6 * 3600
const LEARNED_S = 30
const SAVE_MS = 30_000
// Band edges (p50, p80, p95) used until 30 s of streaming has been seen.
const STARTER: Record<TokometerMode, readonly [number, number, number]> = {
  everything: [3000, 12000, 30000],
  generated: [60, 150, 300],
}
const BAND_EDGES = [0.5, 0.8, 0.95] as const

type Kind = 'in' | 'out'
type Flow = { kind: Kind; left: number; perMs: number }
type Shared = { t: number; out: number; in: number }
type Histograms = Record<TokometerMode, number[]>

const MODES: readonly TokometerMode[] = ['everything', 'generated']

const acc: Record<Kind, number> = { in: 0, out: 0 }
const rate: Record<Kind, number> = { in: 0, out: 0 }
const flows = new Set<Flow>()
const lastInput = new Map<string, number>()
const durations = new Map<string, number>()
let stored: Histograms = emptyHistograms()
let pending: Histograms = emptyHistograms()
let calibration = 1
let inFlight = 0
let mode: TokometerMode = 'everything'
let remote = { out: 0, in: 0, count: 0 }
let lastTick = 0
let lastShare = 0
let lastRemote = 0
let lastSave = 0
let isZeroShared = true
let isTicking = false
// A one-off request outside a turn's steps keeps the needle up this long.
let holdUntil = 0
let written = { rate: -1, band: -1, rank: -1 }
let liveDir = ''
let ownFile = ''
let timer: { cancel: () => void } | undefined
let timerMs = 0

function emptyHistograms(): Histograms {
  return { everything: new Array(BIN_COUNT).fill(0), generated: new Array(BIN_COUNT).fill(0) }
}

function position(r: number): number {
  return Math.min(Math.max(Math.log2(Math.max(r, 1)) * BINS_PER_OCTAVE, 0), BIN_COUNT - 1e-9)
}

function view(m: TokometerMode): number[] {
  return stored[m].map((v, i) => v + (pending[m][i] ?? 0))
}

function mass(hist: readonly number[]): number {
  return hist.reduce((a, b) => a + b, 0)
}

// Where `r` falls among the rates seen: 0 below them all, 1 above.
function rankOf(m: TokometerMode, r: number): number {
  const hist = view(m)
  const total = mass(hist)
  if (total < LEARNED_S) {
    const [p50, p80, p95] = STARTER[m]
    const knots: [number, number][] = [[1, 0], [p50, 0.5], [p80, 0.8], [p95, 0.95], [p95 * 4, 1]]
    for (let i = 1; i < knots.length; i++) {
      const [x0, y0] = knots[i - 1]!
      const [x1, y1] = knots[i]!
      if (r <= x1) {
        const t = (Math.log(Math.max(r, x0)) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))
        return y0 + (y1 - y0) * t
      }
    }
    return 1
  }
  const at = position(r)
  const bin = Math.floor(at)
  let below = 0
  for (let i = 0; i < bin; i++) below += hist[i] ?? 0
  below += (hist[bin] ?? 0) * (at - bin)

  return below / total
}

// The rate at quantile `q` of what has been seen (the starter edges before).
function quantile(m: TokometerMode, q: number): number {
  const hist = view(m)
  const total = mass(hist)
  if (total < LEARNED_S) {
    const [p50, p80, p95] = STARTER[m]
    return q <= 0.5 ? p50 : q <= 0.8 ? p80 : p95
  }
  let run = 0
  for (let i = 0; i < BIN_COUNT; i++) {
    const v = hist[i] ?? 0
    if (run + v >= q * total && v > 0) {
      return 2 ** ((i + (q * total - run) / v) / BINS_PER_OCTAVE)
    }
    run += v
  }

  return 2 ** (BIN_COUNT / BINS_PER_OCTAVE)
}

function record(m: TokometerMode, r: number, seconds: number) {
  if (r < 1 || seconds <= 0) return
  const bin = Math.floor(position(r))
  pending[m][bin] = (pending[m][bin] ?? 0) + seconds
}

// Folds this session's new samples into the shared histogram, fading what
// was there by the streaming time they add, and picks up other sessions'.
async function save($: EngineInterface) {
  const shelf = ((await $.store.get('histograms')) ?? {}) as Partial<Histograms>
  const next = emptyHistograms()
  for (const m of MODES) {
    const fade = 0.5 ** (mass(pending[m]) / HALF_LIFE_S)
    const before = shelf[m] ?? []
    for (let i = 0; i < BIN_COUNT; i++) next[m][i] = (before[i] ?? 0) * fade + (pending[m][i] ?? 0)
  }
  pending = emptyHistograms()
  stored = next
  await $.store.set('histograms', next)
}

function flow(kind: Kind, tokens: number, ms: number) {
  if (tokens === 0) return
  const f: Flow = { kind, left: tokens, perMs: tokens / Math.max(ms, 1) }
  flows.add(f)
  return f
}

function schedule($: EngineInterface, ms: number) {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => void tick($))
}

async function readRemote($: EngineInterface, now: number) {
  const sum = { out: 0, in: 0, count: 0 }
  const entries = await $.fs.list(liveDir).catch(() => [])
  for (const entry of entries) {
    const path = `${liveDir}/${entry.name}`
    if (path === ownFile || !entry.name.endsWith('.json')) continue
    if (now - entry.mtimeMs > FRESH_MS) continue
    const shared = await $.fs
      .read(path)
      .then(text => JSON.parse(text) as Shared)
      .catch(() => undefined)
    if (!shared || now - shared.t > FRESH_MS) continue
    sum.out += shared.out
    sum.in += shared.in
    if (shared.out + shared.in > 0.5) sum.count += 1
  }
  remote = sum
}

async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const dt = lastTick === 0 ? TICK_MS : Math.min(Math.max(now - lastTick, 1), 4000)
    lastTick = now

    for (const f of flows) {
      const step = Math.min(Math.abs(f.left), Math.abs(f.perMs) * dt) * Math.sign(f.left)
      acc[f.kind] += step
      f.left -= step
      if (Math.abs(f.left) < 0.01) flows.delete(f)
    }
    // Nothing streaming: the needle drops straight to zero rather than
    // easing down, since smoothing is only there to steady a live stream.
    const isStreaming = inFlight > 0 || now < holdUntil
    const alpha = 1 - Math.exp(-dt / TAU_MS)
    for (const k of ['in', 'out'] as const) {
      const instant = Math.max(0, (acc[k] / dt) * 1000)
      acc[k] = 0
      rate[k] = isStreaming ? rate[k] + (instant - rate[k]) * alpha : 0
    }
    if (!isStreaming) flows.clear()
    const own = rate.out + rate.in

    if (now - lastShare >= SHARE_MS && ownFile !== '' && (own > 0.5 || !isZeroShared)) {
      lastShare = now
      isZeroShared = own <= 0.5
      const shared: Shared = { t: now, out: rate.out, in: rate.in }
      void $.fs.write(ownFile, JSON.stringify(shared)).catch(() => undefined)
    }
    if (now - lastRemote >= SHARE_MS && liveDir !== '') {
      lastRemote = now
      await readRemote($, now)
    }

    const totals: Record<TokometerMode, number> = {
      everything: own + remote.out + remote.in,
      generated: rate.out + remote.out,
    }
    const mine: Record<TokometerMode, number> = { everything: own, generated: rate.out }
    // Each session records the total in proportion to its own share of it,
    // so several sessions streaming together count that time once.
    for (const m of MODES) {
      if (mine[m] > 0.5) record(m, totals[m], (dt / 1000) * (mine[m] / totals[m]))
    }
    if (now - lastSave >= SAVE_MS) {
      lastSave = now
      await save($)
    }

    const total = totals[mode]
    const rank = total > 0.5 ? rankOf(mode, total) : 0
    const band = total > 0.5 ? bandOf(rank) : -1
    const isWorthDrawing =
      Math.abs(total - written.rate) >= Math.max(1, total * 0.02) ||
      band !== written.band ||
      Math.abs(rank - written.rank) >= 0.05 ||
      (total === 0 && written.rate !== 0)
    if (isWorthDrawing) {
      const gauge: TokometerGauge = {
        rate: total,
        own: mine[mode],
        others: remote.count,
        rank,
        band,
        isLearning: mass(view(mode)) < LEARNED_S,
        mode,
      }
      written = { rate: total, band, rank }
      await $.state.set(GAUGE, gauge)
    }

    const isBusy = inFlight > 0 || flows.size > 0 || total > 0.5 || remote.count > 0
    schedule($, isBusy ? TICK_MS : IDLE_MS)
  } finally {
    isTicking = false
  }
}

// Requests outside a turn's steps that are still billed: compaction,
// and other plugins' one-off completions and forks.
function spend($: EngineInterface, usage: ModelUsage | undefined) {
  if (!usage) return
  const input =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  flow('in', input, 1000)
  flow('out', usage.output_tokens, 1000)
  holdUntil = lastTick + 1000
  schedule($, TICK_MS)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    if (home !== '') {
      liveDir = `${home}/.claude/tokometer/live`
      ownFile = `${liveDir}/${await $.session.id()}.json`
    }
    // 0.1 and 0.2 kept a single peak; 0.3 learns a histogram instead.
    if ((await $.store.get('schema')) !== 3) {
      await $.store.delete('peaks')
      await $.store.set('schema', 3)
    }
    lastSave = await $.clock.now()
    await save($)
    const stored = (await $.store.get('mode')) as TokometerMode | undefined
    if (stored && MODES.includes(stored)) mode = stored
    await $.command.register({
      name: 'tokometer',
      description: 'Token speedometer: your typical speeds, switch what it counts, or relearn',
      argumentHint: '[everything | generated | reset]',
    })
    schedule($, IDLE_MS)
    void tick($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    await save($).catch(() => undefined)
    if (ownFile !== '') {
      const shared: Shared = { t: 0, out: 0, in: 0 }
      await $.fs.write(ownFile, JSON.stringify(shared)).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'tokometer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'reset') {
      stored = emptyHistograms()
      pending = emptyHistograms()
      await $.store.set('histograms', stored)
      written.rate = -1

      return { text: 'Tokometer forgot your typical speeds and is learning them again.' }
    }
    if (MODES.includes(arg as TokometerMode)) {
      mode = arg as TokometerMode
      written.rate = -1
      await $.store.set('mode', mode)
      void tick($)
    }
    const what =
      mode === 'everything'
        ? 'every billed token: input, cache writes and reads, and output (text, thinking, tool calls)'
        : 'generated tokens only: text, thinking and tool calls'
    const learned = mass(view(mode))
    const bands =
      learned < LEARNED_S
        ? `Still learning (${Math.round(learned)} of ${LEARNED_S} s streamed); starter bands`
        : `Learned from ${formatDuration(learned)} of streaming`
    const [p50, p80, p95] = BAND_EDGES.map(q => format(quantile(mode, q)))

    return {
      text:
        `Tokometer counts ${what}.\n` +
        `${bands}: green below ${p50}, amber to ${p80}, orange to ${p95}, red and bold above ${p95} tok/s.\n` +
        `/tokometer everything | generated switches what it counts; /tokometer reset relearns.`,
    }
  })

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? 'main'
    inFlight += 1
    schedule($, TICK_MS)
    const startedAt = await $.clock.now()
    let predicted = lastInput.get(loop)
    if (predicted === undefined && loop === 'main') {
      predicted = (await $.session.usage()).context.tokens ?? 0
    }
    const inFlow = flow('in', predicted ?? 0, durations.get(loop) ?? 8000)
    let estimated = 0
    let usage: ModelUsage | null = null
    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          const tokens = (chunk.text.length / CHARS_PER_TOKEN) * calibration
          estimated += tokens
          acc.out += tokens
        } else if (chunk.kind === 'input') {
          const tokens = (chunk.json.length / CHARS_PER_TOKEN) * calibration
          estimated += tokens
          acc.out += tokens
        } else if (chunk.kind === 'stop') {
          usage = chunk.usage
        }
        yield chunk
      }
    } finally {
      inFlight -= 1
      const endedAt = await $.clock.now()
      const took = Math.max(endedAt - startedAt, 1)
      durations.set(loop, (durations.get(loop) ?? took) * 0.5 + took * 0.5)
      if (inFlow) flows.delete(inFlow)
      if (usage) {
        const input =
          usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
        lastInput.set(loop, input + usage.output_tokens)
        // The billed figures only sharpen the next estimate: settling the
        // difference after the fact would show as a burst no request made.
        if (estimated > 20 && usage.output_tokens > 0) {
          const ratio = Math.min(Math.max(usage.output_tokens / (estimated / calibration), 0.3), 4)
          calibration = calibration * 0.7 + ratio * 0.3
        }
      }
      if (inFlight === 0) lastShare = 0
      void tick($)
    }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    spend($, result.skip === undefined ? result.usage : undefined)

    return result
  }).catch(($, e, next) => next(e))
  on('model.complete', async ($, e, next) => {
    const result = await next(e)
    spend($, 'usage' in result ? (result.usage as ModelUsage) : undefined)

    return result
  }).catch(($, e, next) => next(e))
  on('model.fork', async ($, e, next) => {
    const result = await next(e)
    spend($, 'usage' in result ? (result.usage as ModelUsage) : undefined)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const gauge = (await $.state.get(GAUGE)).value
    if (!gauge) return next(e)
    const modes = e.props.modes.join(' & ')
    const isMoving = gauge.band >= 0
    const color = isMoving ? COLORS[gauge.band] : undefined
    const isBold = gauge.band === COLORS.length - 1
    const { Box, Text } = $.ui.resolve(e)
    // The footer draws text only, so the dial is a circle that fills
    // clockwise with where this rate sits among the person's usual ones.
    const dial = (
      <Text color={color} dimColor={!isMoving} bold={isBold}>
        {isMoving ? dialGlyph(gauge.rank) : DIAL[0]}
      </Text>
    )
    const number = (
      <Text color={color} dimColor={!isMoving} bold={isBold}>
        {format(gauge.rate)} tok/s
      </Text>
    )
    const lead = modes !== '' ? [<Text dimColor>{modes} · </Text>] : []

    // The circle sits in a box of its own, centered on the row and a full
    // cell clear of the number.
    return (
      <Box flexDirection="row" alignItems="center">
        {[
          ...lead,
          <Box marginRight={1} alignItems="center" justifyContent="center">
            {dial}
          </Box>,
          number,
        ]}
      </Box>
    )
  })
}

// Theme colors, so the dial follows light and dark. Each is a band of the
// person's own usual speeds: green below their median, amber to the 80th
// percentile, Claude orange to the 95th, red (and bold) beyond.
const COLORS = ['success', 'warning', 'claude', 'error'] as const

function bandOf(rank: number): number {
  const i = BAND_EDGES.findIndex(edge => rank < edge)
  return i < 0 ? BAND_EDGES.length : i
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

function format(n: number): string {
  if (n < 0.5) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1e6) return `${Math.round(n / 1000)}k`

  return `${(n / 1e6).toFixed(1)}M`
}

const DIAL = ['○', '◔', '◑', '◕', '●'] as const

function dialGlyph(rank: number): string {
  return DIAL[Math.min(Math.max(Math.round(rank * 4), 1), 4)]!
}
