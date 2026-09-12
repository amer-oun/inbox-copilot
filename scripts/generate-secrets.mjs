#!/usr/bin/env node
// Generates the local development secrets Phase 1 needs and prints them as .env
// lines. Nothing is written to disk — pipe or paste what you want:
//
//   node scripts/generate-secrets.mjs >> .env
//
// Rotating TOKEN_ENCRYPTION_KEY means bumping TOKEN_ENCRYPTION_KEY_VERSION and
// keeping the old key readable until every MailAccount row has been re-encrypted.

import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const b64 = (value) => Buffer.from(value).toString("base64");

console.log(`TOKEN_ENCRYPTION_KEY="${randomBytes(32).toString("base64")}"`);
console.log(`TOKEN_ENCRYPTION_KEY_VERSION=1`);
console.log(`OAUTH_STATE_SECRET="${randomBytes(32).toString("base64")}"`);
console.log(`AUTH_SECRET="${randomBytes(32).toString("base64")}"`);
console.log(`INTERNAL_JWT_PRIVATE_KEY="${b64(privateKey)}"`);
console.log(`INTERNAL_JWT_PUBLIC_KEY="${b64(publicKey)}"`);
