// Minimal implementation of ali-oss `signatureUrlV4` behavior (presigned URL v4)
// - standalone, no SDK usage
// - export: async function signatureUrlV4(opts) -> signedUrl
// - opts: { accessKeyId, accessKeySecret, region, bucket, object, method, expires, headers, queries, endpoint, additionalHeaders, securityToken }
// A very small subset of features to generate OSS4-HMAC-SHA256 presigned URLs.

const crypto = require('crypto');

function encodeString(str) {
  const s = String(str === undefined || str === null ? '' : str);
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatDateUTC(date) {
  // returns YYYYMMDD'T'HHMMss'Z' and YYYYMMDD
  const pad = n => (n < 10 ? '0' + n : '' + n);
  const Y = date.getUTCFullYear();
  const M = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const dateStamp = `${Y}${M}${D}`;
  const timeStamp = `${dateStamp}T${hh}${mm}${ss}Z`;
  return { timeStamp, dateStamp };
}

function getProduct() {
  return 'oss';
}

function getSignRegion(region) {
  if (!region) return region;
  return String(region).replace(/^oss-/, '');
}

function fixAdditionalHeaders(additionalHeaders) {
  if (!additionalHeaders) return [];
  const set = new Set(additionalHeaders.map(v => String(v).toLowerCase()));
  // remove content-type/content-md5 and x-oss-* prefixes
  return [...set].filter(v => v !== 'content-type' && v !== 'content-md5' && !v.startsWith('x-oss-')).sort();
}

function getCredential(date, region, accessKeyId, product) {
  const temp = `${date}/${region}/${product}/aliyun_v4_request`;
  return accessKeyId ? `${accessKeyId}/${temp}` : temp;
}

function buildCanonicalQueryString(queries) {
  const keys = Object.keys(queries || {}).sort();
  return keys
    .map(k => {
      const v = queries[k];
      if (v === null || v === undefined) return encodeString(k);
      return `${encodeString(k)}=${encodeString(v)}`;
    })
    .join('&');
}

function lowercaseKeyHeader(headers) {
  const out = {};
  if (!headers) return out;
  Object.keys(headers).forEach(k => {
    out[k.toLowerCase()] = headers[k];
  });
  return out;
}

function getCanonicalRequest(method, request, bucketName, objectName, additionalHeaders) {
  const headers = lowercaseKeyHeader(request.headers || {});
  const queries = request.queries || {};
  if (objectName && !bucketName) throw new Error('bucketName required when objectName provided');

  // Canonical URI
  const canonicalURI = '/' + (bucketName ? `${bucketName}/` : '') + (objectName || '');
  const encodedURI = encodeString(canonicalURI).replace(/%2F/g, '/');

  // Canonical Query String
  const canonicalQS = buildCanonicalQueryString(queries);

  // Collect canonical headers to sign
  const OSS_PREFIX = 'x-oss-';
  const tempHeaders = new Set(additionalHeaders || []);

  Object.keys(headers).forEach(k => {
    if (k === 'content-type' || k === 'content-md5' || k.startsWith(OSS_PREFIX)) tempHeaders.add(k);
  });

  const canonicalHeaders = [...tempHeaders]
    .sort()
    .map(k => `${k}:${(typeof headers[k] === 'string' ? headers[k].trim() : headers[k])}\n`)
    .join('');

  const additionalHeaderNames = additionalHeaders && additionalHeaders.length ? additionalHeaders.join(';') : '';

  const payloadHash = headers['x-oss-content-sha256'] || 'UNSIGNED-PAYLOAD';

  const parts = [method.toUpperCase(), encodedURI, canonicalQS, canonicalHeaders, additionalHeaderNames, payloadHash];
  return parts.join('\n');
}

function getStringToSign(region, dateTime, canonicalRequest, product) {
  const productName = product || getProduct();
  const scope = `${dateTime.split('T')[0]}/${region}/${productName}/aliyun_v4_request`;
  const hashed = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  return ['OSS4-HMAC-SHA256', dateTime, scope, hashed].join('\n');
}

function getSignatureV4(accessKeySecret, date, region, stringToSign, product) {
  const kDate = crypto.createHmac('sha256', `aliyun_v4${accessKeySecret}`).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(product).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aliyun_v4_request').digest();
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

function buildEndpoint(opts) {
  if (opts.endpoint) return opts.endpoint.replace(/\/$/, '');
  // default endpoint pattern
  if (!opts.bucket || !opts.region) throw new Error('bucket and region or endpoint required');
  return `https://${opts.bucket}.${opts.region}.aliyuncs.com`;
}

async function signatureUrlV4(opts) {
  const {
    accessKeyId,
    accessKeySecret,
    region,
    bucket,
    object,
    method = 'GET',
    expires = 60,
    headers = {},
    queries = {},
    endpoint,
    additionalHeaders = [],
    securityToken
  } = opts;

  const product = getProduct();
  const signRegion = getSignRegion(region);
  const date = new Date();
  const { timeStamp, dateStamp } = formatDateUTC(date);

  const fixedAdditional = fixAdditionalHeaders(additionalHeaders);
  const q = Object.assign({}, queries);
  if (fixedAdditional.length > 0) q['x-oss-additional-headers'] = fixedAdditional.join(';');
  q['x-oss-credential'] = getCredential(dateStamp, signRegion, accessKeyId, product);
  q['x-oss-date'] = timeStamp;
  q['x-oss-expires'] = expires;
  q['x-oss-signature-version'] = 'OSS4-HMAC-SHA256';
  if (securityToken) q['x-oss-security-token'] = securityToken;

  const canonicalRequest = getCanonicalRequest(method, { headers, queries: q }, bucket, object, fixedAdditional);
  const stringToSign = getStringToSign(signRegion, timeStamp, canonicalRequest, product);
  q['x-oss-signature'] = getSignatureV4(accessKeySecret, dateStamp, signRegion, stringToSign, product);

  // build final url
  const base = buildEndpoint({ endpoint, bucket, region });
  // ensure object path is encoded properly and appended
  const objectPath = object ? '/' + encodeURIComponent(object).replace(/%2F/g, '/') : '';
  const qs = Object.keys(q)
    .map(k => `${encodeString(k)}=${encodeString(q[k])}`)
    .join('&');

  return `${base}${objectPath}${qs ? '?' + qs : ''}`;
}

module.exports = signatureUrlV4;

if (require.main === module) {
  // quick example: set env vars ACCESS_KEY_ID, ACCESS_KEY_SECRET, BUCKET, OBJECT, REGION
  (async () => {
    const ACCESS_KEY_ID = process.env.ACCESS_KEY_ID;
    const ACCESS_KEY_SECRET = process.env.ACCESS_KEY_SECRET;
    const BUCKET = process.env.BUCKET;
    const OBJECT = process.env.OBJECT || 'test.txt';
    const REGION = process.env.REGION || 'oss-cn-hangzhou';

    if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET || !BUCKET) {
      console.error('Please set ACCESS_KEY_ID, ACCESS_KEY_SECRET and BUCKET in environment to run the example.');
      process.exit(1);
    }

    try {
      const url = await signatureUrlV4({
        accessKeyId: ACCESS_KEY_ID,
        accessKeySecret: ACCESS_KEY_SECRET,
        region: REGION,
        bucket: BUCKET,
        object: OBJECT,
        method: 'GET',
        expires: 60
      });
      console.log(url);
    } catch (err) {
      console.error(err);
      process.exit(2);
    }
  })();
}

export async function onRequest(context) {
    const { request } = context || {};

    // Attempt to parse JSON body (if any). Ignore errors and fall back to query params.
    let body = null;
    try {
        body = await request.json();
    } catch (e) {
        body = null;
    }

    const url = new URL(request.url);
    const queryParams = Object.fromEntries(url.searchParams.entries());

    const getParam = (key) => {
        if (body && Object.prototype.hasOwnProperty.call(body, key)) return body[key];
        if (Object.prototype.hasOwnProperty.call(queryParams, key)) return queryParams[key];
        return undefined;
    };

    // Collect options: either as a full object or as individual fields
    let options = getParam('options') || {};
    if (typeof options === 'string') {
        try {
            options = JSON.parse(options);
        } catch (e) {
            options = {};
        }
    }

    // Allow supplying some option fields at the top level (convenience)
    ['accessKeyId', 'accessKeySecret', 'region', 'bucket', 'endpoint', 'stsToken', 'cloudBoxId'].forEach((k) => {
        const v = getParam(k);
        if (v !== undefined) options[k] = v;
    });

    const method = (getParam('method') || 'GET').toString().toUpperCase();
    const expiresRaw = getParam('expires');
    const expires = expiresRaw !== undefined ? parseInt(expiresRaw, 10) : 3600;
    const objectName = getParam('objectName') || getParam('object') || getParam('key');
    let additionalHeaders = getParam('additionalHeaders') || getParam('additional_headers');
    if (typeof additionalHeaders === 'string') {
        try { additionalHeaders = JSON.parse(additionalHeaders); } catch (e) { /* keep string */ }
    }

    // request payload for canonicalization (optional)
    let requestParts = getParam('request') || {};
    if (typeof requestParts === 'string') {
        try { requestParts = JSON.parse(requestParts); } catch (e) { requestParts = {}; }
    }

    // Prefer credentials from Cloudflare Pages Secrets (context.env). Do not depend on Node's process.env.
    const env = (context && context.env) || {};
    const getEnvVal = (names) => {
        for (const n of names) {
            if (env && typeof env[n] !== 'undefined' && env[n] !== null) return env[n];
        }
        return undefined;
    };

    options = options || {};
    // Common env var names used for convenience. Adjust names in your Pages project secrets as needed.
    options.accessKeyId = options.accessKeyId || getEnvVal(['OSS_ACCESS_KEY_ID', 'ACCESS_KEY_ID', 'ACCESSKEYID']);
    options.accessKeySecret = options.accessKeySecret || getEnvVal(['OSS_ACCESS_KEY_SECRET', 'ACCESS_KEY_SECRET', 'ACCESSSECRET']);
    options.bucket = options.bucket || getEnvVal(['OSS_BUCKET', 'BUCKET']);
    options.region = options.region || getEnvVal(['OSS_REGION', 'REGION']);
    options.endpoint = options.endpoint || getEnvVal(['OSS_ENDPOINT', 'ENDPOINT']);
    options.stsToken = options.stsToken || getEnvVal(['OSS_STS_TOKEN', 'STS_TOKEN']);
    options.cloudBoxId = options.cloudBoxId || getEnvVal(['OSS_CLOUDBOX_ID', 'CLOUD_BOX_ID', 'CLOUDBOXID']);

    // Basic validation
    if (!options || !options.accessKeyId || !options.accessKeySecret || !options.bucket) {
        return new Response(
            JSON.stringify({ error: 'Missing required option(s). Required: accessKeyId, accessKeySecret, bucket (or set them in environment/secrets)' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    try {
        const signedUrl = await signatureUrlV4(options, method, expires, requestParts, objectName, additionalHeaders);
        return new Response(JSON.stringify({ url: signedUrl }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
