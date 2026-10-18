import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'

const keyVariables = ['OPENROUTER_API_KEY', 'FEATHERLESS_API_KEY', 'NEBIUS_API_KEY', 'TAVILY_API_KEY', 'ALIBABA_TOKEN_KEY', 'DASHSCOPE_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_TOKEN_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
const variables = keyVariables.flatMap(name => [name, `VITE_${name}`])
const sentinels = variables.map((name, index) => `vl-test-only-secret-sentinel-${index}-never-publish`)
variables.forEach((name, index) => { process.env[name] = sentinels[index] })
const output = await mkdtemp(join(tmpdir(), 'visual-language-secret-check-'))
try {
  await build({ logLevel: 'error', build: { outDir: output, emptyOutDir: true } })
  const files = await readdir(output, { recursive: true, withFileTypes: true })
  let checked = 0
  for (const file of files.filter(entry => entry.isFile())) {
    const content = await readFile(join(file.parentPath ?? file.path, file.name))
    if (sentinels.some(value => content.includes(value))) throw new Error('A test-only credential sentinel was found in a production artifact.')
    checked++
  }
  console.log(`Production secret-exclusion check passed (${checked} artifacts, ${variables.length} testing variables).`)
} finally {
  // This exact directory was created above solely for this generated-build check.
  await rm(output, { recursive: true, force: true })
}
