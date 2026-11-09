import { Injectable } from '@angular/core';
import { FilePort } from '../application/ports';
@Injectable()
export class BrowserFiles implements FilePort {
  download(name: string, content: string | Blob, type = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  read(file: File) {
    return file.text();
  }
  async readBase64(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // In chunks: spreading a large file into one call would exceed the argument limit.
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(binary);
  }
  id() {
    return crypto.randomUUID();
  }
}
