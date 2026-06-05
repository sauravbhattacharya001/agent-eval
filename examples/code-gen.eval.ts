/**
 * Example eval spec — demonstrates basic agent output testing.
 *
 * Uses the LocalProvider with pre-generated outputs to test assertions
 * without requiring any API keys.
 *
 * Run with:
 *   npx tsx examples/code-gen.eval.ts  (as module)
 *   agent-eval run examples/           (via CLI)
 */

import { defineEval, LocalProvider, toContain, toMatch, toHaveMinLength, notToContain, toBeValidJson, custom } from '../src/index.js';

/**
 * Simulated agent outputs for testing.
 * In production, these would come from an LLM provider.
 */
const mockOutputs: Record<string, string> = {
  'Write a TypeScript function that reverses a string': `
Here's a TypeScript function that reverses a string:

\`\`\`typescript
function reverseString(input: string): string {
  return input.split('').reverse().join('');
}

// Example usage
console.log(reverseString("hello")); // "olleh"
console.log(reverseString("TypeScript")); // "tpircSepyT"
\`\`\`

This function works by:
1. Splitting the string into an array of characters
2. Reversing the array in place
3. Joining the characters back into a string
`,

  'Return a JSON object with fields: name, age, language': `{"name": "Alice", "age": 30, "language": "TypeScript"}`,

  'Explain how to configure ESLint for TypeScript': `
## Setting Up ESLint for TypeScript

To configure ESLint for a TypeScript project, follow these steps:

### 1. Install Dependencies

\`\`\`bash
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
\`\`\`

### 2. Create Configuration

Create an \`.eslintrc.json\` file in your project root:

\`\`\`json
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module",
    "project": "./tsconfig.json"
  },
  "rules": {
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/explicit-function-return-type": "warn"
  }
}
\`\`\`

### 3. Add Scripts

Add a lint script to your \`package.json\`:

\`\`\`json
{
  "scripts": {
    "lint": "eslint src/ --ext .ts",
    "lint:fix": "eslint src/ --ext .ts --fix"
  }
}
\`\`\`

### 4. Configure tsconfig.json

Make sure your \`tsconfig.json\` includes the files you want to lint:

\`\`\`json
{
  "include": ["src/**/*.ts"]
}
\`\`\`

### 5. Run ESLint

\`\`\`bash
npm run lint
\`\`\`

This will catch common TypeScript issues like unused variables, missing return types, and type errors.
`,

  'Write a haiku about programming': `Silicon thoughts flow
Through circuits of pure logic
Bugs hide in plain sight`,
};

export default defineEval({
  name: 'Code generation quality',
  provider: new LocalProvider({ outputs: mockOutputs }),

  specs: [
    {
      name: 'generates valid TypeScript with return type',
      prompt: 'Write a TypeScript function that reverses a string',
      assertions: [
        toContain('function'),
        toMatch(/:\s*string/),
        toHaveMinLength(50),
        notToContain('any'),
        toContain('reverse'),
      ],
    },
    {
      name: 'returns valid JSON with required fields',
      prompt: 'Return a JSON object with fields: name, age, language',
      assertions: [
        toBeValidJson(),
        toContain('"name"'),
        toContain('"age"'),
        toContain('"language"'),
        custom('has valid age', (output) => {
          try {
            const obj = JSON.parse(output) as { age?: unknown };
            return {
              pass: typeof obj.age === 'number' && obj.age > 0 && obj.age < 150,
              message: `Age should be a reasonable number, got: ${String(obj.age)}`,
            };
          } catch {
            return { pass: false, message: 'Could not parse JSON' };
          }
        }),
      ],
    },
    {
      name: 'ESLint guide is comprehensive and on-topic',
      prompt: 'Explain how to configure ESLint for TypeScript',
      assertions: [
        toContain('@typescript-eslint'),
        toContain('.eslintrc'),
        toContain('tsconfig'),
        toHaveMinLength(200),
        toMatch(/npm install/i),
        notToContain('TODO'),
        custom('has numbered steps', (output) => {
          const headingSteps = (output.match(/^#{1,4}\s+\d+\./gm) ?? []).length;
          const inlineSteps = headingSteps > 0 ? headingSteps : (output.match(/^\d+\./gm) ?? []).length;
          const stepCount = Math.max(headingSteps, inlineSteps);
          return {
            pass: stepCount >= 3,
            message: `Expected at least 3 numbered steps, found ${stepCount}`,
          };
        }),
      ],
    },
    {
      name: 'haiku follows format constraints',
      prompt: 'Write a haiku about programming',
      assertions: [
        toHaveMinLength(20),
        custom('has three lines', (output) => {
          const lines = output.trim().split('\n').filter((l) => l.trim().length > 0);
          return {
            pass: lines.length === 3,
            message: `Haiku should have 3 lines, got ${lines.length}`,
          };
        }),
        notToContain('```'),
      ],
    },
  ],
});
