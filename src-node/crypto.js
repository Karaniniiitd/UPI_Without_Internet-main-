import crypto from 'crypto';

class ServerKeyHolder {
  constructor() {
    this.regenerate();
  }

  regenerate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }
}

export const serverKey = new ServerKeyHolder();

const RSA_PADDING = crypto.constants.RSA_PKCS1_OAEP_PADDING;
const OAEP_HASH = 'sha256';
const AES_KEY_SIZE = 32; // 256 bits
const GCM_IV_SIZE = 12; // 96 bits
const GCM_TAG_SIZE = 16; // 128 bits
const RSA_KEY_SIZE_BYTES = 256; // 2048 bits RSA encrypted output size

/**
 * Encrypts a payment instruction JSON object using hybrid cryptography:
 * 1. Generate a single-use AES-256 key.
 * 2. Encrypt JSON with AES-256-GCM.
 * 3. Encrypt the AES key with the server's RSA-2048 public key (OAEP/SHA-256).
 * 4. Combine: [256-byte RSA key][12-byte IV][ciphertext][16-byte GCM tag]
 */
export function encrypt(instruction, publicKeyPem) {
  const plaintext = JSON.stringify(instruction);

  // 1. Generate one-time AES key
  const aesKey = crypto.randomBytes(AES_KEY_SIZE);

  // 2. Encrypt plaintext with AES-GCM
  const iv = crypto.randomBytes(GCM_IV_SIZE);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  let ciphertext = cipher.update(plaintext, 'utf8');
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const tag = cipher.getAuthTag();

  // 3. Encrypt AES key with RSA-OAEP
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: RSA_PADDING,
      oaepHash: OAEP_HASH
    },
    aesKey
  );

  // 4. Pack together
  const packed = Buffer.concat([encryptedAesKey, iv, ciphertext, tag]);
  return packed.toString('base64');
}

/**
 * Decrypts a base64-encoded packet using the server's private RSA key.
 */
export function decrypt(base64Ciphertext, privateKeyPem) {
  const all = Buffer.from(base64Ciphertext, 'base64');

  if (all.length < RSA_KEY_SIZE_BYTES + GCM_IV_SIZE + GCM_TAG_SIZE) {
    throw new Error('Ciphertext too short');
  }

  // Unpack
  const encryptedAesKey = all.subarray(0, RSA_KEY_SIZE_BYTES);
  const iv = all.subarray(RSA_KEY_SIZE_BYTES, RSA_KEY_SIZE_BYTES + GCM_IV_SIZE);
  const aesCiphertextAndTag = all.subarray(RSA_KEY_SIZE_BYTES + GCM_IV_SIZE);
  const aesCiphertext = aesCiphertextAndTag.subarray(0, aesCiphertextAndTag.length - GCM_TAG_SIZE);
  const tag = aesCiphertextAndTag.subarray(aesCiphertextAndTag.length - GCM_TAG_SIZE);

  // 1. Decrypt AES key with server's RSA private key
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: RSA_PADDING,
      oaepHash: OAEP_HASH
    },
    encryptedAesKey
  );

  // 2. Decrypt ciphertext with AES-GCM and verify tag
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(aesCiphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Calculates SHA-256 hash of the ciphertext string.
 */
export function hashCiphertext(base64Ciphertext) {
  return crypto.createHash('sha256').update(base64Ciphertext).digest('hex');
}
