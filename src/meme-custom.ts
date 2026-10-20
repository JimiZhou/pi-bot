import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface CustomMemeRecord {
  key: string;
  title: string;
  keywords: string[];
  mimeType: string;
  size: number;
  filename: string;
  createdAt: number;
  updatedAt: number;
}

export interface CustomMemeAsset extends CustomMemeRecord {
  bytes: Uint8Array;
}

export interface SaveCustomMemeInput {
  key: string;
  title?: string;
  keywords?: string[];
  bytes: Uint8Array;
  mimeType: string;
}

export function customMemeDirectory(): string {
  const configured = process.env.PI_MEME_CUSTOM_DIR?.trim();
  if (configured) return configured;
  const dataDirectory = process.env.PI_AGENT_DATA_DIR?.trim() || "./data";
  return join(dataDirectory, "meme-generator", "custom");
}

export async function listCustomMemes(): Promise<CustomMemeRecord[]> {
  const directory = customMemeDirectory();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileError(error, "ENOENT")) return [];
    throw error;
  }
  const records: CustomMemeRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readRecord(join(directory, entry.name));
    if (record) records.push(record);
  }
  return records.sort((left, right) => left.key.localeCompare(right.key));
}

export async function getCustomMeme(key: string): Promise<CustomMemeAsset | undefined> {
  if (!KEY_PATTERN.test(key)) return undefined;
  const directory = customMemeDirectory();
  const record = await readRecord(join(directory, `${key}.json`));
  if (!record) return undefined;
  try {
    const bytes = new Uint8Array(await readFile(join(directory, record.filename)));
    return { ...record, bytes };
  } catch (error) {
    if (isFileError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function saveCustomMeme(input: SaveCustomMemeInput): Promise<CustomMemeRecord> {
  const key = input.key.normalize("NFKC").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("自定义 meme key 只能包含字母、数字、下划线和短横线");
  const mimeType = input.mimeType.toLocaleLowerCase().trim();
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error("自定义 meme 只支持 JPEG、PNG、GIF 和 WebP");
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 16 || input.bytes.byteLength > DEFAULT_MAX_BYTES) {
    throw new Error("自定义 meme 图片必须在 16 B 到 20 MiB 之间");
  }
  const title = (input.title?.normalize("NFKC").trim() || key).slice(0, 120);
  const keywords = [...new Set((input.keywords ?? [])
    .map((keyword) => keyword.normalize("NFKC").trim().slice(0, 40))
    .filter(Boolean))].slice(0, 12);
  const directory = customMemeDirectory();
  await mkdir(directory, { recursive: true });
  const metadataPath = join(directory, `${key}.json`);
  const imageFilename = `${key}.${extension}`;
  const imagePath = join(directory, imageFilename);
  const previous = await readRecord(metadataPath);
  const now = Date.now();
  const record: CustomMemeRecord = {
    key,
    title,
    keywords,
    mimeType,
    size: input.bytes.byteLength,
    filename: imageFilename,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const imageTemp = join(directory, `.${key}.${randomUUID()}.image.tmp`);
  const metadataTemp = join(directory, `.${key}.${randomUUID()}.json.tmp`);
  try {
    await writeFile(imageTemp, input.bytes, { flag: "wx", mode: 0o640 });
    await rename(imageTemp, imagePath);
    await writeFile(metadataTemp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o640 });
    await rename(metadataTemp, metadataPath);
  } finally {
    await rm(imageTemp, { force: true });
    await rm(metadataTemp, { force: true });
  }
  if (previous && previous.filename !== imageFilename) {
    await rm(join(directory, previous.filename), { force: true });
  }
  return record;
}

export function customMemeInfo(record: CustomMemeRecord) {
  return {
    key: record.key,
    keywords: [record.title, ...record.keywords].filter(Boolean),
    minImages: 0,
    maxImages: 0,
    minTexts: 0,
    maxTexts: 0,
  };
}

async function readRecord(path: string): Promise<CustomMemeRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    const key = typeof value.key === "string" && KEY_PATTERN.test(value.key) ? value.key : undefined;
    const title = typeof value.title === "string" ? value.title : undefined;
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
    const extension = mimeType ? MIME_EXTENSIONS[mimeType] : undefined;
    const filename = typeof value.filename === "string" ? value.filename : undefined;
    const size = typeof value.size === "number" && Number.isSafeInteger(value.size) ? value.size : undefined;
    const createdAt = typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt) ? value.createdAt : undefined;
    const updatedAt = typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) ? value.updatedAt : undefined;
    if (!key || !title || !mimeType || !extension || filename !== `${key}.${extension}` ||
      size === undefined || size < 16 || size > DEFAULT_MAX_BYTES || createdAt === undefined || updatedAt === undefined) return undefined;
    const file = await stat(join(customMemeDirectory(), filename));
    if (!file.isFile() || file.size !== size) return undefined;
    return {
      key,
      title,
      keywords: Array.isArray(value.keywords) ? value.keywords.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
      mimeType,
      size,
      filename,
      createdAt,
      updatedAt,
    };
  } catch (error) {
    if (isFileError(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
