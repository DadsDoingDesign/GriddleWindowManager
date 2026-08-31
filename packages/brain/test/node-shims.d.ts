// packages/brain compiles with "types": [] to enforce the zero-DOM/zero-Node
// constraint on src/ (see fuzz.test.ts). Tests DO run under Node (vitest);
// the config-corpus eval reads shared fixture files from disk, so declare
// the minimal slice of node:fs / node:path it uses instead of pulling in
// @types/node for the whole package.

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

// `import.meta.url` — provided by every ESM runtime; the lib set chosen by
// "types": [] does not declare it.
interface ImportMeta {
  url: string;
}
