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
