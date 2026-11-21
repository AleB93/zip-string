/**
 * zip-string — pack JSON data into the shortest URL-safe string.
 */

/** Where the string will live in the URL. */
export type Target =
  /** After `#`. 77-character alphabet, ~4% shorter. Not safe inside `?query`. */
  | "hash"
  /** base64url (`A–Z a–z 0–9 - _`). Safe anywhere, including `?a=b&c=d`. */
  | "query";

export interface EncodeOptions {
  /** Default `"hash"`. */
  target?: Target;
  /** A dictionary from {@link createDictionary}. Pass the same one to {@link decode}. */
  dictionary?: Uint8Array;
  /** Deflate level 0–9. `0` skips compression. Default `6`. */
  level?: number;
  /**
   * Use Node's built-in zlib when available (faster). Default `true`.
   * Ignored in browsers, which always use fflate. Output is compatible either way.
   */
  native?: boolean;
}

export interface DecodeOptions {
  /** Required if the string was encoded with a dictionary. */
  dictionary?: Uint8Array;
  /** Use Node's built-in zlib when available. Default `true`. */
  native?: boolean;
}

/**
 * Encode any JSON-compatible value into a URL-safe string.
 *
 * Follows `JSON.stringify` semantics (`toJSON()` is called, `undefined` and functions
 * are dropped), except that `NaN` and `±Infinity` are preserved and `-0` becomes `0`.
 * @throws {TypeError} on `BigInt`.
 */
export function encode(data: unknown, options?: EncodeOptions): string;

/**
 * Decode a string produced by {@link encode}.
 * @throws {Error} on corrupt input, a missing dictionary, or the wrong dictionary.
 */
export function decode<T = unknown>(str: string, options?: DecodeOptions): T;

/**
 * Decode the current page's `#fragment` (browser). Returns `null` when the fragment is empty.
 */
export function decodeHash<T = unknown>(options?: DecodeOptions, location?: { hash: string }): T | null;

/**
 * Build a dictionary from sample data shaped like what you will encode.
 * Ship it with your app (it is not part of the URL) and pass it to both
 * `encode` and `decode`. Biggest wins on small payloads such as app state.
 */
export function createDictionary(...samples: unknown[]): Uint8Array;

/**
 * Enable or disable generated row-builder functions (`new Function`) used to
 * speed up decoding of tables. Disabled automatically under a CSP without
 * `'unsafe-eval'`; call `setCodegen(false)` to opt out explicitly.
 */
export function setCodegen(on: boolean): void;

/** The platform's CryptoKey type when available (DOM or @types/node), without requiring either. */
type CryptoKeyType = typeof globalThis extends { CryptoKey: { prototype: infer K } } ? K : never;

/** Exactly one of `password` or `key`. */
export type Secret =
  | { password: string; key?: never }
  | { key: string | Uint8Array | CryptoKeyType; password?: never };

export type EncryptOptions = Secret & EncodeOptions & {
  /** PBKDF2-SHA256 iterations for `password` (100,000–2,000,000). Default `600000`. */
  iterations?: number;
};

export type DecryptOptions = Secret & DecodeOptions & {
  /**
   * Refuse password links that ask for more PBKDF2 iterations than this, before doing
   * any work (1,000–2,000,000). Default `2000000`. Servers: set it to what you encrypt with.
   * Passing only `key` refuses password links outright, also without any work.
   */
  maxIterations?: number;
};

/**
 * Compress and encrypt with AES-256-GCM (Web Crypto). The result is a URL-safe string
 * that reveals nothing but its length, and fails to decrypt if any character is changed.
 *
 * - `password`: at least 8 characters; the key is derived with PBKDF2-SHA256 and a random salt.
 * - `key`: 32 random bytes, e.g. from {@link generateKey}.
 *
 * Needs a secure context in browsers (https or localhost) and Node ≥ 20.
 */
export function encrypt(data: unknown, options: EncryptOptions): Promise<string>;

/**
 * Decrypt a string made by {@link encrypt}.
 * Rejects on a wrong password or key, a missing dictionary, or any modification.
 */
export function decrypt<T = unknown>(str: string, options: DecryptOptions): Promise<T>;

/** A new random 256-bit key as a 43-character base64url string. Share it out of band. */
export function generateKey(): string;

/** True if `str` was produced by {@link encrypt}. */
export function isEncrypted(str: string): boolean;
