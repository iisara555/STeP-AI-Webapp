import type { DocumentRecord, Visibility } from '../../packages/harness-core/src/contracts.ts';
import type { Host } from './host.ts';
import { extractText } from './extract.ts';
const mimeTypes: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function normalizeFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '',
    mime = mimeTypes[ext];
  if (!mime) throw new Error('FILE_UNSUPPORTED');
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}
export async function uploadFile(
  host: Host,
  tenant: string,
  workspace: string | null,
  visibility: Visibility,
  file: File,
  parent?: string,
) {
  const normalized = normalizeFile(file);
  const text = await extractText(normalized);
  const doc = await host.call<DocumentRecord>('document.create', {
    tenant,
    workspace,
    visibility,
    name: normalized.name,
    mime: normalized.type,
    bytes: normalized.size,
    parent,
  });
  if (!doc.object_path) throw new Error('UPLOAD_FAILED');
  try {
    await host.upload(doc.object_path, normalized);
    return await host.call<DocumentRecord>('document.commit', { tenant, id: doc.id, text });
  } catch (error) {
    await host.call('document.delete', { tenant, id: doc.id }).catch(() => {});
    throw error;
  }
}
export async function prepareReceipt(file: File, rotation = 0): Promise<{ file: File; warnings: string[] }> {
  if (!file.type.startsWith('image/')) return { file, warnings: [] };
  const worker = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
  const bytes = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('IMAGE_PROCESSING_TIMEOUT'));
    }, 20000);
    worker.onmessage = (event: MessageEvent<{ blob: Blob; warnings: string[]; error?: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else
        resolve({
          file: new File([event.data.blob], file.name.replace(/\.[^.]+$/, '') + '-prepared.jpg', {
            type: 'image/jpeg',
          }),
          warnings: event.data.warnings,
        });
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error('IMAGE_PROCESSING_FAILED'));
    };
    worker.postMessage({ bytes, mime: file.type, rotation }, [bytes]);
  });
}
