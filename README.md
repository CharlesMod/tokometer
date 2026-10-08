# tokometer

A token speedometer for Claude Code. It shows a dial ○◔◑◕● in the prompt footer, with the live tok/s beside it. The color tells you how the current speed compares to your own usual speeds: green below your median, amber up to your 80th percentile, Claude orange up to your 95th, and red and bold above that. The dial fills to the same percentile.

- **Learning:** each moment of streaming is logged into a histogram on a log scale, shared by all your sessions. Older samples gradually count for less, so the bands follow your habits as they change. Until 30 s of streaming has been logged, the dial uses starter bands. `/tokometer` shows your current band edges, and `/tokometer reset` starts the learning over.
- **What it counts:** every model request: the main thread, subagents, compaction, and other plugins' completions. Output (text, thinking, tool-call arguments) is counted live as it streams, then corrected to the API's billed figures. Input (uncached, cache writes, cache reads) is spread over each request's duration so it doesn't show up as a spike.
- **Across sessions:** each session writes its rate to `~/.claude/tokometer/live/`, and the dial adds up every local session.
- **Light on resources:** the dial updates 4×/s while tokens are moving and checks once every 2 s when idle. It only redraws when the value visibly changes, and SVG animation sweeps the needle smoothly between updates.

`/tokometer everything` counts all billed tokens and `/tokometer generated` counts output only. Each mode learns its own bands.

## Install

From a shell:

```bash
claude plugin marketplace add CharlesMod/tokometer
claude plugin install tokometer@tokometer
```

Or from inside a Claude Code session: `/plugin install tokometer --marketplace CharlesMod/tokometer`, answer `y`, then choose the user scope.

## License

MIT
