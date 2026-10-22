export function validFile(bytes: Uint8Array, mime: string) {
  const text = new TextDecoder().decode(bytes.slice(0, 12));
  if (mime === 'application/pdf') return text.startsWith('%PDF-');
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (mime === 'image/webp') return text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.'))
    return text.startsWith('PK\u0003\u0004');
  if (['text/plain', 'text/markdown'].includes(mime)) return !bytes.slice(0, 10000).some((b) => b === 0);
  return false;
}
export function imageBase64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
