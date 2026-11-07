import {build} from 'esbuild'
import {readFile,writeFile} from 'node:fs/promises'

// The converter's umbrella entry also exports an archive loader. Bundle and
// tree-shake its browser graph so importing our pure entry never initializes
// fflate's Node worker bridge or any other optional host capability.
await build({entryPoints:['src/index.ts'],outfile:'dist/index.js',bundle:true,
  platform:'browser',format:'esm',target:'es2023',
  mainFields:['module','main'],define:{process:'undefined'},
  external:['circuit-json','zod','earcut'],
})
// The "./node" export is dist/adapters/index.js. Keep the historical dist/node.js path working for
// consumers that import the file directly.
await writeFile('dist/node.js',"export * from './adapters/index.js'\n")
await writeFile('dist/node.d.ts',"export * from './adapters/index.js'\n")
// Retain the bundled clipping dependency's copyright and license notice.
await writeFile('dist/clipper2-LICENSE.txt','Clipper2: Copyright Angus Johnson 2010-2025. TypeScript port: Jeremy Tribby.\n\n'+await readFile('node_modules/clipper2-ts/LICENSE','utf8'))
