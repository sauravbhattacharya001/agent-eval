/**
 * Format Validator — Markdown Structure Engine
 *
 * Pure parse-based markdown structure extraction and validation with zero AI,
 * filesystem, or network dependencies: string in, structure/result out. Parses
 * ATX headings and fenced code blocks, then validates against line/heading/
 * section/hierarchy/code-block requirements.
 *
 * Split out of `./format-analysis.js` (which now re-exports it) so the JSON and
 * markdown engines live in separate, individually-testable files. The type
 * vocabulary lives in `./format-types.js`.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
} from './format-types.js';

/**
 * Parse markdown content and extract structure (headings, code blocks).
 */
export function parseMarkdownStructure(content: string): { headings: MarkdownHeading[]; codeBlocks: ParsedCodeBlock[]; lineCount: number } {
  const lines = content.split('\n');
  const headings: MarkdownHeading[] = [];
  const codeBlocks: ParsedCodeBlock[] = [];

  let inCodeBlock = false;
  let currentBlockLang = '';
  let currentBlockContent: string[] = [];
  let currentBlockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNum = i + 1;

    // Code block detection (fenced)
    const fenceMatch = line.match(/^(`{3,}|~{3,})(\S*)/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        currentBlockLang = fenceMatch[2] ?? '';
        currentBlockContent = [];
        currentBlockStart = lineNum;
      } else {
        codeBlocks.push({
          language: currentBlockLang,
          content: currentBlockContent.join('\n'),
          startLine: currentBlockStart,
          endLine: lineNum,
        });
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      currentBlockContent.push(line);
      continue;
    }

    // ATX heading detection
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      const levelStr = headingMatch[1] as string;
      const textStr = headingMatch[2] as string;
      headings.push({
        level: levelStr.length,
        text: textStr.trim(),
        line: lineNum,
      });
    }
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    codeBlocks.push({
      language: currentBlockLang,
      content: currentBlockContent.join('\n'),
      startLine: currentBlockStart,
      endLine: lines.length,
    });
  }

  return { headings, codeBlocks, lineCount: lines.length };
}

/**
 * Validate markdown structure against requirements.
 */
export function validateMarkdownStructure(content: string, options: MarkdownStructureOptions = {}): MarkdownValidationResult {
  const { headings, codeBlocks, lineCount } = parseMarkdownStructure(content);
  const errors: string[] = [];

  // Line count
  if (options.minLines !== undefined && lineCount < options.minLines) {
    errors.push(`Document has ${lineCount} lines, minimum required: ${options.minLines}`);
  }
  if (options.maxLines !== undefined && lineCount > options.maxLines) {
    errors.push(`Document has ${lineCount} lines, maximum allowed: ${options.maxLines}`);
  }

  // Heading count
  if (options.minHeadings !== undefined && headings.length < options.minHeadings) {
    errors.push(`Found ${headings.length} headings, minimum required: ${options.minHeadings}`);
  }

  // Max heading level
  if (options.maxHeadingLevel !== undefined) {
    const maxLevel = options.maxHeadingLevel;
    const deepHeadings = headings.filter((h) => h.level > maxLevel);
    if (deepHeadings.length > 0) {
      errors.push(
        `Found headings deeper than level ${options.maxHeadingLevel}: ${deepHeadings.map((h) => `"${h.text}" (h${h.level}, line ${h.line})`).join(', ')}`,
      );
    }
  }

  // Required sections
  if (options.requiredSections) {
    const headingTexts = headings.map((h) => (options.caseSensitive ? h.text : h.text.toLowerCase()));
    for (const section of options.requiredSections) {
      const needle = options.caseSensitive ? section : section.toLowerCase();
      if (!headingTexts.includes(needle)) {
        errors.push(`Missing required section: "${section}"`);
      }
    }
  }

  // Heading hierarchy
  if (options.requireHierarchy && headings.length > 0) {
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1] as MarkdownHeading;
      const curr = headings[i] as MarkdownHeading;
      // A heading can be same level, go deeper by 1, or go back to any higher level
      if (curr.level > prev.level + 1) {
        errors.push(
          `Heading hierarchy violated: "${curr.text}" (h${curr.level}, line ${curr.line}) skips from h${prev.level} to h${curr.level}`,
        );
      }
    }
  }

  // Code blocks
  if (options.minCodeBlocks !== undefined && codeBlocks.length < options.minCodeBlocks) {
    errors.push(`Found ${codeBlocks.length} code blocks, minimum required: ${options.minCodeBlocks}`);
  }

  // Required code languages
  if (options.requiredCodeLanguages) {
    const foundLangs = new Set(codeBlocks.map((b) => b.language.toLowerCase()));
    for (const lang of options.requiredCodeLanguages) {
      if (!foundLangs.has(lang.toLowerCase())) {
        errors.push(`Missing code block with language: "${lang}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    headings,
    codeBlocks,
    errors,
    lineCount,
  };
}
