import type { FileInput } from './engine/host';

/** Files from <input type=file> (with or without webkitdirectory). */
export function filesFromInput(list: FileList | null): FileInput[] {
  return [...(list ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: FileInput[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches; keep reading until it's empty.
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Files (and whole folders) from a drag-and-drop. */
export async function filesFromDrop(dt: DataTransfer): Promise<FileInput[]> {
  const entries: FileSystemEntry[] = [];
  const loose: FileInput[] = [];
  // Entries must be collected synchronously, before the first await.
  for (const item of dt.items ?? []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push({ file: f, path: f.name });
    }
  }
  if (!entries.length && !loose.length) return filesFromInput(dt.files);
  const out: FileInput[] = [...loose];
  for (const e of entries) await walk(e, '', out);
  return out;
}
