import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssetRef } from "./types.js";

export interface AssetWriteRequest {
  data: Uint8Array | AsyncIterable<Uint8Array>;
  mimeType?: string;
  name?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ResolvedAsset {
  asset: AssetRef;
  content: AsyncIterable<Uint8Array>;
}

/** Request-scoped media byte resolver supplied by the active channel or an asset store. */
export interface MediaResolver {
  resolve(asset: AssetRef): Promise<ResolvedAsset>;
}

export interface AssetStore extends MediaResolver {
  put(request: AssetWriteRequest): Promise<AssetRef>;
  resolve(asset: AssetRef): Promise<ResolvedAsset>;
  has(asset: AssetRef): Promise<boolean>;
}

export interface LocalAssetStoreOptions {
  directory: string;
  maxAssetBytes?: number;
}

/** Content-addressed local media storage. SQLite stores only returned AssetRef values. */
export class LocalAssetStore implements AssetStore {
  readonly #directory: string;
  readonly #maxAssetBytes: number;

  constructor(options: LocalAssetStoreOptions) {
    if (!options.directory.trim()) throw new Error("Asset store directory cannot be empty");
    this.#directory = resolve(options.directory);
    this.#maxAssetBytes = boundedBytes(options.maxAssetBytes ?? 512 * 1024 * 1024);
  }

  async put(request: AssetWriteRequest): Promise<AssetRef> {
    const temporaryDirectory = join(this.#directory, ".tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = join(temporaryDirectory, randomUUID());
    const file = await open(temporaryPath, "wx");
    const hash = createHash("sha256");
    let size = 0;

    try {
      for await (const chunk of chunks(request.data)) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Asset chunks must be Uint8Array values");
        size += chunk.byteLength;
        if (size > this.#maxAssetBytes) {
          throw new Error(`Asset exceeds the configured ${this.#maxAssetBytes} byte limit`);
        }
        hash.update(chunk);
        await writeAll(file, chunk);
      }
    } catch (error) {
      await file.close();
      await safeUnlink(temporaryPath);
      throw error;
    }
    await file.close();

    const sha256 = hash.digest("hex");
    const locator = join(sha256.slice(0, 2), sha256);
    const destination = join(this.#directory, locator);
    await mkdir(join(this.#directory, sha256.slice(0, 2)), { recursive: true });
    if (await pathExists(destination)) await safeUnlink(temporaryPath);
    else await rename(temporaryPath, destination);

    return {
      id: `asset:sha256:${sha256}`,
      source: "local",
      locator,
      size,
      sha256,
      ...(request.mimeType ? { mimeType: request.mimeType } : {}),
      ...(request.name ? { name: request.name } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  async resolve(asset: AssetRef): Promise<ResolvedAsset> {
    const path = this.#pathFor(asset);
    if (!(await pathExists(path))) throw new Error(`Local asset not found: ${asset.id}`);
    const stream = createReadStream(path);
    return { asset, content: stream as AsyncIterable<Uint8Array> };
  }

  async has(asset: AssetRef): Promise<boolean> {
    try {
      return await pathExists(this.#pathFor(asset));
    } catch {
      return false;
    }
  }

  #pathFor(asset: AssetRef): string {
    if (asset.source !== "local") throw new Error(`Asset ${asset.id} is not owned by a local asset store`);
    if (isAbsolute(asset.locator)) throw new Error("Local asset locator must be relative");
    const path = resolve(this.#directory, asset.locator);
    const pathRelative = relative(this.#directory, path);
    if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
      throw new Error("Local asset locator escapes the asset store");
    }
    return path;
  }
}

async function* chunks(data: AssetWriteRequest["data"]): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  for await (const chunk of data) yield chunk;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten === 0) throw new Error("Asset store could not make progress writing a file");
    offset += result.bytesWritten;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function boundedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxAssetBytes must be a positive safe integer");
  return value;
}
