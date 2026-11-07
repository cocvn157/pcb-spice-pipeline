// Source imports are extensionless (`from '../board'`). Node's ESM loader and NodeNext type
// resolution need full paths, so after `tsc` rewrite every relative specifier in dist/ to
// `./x.js` or `./x/index.js` (and the same in .d.ts files).
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const SPEC = /((?:from|import)\s*\(?\s*)(['"])(\.\.?(?:\/[^'"\n]*)?)\2/g
for (const file of walk('dist').filter(f => /\.(?:js|d\.ts)$/.test(f))) {
  const src = readFileSync(file, 'utf8')
  const out = src.replace(SPEC, (all, pre, q, spec) => {
    if (/\.(?:[cm]?js|json|css|svg|txt)$/.test(spec)) return all
    const abs = resolve(dirname(file), spec)
    const full = existsSync(abs + '.js') ? spec + '.js'
      : existsSync(join(abs, 'index.js')) ? spec.replace(/\/?$/, '/index.js')
      : null
    if (!full) throw new Error(`${file}: cannot resolve '${spec}'`)
    return `${pre}${q}${full}${q}`
  })
  if (out !== src) writeFileSync(file, out)
}
