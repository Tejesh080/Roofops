/**
 * Documents (docs/master-plan.md Task 3.3): the README links only current documents, its document list stays short,
 * every relative link in the current documents resolves, and every evidence file is in the evidence index. Older
 * evidence files are records and are not checked: paths inside them may name documents since moved to docs/archive/.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
});
/** Relative link targets in a Markdown text, outside fenced code, without their #anchor. */
function relativeLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!.split('#')[0]!).filter((t) => t !== '' && !/^[a-z]+:/i.test(t));
}

describe('documents (master plan Task 3.3)', () => {
  it('finds relative links and skips URLs, anchors and code', () => {
    expect(relativeLinks('[a](docs/x.md) [b](https://x.y) [c](#top) [d](y.md#part)\n```\n[e](no.md)\n```')).toEqual(['docs/x.md', 'y.md']);
  });

  it('every relative link in the README, docs/, ops/ and the evidence index resolves', () => {
    const files = ['README.md', 'evidence/README.md', ...walk('docs'), ...walk('ops')];
    const broken = files.flatMap((f) => relativeLinks(readFileSync(f, 'utf8'))
      .filter((t) => !existsSync(resolve(dirname(f), decodeURIComponent(t))))
      .map((t) => `${f} -> ${t}`));
    expect(broken).toEqual([]);
  });

  it("the README's document list has fewer than 15 links, none of them archived", () => {
    const readme = readFileSync('README.md', 'utf8');
    const section = readme.slice(readme.indexOf('## 📚 Documentation'));
    const links = relativeLinks(section);
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThan(15);
    expect(relativeLinks(readme).filter((t) => t.startsWith('docs/archive/') && t !== 'docs/archive/')).toEqual([]);
  });

  it('every evidence file is in the evidence index', () => {
    const index = readFileSync('evidence/README.md', 'utf8');
    const missing = readdirSync('evidence').filter((f) => f !== 'README.md' && !index.includes(`(${f})`));
    expect(missing).toEqual([]);
  });
});
