# tokometer

A token speedometer for Claude Code. It shows a dial ○◔◑◕● in the prompt footer, with the live tok/s beside it. The color tells you how the current speed compares to your own usual speeds: green below your median, amber up to your 80th percentile, Claude orange up to your 95th, and red and bold above that. The dial fills to the same percentile.

- **Learning:** each moment of streaming is logged into a histogram on a log scale, shared by all your sessions. Older samples gradually count for less, so the bands follow your habits as they change. Until 30 s of streaming has been logged, the dial uses starter bands.
- **What it counts:** every model request: the main thread, subagents, compaction, and other plugins' completions. Output (text, thinking, tool-call arguments) is counted live as it streams; the API's billed figures for each response calibrate the next estimate. Input (uncached, cache writes, cache reads) is spread over each request's duration so it doesn't show up as a spike.
- **Across sessions:** every local Claude Code session with tokometer installed adds its rate into the same total.
- **Calm and light:** the rate is averaged over about 2.5 s and updates once a second while tokens are flowing. It redraws only when the number moves by 5% or the color changes, drops to 0 the moment streaming stops, and checks once every 2 s when idle.

## Commands

| Command | What it does |
| --- | --- |
| `/tokometer` | Shows what is counted and your current band edges in tok/s |
| `/tokometer everything` | Counts every billed token: input, cache writes and reads, and output |
| `/tokometer generated` | Counts output only: text, thinking and tool calls |
| `/tokometer reset` | Forgets your usual speeds and starts learning again |

Each mode learns its own bands.

## What it writes

tokometer writes only to its own plugin store, the JSON file Claude Code keeps for each plugin under `~/.claude/plugins/store/`. It holds:

- `histograms`: your learned speed history, one histogram per mode (seconds of streaming per rate bin)
- `mode`: whether it counts everything or only generated tokens
- `schema`: the store layout version
- `live:<session id>`: each running session's current input and output rates, refreshed about once a second while that session streams. A session removes its own key when it ends, and keys untouched for an hour are removed by any other session.

It writes no other file. It does not edit build, start-up, settings or instructions files, and it makes no network requests. It reads token counts and the length of streamed text, never what the text says.

## What its hooks do

| Hook | What it does |
| --- | --- |
| `session.start` | Registers `/tokometer`, loads the learned history and the mode, and starts the once-a-second ticker |
| `session.end` | Saves the history and removes this session's live key |
| `turn.step` | Watches each model response stream past (main thread and subagents) to count output tokens as they arrive; passes every chunk on unchanged |
| `session.compact`, `model.complete`, `model.fork` | Read the usage of requests made outside a turn (compaction, other plugins' completions) after they finish; change nothing |
| `command.run` (`tokometer`) | Answers `/tokometer` |
| `ui.render` (`SessionMode`) | Draws the dial and the rate at the right of the prompt footer, after any mode labels already there |

## Install

From a shell:

```bash
claude plugin marketplace add CharlesMod/tokometer
claude plugin install tokometer@tokometer
```

Or from inside a Claude Code session: `/plugin install tokometer --marketplace CharlesMod/tokometer`, answer `y`, then choose the user scope.

## License

MIT
