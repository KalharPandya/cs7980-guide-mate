/**
 * The two copies of floor-14.json (world/data/floor-14.json, the server's source of truth,
 * and world-client/public/data/floor-14.json, the copy actually shipped to the browser and
 * fetched at runtime by useFloorPlan.ts) are kept in sync ONLY by convention -- there is no
 * build step or symlink that guarantees it. floor-14.json was re-traced roughly eight times
 * in a single day during real map work; a copy that falls out of sync means the client
 * silently renders a stale map while the server navigates/validates against a different one
 * (wrong door positions, wrong wall counts, agents walking through what the client draws as
 * a solid wall or vice versa). This test is the automated version of that byte-for-byte
 * comparison.
 *
 * Plain node:assert script, run with tsx -- matches world/'s test convention (see e.g.
 * world/src/nav/__tests__/loadFloorPlan.test.ts). No test framework dependency added.
 *
 * Run with: npx tsx src/scene/__tests__/floorPlanSync.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORLD_SERVER_PATH = fileURLToPath(
  new URL('../../../../world/data/floor-14.json', import.meta.url),
)
const WORLD_CLIENT_PATH = fileURLToPath(
  new URL('../../../public/data/floor-14.json', import.meta.url),
)

function firstDiffOffset(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i
  }
  return len // one buffer is a strict prefix of the other
}

function testFilesAreByteIdentical(): void {
  const serverBuf = readFileSync(WORLD_SERVER_PATH)
  const clientBuf = readFileSync(WORLD_CLIENT_PATH)

  if (!serverBuf.equals(clientBuf)) {
    const offset = firstDiffOffset(serverBuf, clientBuf)
    const context = 40
    const serverSnippet = serverBuf
      .subarray(Math.max(0, offset - context), offset + context)
      .toString('utf-8')
    const clientSnippet = clientBuf
      .subarray(Math.max(0, offset - context), offset + context)
      .toString('utf-8')
    assert.fail(
      `world/data/floor-14.json (${serverBuf.length} bytes) and ` +
        `world-client/public/data/floor-14.json (${clientBuf.length} bytes) diverge at byte ` +
        `offset ${offset}.\n  server : ...${serverSnippet}...\n  client : ...${clientSnippet}...\n` +
        'These two copies must be kept byte-identical by hand (there is no build step that ' +
        'syncs them) -- copy the server copy over the client copy (or vice versa, whichever ' +
        'is authoritative) to fix this.',
    )
  }
  console.log(
    `PASS: world/data/floor-14.json and world-client/public/data/floor-14.json are byte-identical ` +
      `(${serverBuf.length} bytes)`,
  )
}

function main(): void {
  testFilesAreByteIdentical()
  console.log('ALL PASS: floorPlanSync.test.ts')
}

try {
  main()
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err)
  process.exit(1)
}
