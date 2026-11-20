import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const files = ['workflows/wan22-t2v.json', 'workflows/wan22-i2v.json', 'workflows/wan22-v2v.json']

function load(file: string): Record<string, any> {
  let text = readFileSync(file, 'utf8')
  const values: Record<string, string> = {
    unet: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
    clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: 'wan2.2_vae.safetensors',
    prompt: 'a fox', negative: '', baseWidth: '864', baseHeight: '480',
    frames: '97', fps: '24', seed: '1', image: 'x.png', video: 'source.mp4',
    steps: '20', guidance: '5',
  }
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, value)
  return JSON.parse(text) as Record<string, any>
}

test('Wan T2V uses the 48-channel Wan latent without upscaler nodes', () => {
  const graph = load(files[0]!)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  for (const name of ['UnetLoaderGGUF', 'CLIPLoader', 'VAELoader', 'ModelSamplingSD3', 'Wan22ImageToVideoLatent', 'KSampler', 'VAEDecode', 'SaveWEBM']) {
    assert.ok(classes.includes(name), `${name} missing`)
  }
  assert.equal(graph['7'].inputs.width, 864)
  assert.equal(graph['7'].inputs.height, 480)
  assert.equal(graph['7'].inputs.length, 97)
  assert.ok(!graph['7'].inputs.start_image)
  assert.ok(!classes.includes('EmptyHunyuanLatentVideo'))
  assert.ok(!classes.includes('UpscaleModelLoader'))
  assert.ok(!classes.includes('ImageUpscaleWithModelBatched'))
})

test('Wan I2V starts from a reference image', () => {
  const graph = load(files[1]!)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  assert.ok(classes.includes('LoadImage'))
  assert.deepEqual(graph['8'].inputs.start_image, ['7', 0])
})

test('Wan V2V is keyframe-guided, not a true V2V claim', () => {
  const graph = load(files[2]!)
  const classes = Object.values(graph).map((node: any) => node.class_type)
  for (const name of ['LoadVideo', 'GetVideoComponents', 'ImageFromBatch', 'Wan22ImageToVideoLatent', 'SaveWEBM']) {
    assert.ok(classes.includes(name), `${name} missing`)
  }
  assert.deepEqual(graph['10'].inputs.start_image, ['9', 0])
})
