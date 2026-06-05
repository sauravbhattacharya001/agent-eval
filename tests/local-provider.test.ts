import { describe, it, expect } from 'vitest';
import { LocalProvider } from '../src/providers/local.js';

describe('LocalProvider', () => {
  it('returns exact match output', async () => {
    const provider = new LocalProvider({
      outputs: { 'hello': 'world' },
    });
    const result = await provider.generate('hello');
    expect(result).toBe('world');
  });

  it('returns default output when no match', async () => {
    const provider = new LocalProvider({
      outputs: { 'hello': 'world' },
      defaultOutput: 'default response',
    });
    const result = await provider.generate('unknown prompt');
    expect(result).toBe('default response');
  });

  it('throws when no match and no default', async () => {
    const provider = new LocalProvider({
      outputs: { 'hello': 'world' },
    });
    await expect(provider.generate('unknown')).rejects.toThrow('no output defined');
  });

  it('supports Map-based outputs', async () => {
    const outputs = new Map([['prompt1', 'output1']]);
    const provider = new LocalProvider({ outputs });
    const result = await provider.generate('prompt1');
    expect(result).toBe('output1');
  });

  it('supports substring matching', async () => {
    const provider = new LocalProvider({
      outputs: { 'reverse a string': 'function reverse(){}' },
      substringMatch: true,
    });
    const result = await provider.generate('Write a function to reverse a string in TypeScript');
    expect(result).toBe('function reverse(){}');
  });

  it('has name "local"', () => {
    const provider = new LocalProvider({ outputs: {} });
    expect(provider.name).toBe('local');
  });
});
