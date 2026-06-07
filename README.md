# agent-eval

A lightweight TypeScript framework for testing and evaluating AI agent outputs.

Think: **Jest/Vitest but for agent outputs** instead of functions.

## Features

- 🧪 **Eval specs** — define what "good" looks like for agent outputs
- 🔗 **Chain testing** — multi-step agent interactions with assertions at each step
- 🔍 **Hallucination detection** — flag fabricated facts, broken links, invented references
- 📐 **Drift monitoring** — catch when an agent sidetracks from its assigned task
- ✅ **Clear pass/fail** — results with evidence for what went wrong

## Philosophy

agent-eval is built on an **independence-first** hierarchy. The axis isn't cheap→expensive — it's **independent→corruptible**.

| Tier | Name | Why it works |
|------|------|-------------|
| 1 | **Externally Observable** | Agent cannot forge the result. A JSON parse failure is a JSON parse failure. The evidence lives outside the agent's control surface. |
| 2 | **Statistically Observable** | Agent didn't produce the baseline being compared against. Embeddings, length distributions, repetition patterns. |
| 3 | **Shared-Substrate Judgment** | Model-as-judge. Least independent, most forgeable from inside. Use only when Tier 1+2 can't answer the question. |

**The stop-rule for Tier 3:** Model-as-judge is acceptable *only* when the behavior it judges is visible in some artifact the judged agent didn't get to write. If the auditor and the audited can touch the same evidence, you don't have an internal affairs department — you have an employee writing their own performance review.

Most agent failures (stale runs, crashes, format violations, hallucinated paths, incomplete output) are catchable with Tier 1+2 alone. Model-as-judge handles the remaining 20% — genuine subjective quality calls.

## Install

```bash
npm install agent-eval
```

## Quick Start

```typescript
import { defineEval, toContain, toMatch, LocalProvider, runSuite, TerminalReporter } from 'agent-eval';

const provider = new LocalProvider({
  outputs: {
    'Write a function that reverses a string': `
      function reverseString(input: string): string {
        return input.split('').reverse().join('');
      }
    `,
  },
});

const suite = defineEval({
  name: 'Code generation quality',
  provider,
  specs: [
    {
      name: 'generates valid TypeScript',
      prompt: 'Write a function that reverses a string',
      assertions: [
        toContain('function'),
        toMatch(/:\s*string/),
        toContain('reverse'),
      ],
    },
  ],
});

const reporter = new TerminalReporter({ verbose: true });
const result = await runSuite(suite, { reporters: [reporter] });
console.log(reporter.format([result]));
```

## Assertions

Built-in assertions for common checks:

| Assertion | Description |
|-----------|-------------|
| `toContain(str)` | Output contains substring |
| `toMatch(regex)` | Output matches pattern |
| `toEqual(str)` | Output equals exact string |
| `notToContain(str)` | Output does NOT contain substring |
| `notToMatch(regex)` | Output does NOT match pattern |
| `toHaveMinLength(n)` | Output has minimum length |
| `toHaveMaxLength(n)` | Output has maximum length |
| `toBeValidJson()` | Output is valid JSON |
| `toStartWith(str)` | Output starts with prefix |
| `toEndWith(str)` | Output ends with suffix |
| `custom(name, fn)` | Custom assertion function |

## Providers

### LocalProvider

Test against saved outputs without API calls:

```typescript
import { LocalProvider } from 'agent-eval';

const provider = new LocalProvider({
  outputs: {
    'prompt A': 'saved output for A',
    'prompt B': 'saved output for B',
  },
  defaultOutput: 'fallback response',
  substringMatch: true, // match partial prompts
});
```

## CLI

```bash
npx agent-eval run ./specs/
npx agent-eval --version
npx agent-eval --help
```

## License

MIT
