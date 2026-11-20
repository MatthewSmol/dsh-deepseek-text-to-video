import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installBundledWorkflows } from '../lib/workflows.js'

test('bundled Wan workflows install into an empty GenVideo home', () => {
  const previous = process.env.GENVIDEO_HOME
  const home = mkdtempSync(join(tmpdir(), 'genvideo-workflows-'))
  process.env.GENVIDEO_HOME = home
  try {
    const result = installBundledWorkflows()
    assert.equal(result.installed.length, 3)
    assert.ok(readFileSync(join(home, 'workflow.json'), 'utf8').includes('UnetLoaderGGUF'))
    assert.ok(readFileSync(join(home, 'workflow-image.json'), 'utf8').includes('Wan22ImageToVideoLatent'))
    assert.ok(readFileSync(join(home, 'workflow-video.json'), 'utf8').includes('LoadVideo'))
    const again = installBundledWorkflows()
    assert.equal(again.installed.length, 0)
  } finally {
    if (previous === undefined) delete process.env.GENVIDEO_HOME
    else process.env.GENVIDEO_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
