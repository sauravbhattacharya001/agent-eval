# agent-eval

A lightweight TypeScript framework for testing and evaluating AI agent outputs.

Think: **Jest/Vitest but for agent outputs** instead of functions.

## Features

- 🧪 **Eval specs** — define what "good" looks like for agent outputs
- 🔗 **Chain testing** — multi-step agent interactions with assertions at each step
- 🔍 **Hallucination detection** — flag fabricated facts, broken links, invented references
- 📐 **Drift monitoring** — catch when an agent sidetracks from its assigned task
- ✅ **Clear pass/fail** — results with evidence for what went wrong

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
