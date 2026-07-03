import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } from './config.js';

const isConfigured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME;

const s3 = isConfigured
  ? new S3Client({
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      region: 'auto',
    })
  : null;

function ensureR2() {
  if (!s3) throw new Error('R2_NOT_CONFIGURED');
}

export async function getPresignedUploadUrl(key, mime) {
  ensureR2();
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: mime,
  });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

export async function uploadToR2(key, body, mime) {
  ensureR2();
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: mime,
  });
  await s3.send(command);
}

export async function existsInR2(key) {
  ensureR2();
  try {
    const command = new HeadObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });
    await s3.send(command);
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export async function getFromR2Stream(key) {
  ensureR2();
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  const res = await s3.send(command);
  return res.Body; // ReadableStream
}

export async function deleteFromR2(key) {
  ensureR2();
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  await s3.send(command);
}
