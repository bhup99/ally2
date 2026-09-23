/* Downscale a photo before storing it in IndexedDB so history stays small. */

const MAX_DIM = 800;
const JPEG_QUALITY = 0.7;

/**
 * @param {Blob|File} file - original photo
 * @returns {Promise<Blob>} downscaled JPEG (max dimension 800px, quality 0.7)
 */
export async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
        'image/jpeg',
        JPEG_QUALITY
      );
    });
  } finally {
    bitmap.close();
  }
}
