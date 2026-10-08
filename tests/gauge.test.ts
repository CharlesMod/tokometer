import { expect, mock, test } from 'claude-code/testing'

test('a streamed response moves the gauge, and it drops to zero when the stream ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'tokometer' } }))
  on('session.start', (_$, e) => ({ sessionId: 's1', cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000 }, rateLimits: [] } }) as never)

  // The model beneath: 4,000 characters of thinking and text, then usage.
  on('turn.step', async function* (_$, e) {
    yield { kind: 'thinking', index: 0, text: 'x'.repeat(2000), ref: 1 }
    yield { kind: 'text', index: 1, text: 'y'.repeat(2000), ref: 2 }
    const usage = {
      input_tokens: 500,
      output_tokens: 1200,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 1000,
      model: 'claude-opus-5-5',
    }
    yield { kind: 'stop', stopReason: 'end_turn', usage, ref: 3 }

    return { turnId: e.turnId, index: e.index, answer: 'y', toolUses: [], stopReason: 'end_turn', usage }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const label = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ plugin: 'tokometer', surface, component: 'SessionMode', props: { modes: [] } })
    const text = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text
    await ui.unmount()
    return text
  }

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let seen = 0
  for await (const chunk of stream) {
    await clock.advance(1000)
    if (chunk.kind === 'text') {
      for (const surface of ['desktop', 'terminal'] as const) {
        expect(await label(surface)).toMatch(/[1-9][0-9.]*k? tok\/s/)
        seen += 1
      }
    }
  }
  expect(seen).toBe(2)

  // One tick after the stream ends, the needle is at zero: no slow fade.
  await clock.advance(300)
  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await label(surface)).toMatch(/\b0 tok\/s/)
  }
})

test('a rate above the usual 95th percentile is red and bold', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // An hour of learned streaming, all of it near 100 tok/s (bin 26).
  const hours = new Array(96).fill(0)
  hours[26] = 3600
  mock.store(on, { schema: 3, histograms: { everything: hours, generated: hours } })
  on('command.register', () => ({ value: { command: 'tokometer' } }))
  on('session.start', (_$, e) => ({ sessionId: 's1', cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000 }, rateLimits: [] } }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'y'.repeat(20000), ref: 1 }
    yield { kind: 'text', index: 0, text: 'y'.repeat(20000), ref: 2 }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null, ref: 3 }

    return { turnId: e.turnId, index: e.index, answer: 'y', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  let checked = false
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    await clock.advance(1000)
    if (chunk.kind === 'text' && !checked) {
      checked = true
      for (const surface of ['desktop', 'terminal'] as const) {
        const ui = await $.ui.mount({ plugin: 'tokometer', surface, component: 'SessionMode', props: { modes: [] } })
        const number = await ui.find({ type: 'Text', text: /tok\/s/ })
        expect(number?.props).toEqual(expect.objectContaining({ color: 'error', bold: true }))
        await ui.unmount()
      }
    }
  }
  expect(checked).toBe(true)
})
