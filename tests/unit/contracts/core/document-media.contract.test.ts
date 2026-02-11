import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Document } from '../../../../src/core/media/document.ts';
import { Image } from '../../../../src/core/media/Image.ts';

const PDF_PATH = join(import.meta.dir, '../../../assets/helloworld.pdf');

describe('Document and image media contracts', () => {
  test('Document.fromPath loads bytes and round-trips via block serialization', async () => {
    const document = await Document.fromPath(PDF_PATH, 'hello');
    const block = document.toBlock();
    const restored = Document.fromBlock(block);

    expect(document.mimeType).toBe('application/pdf');
    expect(document.hasData).toBe(true);
    expect(block.title).toBe('hello');
    expect(restored.toBase64()).toBe(document.toBase64());
  });

  test('Document validates URL protocol and text conversion behavior', () => {
    expect(() => Document.fromUrl('ftp://example.com/report.pdf')).toThrow('http or https');

    const textDocument = Document.fromText('notes');
    expect(textDocument.isText).toBe(true);
    expect(textDocument.toText()).toBe('notes');
    expect(() => textDocument.toBase64()).toThrow('Only base64-sourced documents');
  });

  test('Document.fromPath rejects empty files', async () => {
    const path = join(tmpdir(), `upp-empty-${crypto.randomUUID()}.txt`);
    await Bun.write(path, '');

    await expect(Document.fromPath(path)).rejects.toThrow('Document file is empty');
    await Bun.file(path).unlink();
  });

  test('Image bytes/base64 conversions are lossless', () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const imageFromBytes = Image.fromBytes(bytes, 'image/png');
    const imageFromBase64 = Image.fromBase64(imageFromBytes.toBase64(), 'image/png');

    expect(Array.from(imageFromBase64.toBytes())).toEqual(Array.from(bytes));
    expect(imageFromBase64.toDataUrl()).toMatch(/^data:image\/png;base64,/);
  });

  test('Image URL source keeps URL behavior and detected mime type', () => {
    const image = Image.fromUrl('https://example.com/icon.webp');

    expect(image.hasData).toBe(false);
    expect(image.mimeType).toBe('image/webp');
    expect(image.toUrl()).toBe('https://example.com/icon.webp');
    expect(() => image.toBytes()).toThrow('Cannot get bytes from URL image');
  });
});
