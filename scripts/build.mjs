import { build } from 'esbuild';

await build({
  entryPoints: ['src/identity.js'],
  bundle: true,
  format: 'esm',
  outfile: 'public/identity.js',
});
