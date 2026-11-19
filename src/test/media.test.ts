/**
 * RU: Тесты медиа-математики и валидации: лимит размера, режимы, аргументы ffmpeg.
 * EN: Media math and validation tests: size limit, modes, ffmpeg arguments.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bitrateForSize,
  minSizeMB,
  normalizeTranscode,
  qualityArgs,
  sizeArgs,
  buildVideoFilters,
  canConcatDirectly,
  parseProbe,
  parseFps,
  type MediaInfo,
} from '../lib/media.js'

test('bitrateForSize reserves audio and applies the safety margin', () => {
  const kbps = bitrateForSize(10, 10, 128)
  assert.ok(kbps > 0)
  assert.ok(kbps < (10 * 8 * 1024) / 10)
  assert.equal(bitrateForSize(10, 10, 128), Math.round((10 * 8 * 1024 * 0.95) / 10 - 128))
})

test('normalizeTranscode validates width/height and gif+size', () => {
  assert.throws(() => normalizeTranscode({ width: 100, height: 0 }, 5), /Width and height/)
  assert.throws(() => normalizeTranscode({ mode: 'size', format: 'gif', targetSizeMB: 5 }, 5), /not supported for GIF/)
  assert.throws(() => normalizeTranscode({ mode: 'size', targetSizeMB: 0.01 }, 100), /below the minimum/)
  const quality = normalizeTranscode({ mode: 'quality', quality: 'high' }, 5)
  assert.equal(quality.mode, 'quality')
  assert.equal(quality.quality, 'high')
  const size = normalizeTranscode({ mode: 'size', targetSizeMB: 2 }, 5)
  assert.equal(size.mode, 'size')
  assert.ok((size.videoKbps ?? 0) > 0)
})

test('minSizeMB grows with duration', () => {
  assert.ok(minSizeMB(10) > minSizeMB(2))
})

test('qualityArgs uses H.264 and the selected preset', () => {
  const options = normalizeTranscode({ mode: 'quality', quality: 'compressed', format: 'mp4' }, 5)
  const args = qualityArgs(options)
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('veryfast'))
  assert.ok(args.includes('-crf'))
  const webm = qualityArgs(normalizeTranscode({ format: 'webm' }, 5))
  assert.ok(webm.includes('libvpx-vp9'))
  const gif = qualityArgs(normalizeTranscode({ format: 'gif' }, 5))
  assert.ok(gif.includes('-loop'))
})

test('sizeArgs produces two passes with a passlog', () => {
  const options = normalizeTranscode({ mode: 'size', targetSizeMB: 4, format: 'mp4' }, 8)
  const pass1 = sizeArgs(options, 1, '/tmp/pass')
  const pass2 = sizeArgs(options, 2, '/tmp/pass')
  assert.ok(pass1.includes('1') && pass1.includes('-f') && pass1.includes('null'))
  assert.ok(pass2.includes('2') && pass2.includes('aac'))
  assert.ok(pass1.includes('/tmp/pass'))
})

test('buildVideoFilters handles contain, cover and fps', () => {
  assert.deepEqual(buildVideoFilters({ width: 0, height: 0, fps: 30, fit: 'contain' }), ['fps=30'])
  const contain = buildVideoFilters({ width: 1080, height: 1920, fps: 0, fit: 'contain' })
  assert.ok(contain.some((filter) => filter.startsWith('scale=')))
  assert.ok(contain.some((filter) => filter.startsWith('pad=')))
  const cover = buildVideoFilters({ width: 1080, height: 1920, fps: 0, fit: 'cover' })
  assert.ok(cover.some((filter) => filter.startsWith('crop=')))
})

test('canConcatDirectly compares dimensions, fps and streams', () => {
  const base: MediaInfo = { path: 'a', bytes: 1, durationSec: 1, width: 640, height: 480, fps: 24, videoCodec: 'h264', audioCodec: null, formatName: 'mp4' }
  assert.equal(canConcatDirectly([base, { ...base, path: 'b' }]), true)
  assert.equal(canConcatDirectly([base, { ...base, width: 1280 }]), false)
  assert.equal(canConcatDirectly([base, { ...base, audioCodec: 'aac' }]), false)
})

test('parseProbe reads streams and durations', () => {
  const info = parseProbe(
    {
      format: { duration: '3.5', size: '1234', format_name: 'mov,mp4' },
      streams: [
        { codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '24000/1001', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    },
    'x.mp4',
  )
  assert.equal(info.width, 1280)
  assert.equal(info.height, 720)
  assert.equal(info.audioCodec, 'aac')
  assert.ok(Math.abs(info.durationSec - 3.5) < 0.001)
  assert.ok(Math.abs(info.fps - 23.976) < 0.01)
  assert.equal(parseFps('30'), 30)
})
