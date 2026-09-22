// Runs outside the HTTP thread; decoder output/errors never enter application logs.
const { parentPort, workerData } = require('node:worker_threads');
const { readFile, writeFile, stat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const sharp = require('sharp');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 60000000;
function checkSize(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS
  )
    throw new Error('PHOTO_PIXEL_LIMIT');
}
function identify(data) {
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return 'image/jpeg';
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
    const size = data.readUInt32BE(0);
    if (size >= 16 && size <= data.length && size <= 4096) {
      const brands = [data.toString('ascii', 8, 12)];
      for (let i = 16; i + 4 <= size; i += 4)
        brands.push(data.toString('ascii', i, i + 4));
      if (
        !brands.some((b) => ['avif', 'avis'].includes(b)) &&
        brands.some((b) =>
          ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b),
        )
      )
        return 'image/heif';
    }
  }
  throw new Error('UNSUPPORTED_PHOTO_TYPE');
}

(async () => {
  const input = await readFile(workerData.path);
  if (!input.length) throw new Error('INVALID_PHOTO');
  if (input.length > MAX_BYTES) throw new Error('PHOTO_TOO_LARGE');
  const contentType = identify(input);
  let pixels = input;
  if (contentType === 'image/heif') {
    const magick = require('@imagemagick/magick-wasm');
    await magick.initializeImageMagick(
      await readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm')),
    );
    magick.ResourceLimits.memory = 512n * 1024n * 1024n;
    magick.ResourceLimits.disk = 0n;
    magick.ResourceLimits.time = 25n;
    const settings = new magick.MagickReadSettings();
    settings.frameCount = 1;
    const info = magick.MagickImageInfo.create(input, settings);
    if (
      ![magick.MagickFormat.Heic, magick.MagickFormat.Heif].includes(
        info.format,
      )
    )
      throw new Error('UNSUPPORTED_PHOTO_TYPE');
    checkSize(info.width, info.height);
    // Preserve the source ICC profile through PNG; sharp then converts it to sRGB.
    pixels = magick.ImageMagick.read(input, settings, (image) => {
      image.autoOrient();
      const scale = Math.min(1, 4096 / Math.max(image.width, image.height));
      if (scale < 1)
        image.resize(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        );
      return image.write(magick.MagickFormat.Png, (data) => Buffer.from(data));
    });
  }
  const decoder = sharp(pixels, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'warning',
  });
  const metadata = await decoder.metadata();
  checkSize(metadata.width, metadata.height);
  if (!['jpeg', 'png'].includes(metadata.format))
    throw new Error('UNSUPPORTED_PHOTO_TYPE');
  const output = await decoder
    .autoOrient()
    .resize({
      width: 4096,
      height: 4096,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColourspace('srgb')
    .jpeg({ quality: 90 })
    .timeout({ seconds: 25 })
    .toBuffer();
  if (output.length > MAX_BYTES) throw new Error('PHOTO_TOO_LARGE');
  await writeFile(workerData.outputPath, output, { mode: 0o600 });
  parentPort.postMessage({
    ok: true,
    contentType,
    originalSize: (await stat(workerData.path)).size,
    size: output.length,
    hash: createHash('sha256').update(input).digest('hex'),
  });
})().catch((error) => {
  if (error.message.includes('Input image exceeds pixel limit'))
    error = new Error('PHOTO_PIXEL_LIMIT');
  const allowed = [
    'PHOTO_PIXEL_LIMIT',
    'PHOTO_TOO_LARGE',
    'UNSUPPORTED_PHOTO_TYPE',
  ];
  parentPort.postMessage({
    ok: false,
    code: allowed.includes(error.message) ? error.message : 'INVALID_PHOTO',
  });
});
