declare const self: {
  onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer; mime: string; rotation: number }>) => void) | null;
  postMessage: (value: unknown) => void;
};
export {};
self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; mime: string; rotation: number }>) => {
  try {
    const { bytes, mime, rotation } = event.data;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
      imageOrientation: 'from-image',
    });
    if (bitmap.width * bitmap.height > 60000000) {
      bitmap.close();
      throw new Error('IMAGE_TOO_LARGE');
    }
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale),
      height = Math.round(bitmap.height * scale),
      quarter = Math.abs(rotation) % 180 === 90;
    const canvas = new OffscreenCanvas(quarter ? height : width, quarter ? width : height),
      ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('IMAGE_PROCESSING_UNAVAILABLE');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
    bitmap.close();
    const sample = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < sample.data.length; i += 16) {
      const value = Math.round((sample.data[i] + sample.data[i + 1] + sample.data[i + 2]) / 3);
      histogram[value]++;
    }
    let min = 0,
      max = 255;
    const population = histogram.reduce((a, b) => a + b, 0);
    let n = 0;
    for (let i = 0; i < 256; i++) {
      n += histogram[i];
      if (n > population * 0.01) {
        min = i;
        break;
      }
    }
    n = 0;
    for (let i = 255; i >= 0; i--) {
      n += histogram[i];
      if (n > population * 0.01) {
        max = i;
        break;
      }
    }
    // Gentle contrast expansion only for very flat images. Keep original colour,
    // preserve the source file, and do not automatically crop away faint marks.
    if (max - min < 100 && max - min > 20) {
      for (let i = 0; i < sample.data.length; i += 4)
        for (let channel = 0; channel < 3; channel++)
          sample.data[i + channel] = Math.max(
            0,
            Math.min(255, ((sample.data[i + channel] - min) * 220) / (max - min) + 15),
          );
      ctx.putImageData(sample, 0, 0);
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.94 });
    const warnings: string[] = [];
    if (Math.min(width, height) < 650) warnings.push('ภาพมีขนาดเล็ก หากตัวอักษรไม่ชัดควรถ่ายใหม่ให้ใกล้ขึ้น');
    if (max - min < 35) warnings.push('ภาพมีความต่างของสีต่ำ อาจอ่านตัวอักษรและลายเซ็นได้ไม่ครบ');
    self.postMessage({ blob, warnings, width: canvas.width, height: canvas.height });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : 'IMAGE_INVALID' });
  }
};
