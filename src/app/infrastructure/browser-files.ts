import { Injectable } from '@angular/core';
import { FilePort } from '../application/ports';
@Injectable()
export class BrowserFiles implements FilePort {
  download(name: string, content: string, type = 'application/json') {
    const blob = new Blob([content], { type });
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
  id() {
    return crypto.randomUUID();
  }
}
