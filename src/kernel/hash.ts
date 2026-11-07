import { sha256 as digest } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/** Lowercase hex SHA-256 of UTF-8 text or bytes (@noble/hashes; pure, browser-safe). */
export function sha256(input: string | Uint8Array): string { return bytesToHex(digest(input)) }
