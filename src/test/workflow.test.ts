import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const files = ['workflows/ltxv-t2v.json', 'workflows/ltxv-image-to-video.json']

function load(file: string, image = false): Record<string, any> {
  let text = readFileSync(file, 'utf8')
  const values: Record<string, string> = {
    prompt: 'a fox', negative: '', baseWidth: '768', baseHeight: '512',
    outWidth: '1280', outHeight: '720', frames: '121', fps: '30', seed: '1', image: 'x.png', video: 'source.mp4', denoise: '0.6', upscaler: '2xNomosUni_span_multijpg.safetensors', perBatch: '8',
  }
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  const graph = JSON.parse(text) as Record<string, any>
  return graph
}

test('LTXV workflow has the expected sampler, decoder and upscaler chain', () => {
  const graph = load(files[0]!)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  for (const name of ['CheckpointLoaderSimple', 'CLIPLoader', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'KSamplerSelect', 'LTXVScheduler', 'CFGGuider', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecodeTiled', 'SaveWEBM']) {
    assert.ok(classes.includes(name), `${name} missing`)
  }
  assert.ok(JSON.stringify(graph).includes('ltxv-2b-0.9.8-distilled'))
  assert.ok(JSON.stringify(graph).includes('t5xxl_fp8_e4m3fn'))
})

test('image workflow uses LTXVImgToVideo and LoadImage', () => {
  const graph = load(files[1]!, true)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  assert.ok(classes.includes('LoadImage'))
  assert.ok(classes.includes('LTXVImgToVideo'))
})

test('V2V workflow encodes the video and trims sigmas', () => {
  const graph = load('workflows/ltxv-video-to-video.json', true)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  for (const name of ['LoadVideo', 'GetVideoComponents', 'ImageFromBatch', 'VAEEncodeTiled', 'SplitSigmasDenoise', 'SamplerCustom', 'SaveWEBM']) {
    assert.ok(classes.includes(name), `${name} missing`)
  }
  assert.ok(readFileSync('workflows/ltxv-video-to-video.json', 'utf8').includes('{{denoise}}'))
})

test('separate upscale workflow uses KJNodes batched upscaler', () => {
  const graph = load('workflows/ltxv-upscale.json', true)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  for (const name of ['LoadVideo', 'GetVideoComponents', 'UpscaleModelLoader', 'ImageUpscaleWithModelBatched', 'ImageScale', 'ImageSharpen', 'SaveWEBM']) {
    assert.ok(classes.includes(name), `${name} missing`)
  }
  assert.ok(readFileSync('workflows/ltxv-upscale.json', 'utf8').includes('{{perBatch}}'))
})
